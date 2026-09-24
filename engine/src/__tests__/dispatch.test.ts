import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { registerSymbolSpec, XAUUSD, type AccountConfig, type DispatchReport, type Tick } from '@sentinal/shared';
import { TradingAccount, type OpenRequest, type OpenResult } from '../broker/account.js';
import { AccountManager } from '../broker/manager.js';
import { baseSymbol, CopyTradeEngine } from '../engine/copier.js';
import { loadStrategy, placeOrder, startBot, stopBot, updateBotConfig } from '../commands.js';
import { Journal } from '../journal.js';
import { createRuntime } from '../runtime.js';

/** An account whose broker takes `delayMs` to answer, recording when each order left. */
class SlowAccount extends TradingAccount {
  sentAt: number[] = [];
  constructor(
    config: AccountConfig,
    private readonly delayMs: number,
    private readonly reject = false,
  ) {
    super(config);
  }
  override async submit(req: OpenRequest): Promise<OpenResult> {
    this.sentAt.push(performance.now());
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.reject) return { ok: false, error: 'not enough money', code: 'NO_MONEY' };
    return this.open(req);
  }
}

function setup(delays: { master: number; followers: number[]; masterRejects?: boolean }) {
  const journal = new Journal();
  const accounts = new AccountManager();
  let n = 0;
  accounts.registerProvider('metaapi', (config) => {
    const i = n++;
    return i === 0 ? new SlowAccount(config, delays.master, delays.masterRejects) : new SlowAccount(config, delays.followers[i - 1] ?? 0);
  });
  const copier = new CopyTradeEngine(accounts, journal);
  const master = accounts.add({ name: 'Master', provider: 'metaapi', login: '1', server: 'Exness-MT5Real9', role: 'master', initialBalance: 50_000, symbol: 'XAUUSDm' }) as SlowAccount;
  const followers = delays.followers.map(
    (_, i) =>
      accounts.add({
        name: `Follower ${i + 1}`,
        provider: 'metaapi',
        login: String(10 + i),
        server: 'ICMarketsSC-Live',
        role: 'slave',
        initialBalance: 50_000,
        symbol: 'XAUUSD',
        copy: { enabled: true, masterId: master.id, sizing: 'multiplier', multiplier: 2, maxSlippage: 0 },
      }) as SlowAccount,
  );
  const tick = (symbol: string): Tick => ({ symbol, bid: 3300, ask: 3300.2, time: Date.now() });
  master.onTick(tick('XAUUSDm'));
  for (const f of followers) f.onTick(tick('XAUUSD'));
  const reports: DispatchReport[] = [];
  copier.on('dispatch', (r: DispatchReport) => reports.push(r));
  return { journal, accounts, copier, master, followers, reports };
}

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

describe('simultaneous dispatch', () => {
  registerSymbolSpec({ ...XAUUSD, symbol: 'XAUUSDm' });

  it('sends to every follower before the master has answered', async () => {
    const ctx = setup({ master: 40, followers: [5, 5, 5] });
    const t0 = performance.now();
    const result = await ctx.copier.open(ctx.master, { symbol: 'XAUUSDm', side: 'buy', volume: 0.1, stopLoss: 3290, takeProfit: 3320, origin: 'bot' });
    expect(result.ok).toBe(true);
    // All three follower orders left before the master's 40 ms answer came back.
    for (const f of ctx.followers) expect(f.sentAt[0]! - t0).toBeLessThan(20);
    await settle();
    for (const f of ctx.followers) {
      const [copy] = f.listPositions();
      expect(copy).toMatchObject({ symbol: 'XAUUSD', side: 'buy', volume: 0.2, stopLoss: 3290, takeProfit: 3320, origin: 'copy' });
      expect(copy!.sourceId).toBe(ctx.master.listPositions()[0]!.id);
    }
    const report = ctx.reports[0]!;
    expect(report.legs).toHaveLength(4);
    expect(report.sendSpreadMs).toBeLessThan(10);
    expect(report.legs.every((l) => l.ok)).toBe(true);
  });

  it('does not copy the same fill twice', async () => {
    const ctx = setup({ master: 0, followers: [0] });
    await ctx.copier.open(ctx.master, { symbol: 'XAUUSDm', side: 'sell', volume: 0.05, origin: 'bot' });
    await settle();
    expect(ctx.followers[0]!.listPositions()).toHaveLength(1);
  });

  it('closes the copies together with the master', async () => {
    const ctx = setup({ master: 5, followers: [5, 5] });
    await ctx.copier.open(ctx.master, { symbol: 'XAUUSDm', side: 'buy', volume: 0.1, origin: 'bot' });
    await settle();
    const [position] = ctx.master.listPositions();
    await ctx.copier.close(ctx.master, position!.id, 'manual');
    await settle();
    expect(ctx.master.listPositions()).toHaveLength(0);
    for (const f of ctx.followers) expect(f.listPositions()).toHaveLength(0);
    expect(ctx.reports.some((r) => r.action === 'close' && r.legs.length === 3)).toBe(true);
  });

  it('moves the copies\' stops with the master', async () => {
    const ctx = setup({ master: 0, followers: [0] });
    await ctx.copier.open(ctx.master, { symbol: 'XAUUSDm', side: 'buy', volume: 0.1, stopLoss: 3290, origin: 'bot' });
    await settle();
    await ctx.copier.modify(ctx.master, ctx.master.listPositions()[0]!.id, 3295, 3330);
    await settle();
    expect(ctx.followers[0]!.listPositions()[0]).toMatchObject({ stopLoss: 3295, takeProfit: 3330 });
  });

  it('closes a follower fill when the master rejected the same order', async () => {
    const ctx = setup({ master: 5, followers: [0], masterRejects: true });
    const result = await ctx.copier.open(ctx.master, { symbol: 'XAUUSDm', side: 'buy', volume: 0.1, origin: 'bot' });
    expect(result.ok).toBe(false);
    await settle();
    expect(ctx.followers[0]!.listPositions()).toHaveLength(0);
    expect(ctx.journal.list().some((l) => /master rejected/.test(l.message))).toBe(true);
  });

  it('inverts direction and swaps the levels for a reversed follower', async () => {
    const ctx = setup({ master: 0, followers: [0] });
    ctx.accounts.update(ctx.followers[0]!.id, { copy: { ...ctx.followers[0]!.config.copy, reverse: true } });
    await ctx.copier.open(ctx.master, { symbol: 'XAUUSDm', side: 'buy', volume: 0.1, stopLoss: 3290, takeProfit: 3320, origin: 'bot' });
    await settle();
    expect(ctx.followers[0]!.listPositions()[0]).toMatchObject({ side: 'sell', stopLoss: 3320, takeProfit: 3290 });
  });

  it('keeps every account\'s stop at the same price for money-based stops', async () => {
    const ctx = setup({ master: 0, followers: [0] });
    await ctx.copier.open(ctx.master, { symbol: 'XAUUSDm', side: 'buy', volume: 0.1, stopLossUsd: 20, takeProfitUsd: 10, origin: 'bot' });
    await settle();
    const m = ctx.master.listPositions()[0]!;
    const f = ctx.followers[0]!.listPositions()[0]!;
    // Twice the lots, same price levels: $20 at 0.1 lots is a $2 move.
    expect(m.stopLoss).toBeCloseTo(3298.2, 2);
    expect(f.stopLoss).toBeCloseTo(m.stopLoss!, 2);
    expect(f.takeProfit).toBeCloseTo(m.takeProfit!, 2);
  });

  it('copies positions opened outside the engine only when mirroring', async () => {
    const ctx = setup({ master: 0, followers: [0] });
    ctx.master.open({ symbol: 'XAUUSDm', side: 'buy', volume: 0.1, origin: 'external' });
    await settle();
    expect(ctx.followers[0]!.listPositions()).toHaveLength(0);
    ctx.copier.mirrorExternal = true;
    ctx.master.open({ symbol: 'XAUUSDm', side: 'sell', volume: 0.1, origin: 'external' });
    await settle();
    expect(ctx.followers[0]!.listPositions()).toHaveLength(1);
  });
});

describe('broker symbol names', () => {
  it('reads every broker\'s gold as the same instrument', () => {
    for (const name of ['XAUUSD', 'XAUUSDm', 'XAUUSD.raw', 'xauusd_i', 'GOLD', 'GOLD#', 'XAUUSD+']) {
      expect(baseSymbol(name)).toBe('XAUUSD');
    }
    expect(baseSymbol('EURUSD.m')).toBe('EURUSD');
  });
});

describe('an uploaded expert as the strategy', () => {
  const source = readFileSync(fileURLToPath(new URL('../../../mql5/src/__tests__/fixtures/Sentinal.mq5', import.meta.url)), 'utf8');

  it('runs the EA on the master and mirrors its trades to the follower', async () => {
    const runtime = createRuntime({ seedPrice: 3300, tickIntervalMs: 50, seed: 11, historyBars: 400 });
    const master = runtime.accounts.add({ name: 'Master', login: '1', server: 'sim', role: 'master', initialBalance: 10_000 });
    const follower = runtime.accounts.add({
      name: 'Follower',
      login: '2',
      server: 'sim',
      role: 'slave',
      initialBalance: 10_000,
      copy: { enabled: true, masterId: master.id, sizing: 'multiplier', multiplier: 1, maxSlippage: 0 },
    });

    const loaded = await loadStrategy(runtime, [{ name: 'Sentinal.mq5', content: source }]);
    expect(loaded.kind).toBe('mql5');
    expect(runtime.bot.config.source).toBe('mql5');
    expect(runtime.strategyInfo().inputs).toHaveLength(55);

    updateBotConfig(runtime, {
      expertTimeframe: 1,
      expertInputs: { InpAutoTrade: true, InpNewYorkOnly: false, InpVerboseLog: false, InpMaxSpreadPoints: 0, InpMaxSpreadATR: 0, InpShowPanel: true },
      maxDailyLossUsd: null,
    });
    startBot(runtime);
    // Let the expert load its history and run OnInit, as it would before the first live tick.
    for (let i = 0; i < 50 && runtime.strategyInfo().status !== 'running'; i += 1) await settle(5);
    expect(runtime.strategyInfo().status).toBe('running');

    // Drive the feed by hand, letting the EA finish each tick as a live terminal would.
    const feed = runtime.feed;
    let price = feed.quote?.bid ?? 3300;
    let time = Date.now();
    let seed = 5;
    for (let i = 0; i < 3000; i += 1) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      price += (seed / 4294967296 - 0.5) * 0.9;
      time += 5000;
      feed.pushTick({ symbol: 'XAUUSD', bid: +price.toFixed(2), ask: +(price + 0.2).toFixed(2), time });
      await runtime.expert.idle();
    }
    await settle(20);
    expect(runtime.strategyInfo().ticks).toBe(3000);

    const info = runtime.strategyInfo();
    expect(info.status).toBe('running');
    expect(info.panel.some((line) => line.startsWith('Sentinal:'))).toBe(true);
    const eaTrades = master.history.filter((t) => t.origin === 'bot').length + master.listPositions().filter((p) => p.origin === 'bot').length;
    expect(eaTrades).toBeGreaterThan(0);
    const copies = follower.history.filter((t) => t.origin === 'copy').length + follower.listPositions().filter((p) => p.origin === 'copy').length;
    expect(copies).toBe(eaTrades);
    expect(runtime.copier.recent().length).toBeGreaterThan(0);

    stopBot(runtime);
    await settle(20);
    expect(runtime.strategyInfo().status).toBe('stopped');
  });

  it('refuses an EA that does not compile, and says where', async () => {
    const runtime = createRuntime({ seedPrice: 3300, tickIntervalMs: 50, seed: 1, historyBars: 50 });
    const loaded = await loadStrategy(runtime, [{ name: 'Broken.mq5', content: 'void OnTick() {\n  Undeclared();\n}' }]);
    expect(loaded.kind === 'mql5' && !loaded.result.ok).toBe(true);
    expect(runtime.bot.config.source).toBe('builtin');
    expect(runtime.journal.list()[0]?.message).toMatch(/line 2/);
  });

  it('switches to mirror mode for a compiled .ex5', async () => {
    const runtime = createRuntime({ seedPrice: 3300, tickIntervalMs: 50, seed: 1, historyBars: 50 });
    const bytes = new Uint8Array(4096).map((_, i) => (i * 37) % 256);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    const loaded = await loadStrategy(runtime, [{ name: 'Angel_Bot.ex5', content: btoa(binary), encoding: 'base64' }]);
    expect(loaded.kind).toBe('ex5');
    expect(runtime.bot.config.source).toBe('mirror');
    expect(runtime.strategyInfo()).toMatchObject({ source: 'mirror', name: 'Angel_Bot' });
    expect(runtime.strategyInfo().fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps the manual ticket working through the dispatcher', async () => {
    const runtime = createRuntime({ seedPrice: 3300, tickIntervalMs: 50, seed: 1, historyBars: 50 });
    const master = runtime.accounts.add({ name: 'Master', login: '1', server: 'sim', role: 'master', initialBalance: 10_000 });
    const follower = runtime.accounts.add({ name: 'F', login: '2', server: 'sim', role: 'slave', initialBalance: 10_000, copy: { enabled: true, masterId: master.id, maxSlippage: 0 } });
    runtime.feed.pushTick({ symbol: 'XAUUSD', bid: 3300, ask: 3300.2, time: Date.now() });
    const result = await placeOrder(runtime, { accountId: master.id, side: 'buy', volume: 0.02, legs: 3 });
    expect(result.opened).toHaveLength(3);
    await settle();
    expect(follower.listPositions()).toHaveLength(3);
  });
});
