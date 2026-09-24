import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_AI_CONFIG } from '@sentinal/shared';
import { createClaudeReviewer } from '../engine/ai/claude.js';
import { boundSuggestion, type AiReviewClient, type ReviewInput, type ReviewSuggestion } from '../engine/ai/review.js';
import { AiSupervisor } from '../engine/ai/supervisor.js';
import { createRuntime } from '../runtime.js';

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeClient(answer: (input: ReviewInput) => ReviewSuggestion | Error) {
  const calls: { input: ReviewInput; model: string }[] = [];
  const client: AiReviewClient = {
    async review(input, model) {
      calls.push({ input, model });
      const a = answer(input);
      if (a instanceof Error) throw a;
      return { suggestion: a, model, inputTokens: 1200, outputTokens: 300 };
    },
  };
  return { client, calls };
}

function setup(answer: (input: ReviewInput) => ReviewSuggestion | Error, now = { t: Date.now() }) {
  const runtime = createRuntime({ seedPrice: 4300, tickIntervalMs: 1000, seed: 3, historyBars: 200 });
  runtime.accounts.add({ name: 'Master', login: '1', server: 'sim', role: 'master', initialBalance: 10_000, leverage: 1000 });
  const fake = fakeClient(answer);
  const supervisor = new AiSupervisor(runtime.bot, runtime.accounts, runtime.journal, { reviewer: () => fake.client, now: () => now.t });
  return { runtime, supervisor, ...fake, now };
}

describe('holding a review inside the operator’s limits', () => {
  it('never raises risk past the cap, never adds positions, never turns on volatile trading', () => {
    const current = { ...DEFAULT_AI_CONFIG, riskPercent: 1, maxRiskPercent: 1.5, maxPositions: 2, tradeVolatile: false };
    const b = boundSuggestion(
      { assessment: '', riskPercent: 9, maxPositions: 10, tradeVolatile: true, minProbability: 0.99, slAtr: 0.1, rrMin: 4, rrMax: 2 },
      current,
    );
    // rrMax 2 is lifted to the new rrMin (3), which is where it already was: no change to it.
    expect(b.config).toEqual({ riskPercent: 1.5, minProbability: 0.9, slAtr: 0.8, rrMin: 3 });
    expect(b.describe).toContain('risk per trade 1% → 1.5%');
    expect(b.describe).toContain('minimum probability 60% → 90%');
    const lower = boundSuggestion({ assessment: '', maxPositions: 1, tradeVolatile: false, pauseMinutes: 999 }, { ...current, tradeVolatile: true });
    expect(lower.config).toEqual({ maxPositions: 1, tradeVolatile: false });
    expect(lower.pauseMinutes).toBe(240);
    const bias = boundSuggestion({ assessment: '', expertBias: [{ expert: 'reversion', multiplier: 5 }, { expert: 'bogus' as never, multiplier: 0.5 }] }, current);
    expect(bias.expertBias).toEqual({ reversion: 1.5 });
  });
});

describe('the AI supervisor', () => {
  it('applies a bounded review at once, pauses entries, and records it', async () => {
    const { runtime, supervisor, calls } = setup(() => ({
      assessment: 'Confident calls are only 48% right: be pickier and smaller.',
      minProbability: 0.66,
      riskPercent: 5,
      expertBias: [{ expert: 'reversion', multiplier: 0.5 }],
      pauseMinutes: 15,
    }));
    const before = runtime.bot.brain.weightTable().range.reversion;
    const review = await supervisor.review('request');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe('claude-opus-5');
    expect(calls[0]!.input.settings.maxRiskPercent).toBe(2);
    expect(calls[0]!.input.recentBars.length).toBeGreaterThan(30);
    expect(review).toMatchObject({ applied: true, error: null, inputTokens: 1200 });
    expect(runtime.bot.config.ai.minProbability).toBe(0.66);
    expect(runtime.bot.config.ai.riskPercent).toBe(2);
    expect(runtime.bot.brain.weightTable().range.reversion).toBeLessThan(before);
    expect(supervisor.status().pausedUntil).not.toBeNull();
    expect(supervisor.status().reviews[0]!.changes.join('; ')).toMatch(/minimum probability 60% → 66%; risk per trade 1% → 2%; Mean reversion expert's say ×0.5; new AI entries paused for 15 min/);
    supervisor.resume();
    expect(supervisor.status().pausedUntil).toBeNull();
  });

  it('holds a suggestion for approval when auto-apply is off', async () => {
    const { runtime, supervisor } = setup(() => ({ assessment: 'Be pickier.', minProbability: 0.7 }));
    runtime.bot.updateConfig({ ai: { ...runtime.bot.config.ai, claude: { ...runtime.bot.config.ai.claude, autoApply: false } } });
    await supervisor.review('request');
    expect(runtime.bot.config.ai.minProbability).toBe(0.6);
    expect(supervisor.status().pending?.changes).toEqual(['minimum probability 60% → 70%']);
    supervisor.approvePending();
    expect(runtime.bot.config.ai.minProbability).toBe(0.7);
    expect(supervisor.status().pending).toBeNull();
    expect(supervisor.status().reviews[0]!.applied).toBe(true);
    await supervisor.review('request');
    supervisor.dismissPending();
    expect(runtime.bot.config.ai.minProbability).toBe(0.7);
  });

  it('records a failed review and leaves the AI as it was', async () => {
    const { runtime, supervisor } = setup(() => new Error('the Anthropic API key was refused — check it in Settings → AI'));
    const review = await supervisor.review('request');
    expect(review).toMatchObject({ applied: false, error: 'the Anthropic API key was refused — check it in Settings → AI' });
    expect(runtime.bot.config.ai).toEqual(DEFAULT_AI_CONFIG);
    expect(runtime.journal.list().some((l) => l.level === 'error' && /Claude review failed/.test(l.message))).toBe(true);
  });

  it('reviews on its timer while the AI trades, and after enough AI trades', async () => {
    const now = { t: Date.now() };
    const { runtime, supervisor, calls } = setup(() => ({ assessment: 'Fine as it is.' }), now);
    runtime.bot.updateConfig({ strategy: 'ai', ai: { ...runtime.bot.config.ai, claude: { ...runtime.bot.config.ai.claude, enabled: true, intervalMin: 30, afterTrades: 3 } } });
    runtime.bot.start();
    supervisor.onTick();
    expect(calls).toHaveLength(0);
    now.t += 31 * 60_000;
    supervisor.onTick();
    await settle(5);
    expect(calls).toHaveLength(1);
    expect(supervisor.status().claude.nextReviewAt).toBe(now.t + 30 * 60_000);
    for (let i = 0; i < 3; i += 1) runtime.bot.emit('ai-trade', { side: 'buy', regime: 'range', r: -1, netProfit: -10, probability: 0.62 });
    await settle(5);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.input.recentTrades).toHaveLength(3);
  });

  it('does nothing without a key, and says so when asked', async () => {
    const runtime = createRuntime({ seedPrice: 4300, tickIntervalMs: 1000, seed: 3, historyBars: 100 });
    const supervisor = new AiSupervisor(runtime.bot, runtime.accounts, runtime.journal, { reviewer: () => null });
    expect(supervisor.status().claude.configured).toBe(false);
    expect(await supervisor.review('request')).toBeNull();
    expect(runtime.journal.list().some((l) => /needs an Anthropic API key/.test(l.message))).toBe(true);
  });

  it('keeps the model across restarts through its store', () => {
    const saved: { state: unknown } = { state: null };
    const store = { load: () => saved.state, save: (s: unknown) => void (saved.state = JSON.parse(JSON.stringify(s))) };
    const first = createRuntime({ seedPrice: 4300, tickIntervalMs: 1000, seed: 3, historyBars: 300, aiStore: store });
    first.bot.brain.nudge({ trend: 1.5 });
    first.stop();
    expect(saved.state).not.toBeNull();
    const second = createRuntime({ seedPrice: 4300, tickIntervalMs: 1000, seed: 3, historyBars: 300, aiStore: store });
    expect(second.bot.brain.weightTable().range.trend).toBeCloseTo(first.bot.brain.weightTable().range.trend, 3);
    expect(second.journal.list().some((l) => /AI model restored/.test(l.message))).toBe(true);
  });
});

/** A stand-in for the Anthropic Messages API, recording what the SDK sends. */
async function fakeAnthropic(reply: (body: Record<string, unknown>) => { status: number; json: unknown }) {
  const requests: { headers: IncomingMessage['headers']; body: Record<string, unknown>; url: string }[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      requests.push({ headers: req.headers, body, url: req.url ?? '' });
      const r = reply(body);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { baseURL: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(r)) };
}

const message = (text: string, stop = 'end_turn') => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5',
  content: [{ type: 'text', text }],
  stop_reason: stop,
  stop_sequence: null,
  usage: { input_tokens: 2100, output_tokens: 350 },
});

describe('Claude as the reviewer', () => {
  let close: (() => Promise<unknown>) | null = null;
  afterEach(async () => {
    await close?.();
    close = null;
  });

  const input = (): ReviewInput => {
    const runtime = createRuntime({ seedPrice: 4300, tickIntervalMs: 1000, seed: 3, historyBars: 200 });
    let captured: ReviewInput | null = null;
    const s = new AiSupervisor(runtime.bot, runtime.accounts, runtime.journal, {
      reviewer: () => ({
        review: async (i) => {
          captured = i;
          throw new Error('stop');
        },
      }),
    });
    void s.review('request');
    return captured!;
  };

  it('sends a structured review request with refusal fallbacks, and reads the answer', async () => {
    const answer = {
      assessment: 'Too few trades to judge; one expert has been wrong more than right.',
      minProbability: 0.62,
      riskPercent: null,
      slAtr: null,
      rrMin: null,
      rrMax: null,
      maxPositions: null,
      tradeVolatile: null,
      expertBias: [{ expert: 'candles', multiplier: 0.8 }],
      pauseMinutes: null,
    };
    const api = await fakeAnthropic(() => ({ status: 200, json: message(JSON.stringify(answer)) }));
    close = api.close;
    const reviewer = createClaudeReviewer('sk-ant-test', { baseURL: api.baseURL });
    const result = await reviewer.review(input(), 'claude-opus-5');

    const req = api.requests[0]!;
    expect(req.url).toMatch(/\/v1\/messages/);
    expect(req.headers['x-api-key']).toBe('sk-ant-test');
    expect(String(req.headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01');
    expect(req.body).toMatchObject({ model: 'claude-opus-5', fallbacks: 'default', thinking: { type: 'adaptive' }, max_tokens: 16000 });
    const format = (req.body.output_config as { format: { type: string; schema: { properties: Record<string, unknown> } } }).format;
    expect(format.type).toBe('json_schema');
    expect(Object.keys(format.schema.properties)).toContain('expertBias');
    expect(String((req.body.messages as { content: string }[])[0]!.content)).toContain('"recentBars"');

    expect(result.suggestion).toMatchObject({ minProbability: 0.62, expertBias: [{ expert: 'candles', multiplier: 0.8 }] });
    expect(result.suggestion.riskPercent).toBeUndefined();
    expect(result).toMatchObject({ model: 'claude-opus-5', inputTokens: 2100, outputTokens: 350 });
  });

  it('says plainly when the key is refused or the review is declined', async () => {
    const api = await fakeAnthropic((body) =>
      body.model === 'refuse'
        ? { status: 200, json: { ...message(''), content: [], stop_reason: 'refusal' } }
        : { status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } },
    );
    close = api.close;
    const reviewer = createClaudeReviewer('sk-bad', { baseURL: api.baseURL });
    await expect(reviewer.review(input(), 'claude-opus-5')).rejects.toThrow(/API key was refused/);
    await expect(reviewer.review(input(), 'refuse')).rejects.toThrow(/declined this review/);
  });
});
