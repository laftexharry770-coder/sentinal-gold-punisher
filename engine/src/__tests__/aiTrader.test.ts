import { describe, expect, it } from 'vitest';
import { AI_EXPERTS, type AiReading, type AiRegime, type Candle } from '@sentinal/shared';
import { createRuntime } from '../runtime.js';

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function history(start: number, drift: number, bars = 120): Candle[] {
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  return Array.from({ length: bars }, (_, i) => {
    const close = start + drift * i;
    return { time: now - (bars - i) * 60_000, open: close - drift, high: close + 0.2, low: close - 0.2, close, volume: 100 };
  });
}

/** A reading the test controls, so each case says exactly what the AI "thinks". */
function reading(over: Partial<AiReading> & { p: number; regime?: AiRegime }): AiReading {
  const { p, regime = 'trend-up', ...rest } = over;
  return {
    ready: true,
    warmup: null,
    time: 0,
    regime,
    probabilityUp: p,
    side: p > 0.52 ? 'buy' : p < 0.48 ? 'sell' : null,
    confidence: Math.abs(2 * p - 1),
    ensemble: (p - 0.5) * 2,
    experts: AI_EXPERTS.map((e) => ({ name: e.name, label: e.label, score: 0, weight: 1 / 8, hitRate: null })),
    atr: 1,
    adx: 30,
    efficiency: 0.5,
    volatilityRatio: 1,
    spreadRatio: 1,
    danger: { level: 0, reasons: [] },
    reasons: ['Trending up (ADX 30, efficiency 50%)', 'Trend bullish 70% — EMA 9/21 on M1 and EMA 8/21 on M5'],
    threshold: 0.6,
    learning: { samples: 500, accuracy: 0.6, confidentAccuracy: 0.65, trades: 0, winRate: null, expectancyR: null, updatedAt: null },
    ...rest,
  };
}

function setup(opts: { balance?: number; strategy?: 'ai' | 'burst'; drift?: number } = {}) {
  const runtime = createRuntime({ seedPrice: 0, tickIntervalMs: 1000, seed: 1, historyBars: 240, source: 'external' });
  // A burst of 0.01 lots on $10 needs the very high leverage the recording's account had.
  const leverage = opts.strategy === 'burst' ? 100_000 : 1000;
  const master = runtime.accounts.add({ name: 'Master', login: '1', server: 'sim', role: 'master', initialBalance: opts.balance ?? 10_000, leverage });
  const follower = runtime.accounts.add({
    name: 'Follower',
    login: '2',
    server: 'sim',
    role: 'slave',
    initialBalance: 5_000,
    leverage,
    copy: { enabled: true, masterId: master.id, sizing: 'multiplier', multiplier: 1, maxSlippage: 0 },
  });
  const candles = history(4300, opts.drift ?? 0.05);
  runtime.feed.seedCandles(candles);
  runtime.bot.prime(candles);
  runtime.bot.updateConfig({ strategy: opts.strategy ?? 'ai' });
  let current = reading({ p: 0.5 });
  runtime.bot.brain.read = () => current;
  const think = (r: AiReading) => {
    current = r;
  };
  let time = Date.now();
  const quote = async (bid: number, advanceMs = 1000, spread = 0.2) => {
    time += advanceMs;
    runtime.feed.pushTick({ symbol: 'XAUUSD', bid: +bid.toFixed(2), ask: +(bid + spread).toFixed(2), time });
    await settle(0);
    await settle(0);
    await settle(0);
  };
  return { runtime, master, follower, quote, think, last: candles[candles.length - 1]!.close };
}

const aiLegs = (account: { listPositions(): { comment: string }[] }) => account.listPositions().filter((p) => p.comment.startsWith('AI '));

describe('the AI trader', () => {
  it('buys when the calibrated probability clears the bar, with a volatility stop, a confidence-scaled target and 1% risk', async () => {
    const { runtime, master, follower, quote, think, last } = setup();
    runtime.bot.start();
    think(reading({ p: 0.72 }));
    await quote(last);
    const [leg] = aiLegs(master);
    expect(leg).toBeDefined();
    const ask = +(last + 0.2).toFixed(2);
    // 1.5 ATR × 1.2 in a trend = 1.80; 0.72 sits 34% of the way from 0.60 to 0.95 → 2.01R.
    expect(leg!).toMatchObject({ side: 'buy', comment: 'AI BUY', origin: 'bot', openPrice: ask });
    expect(leg!.stopLoss).toBeCloseTo(ask - 1.8, 2);
    expect(leg!.takeProfit!).toBeCloseTo(ask + 1.8 * (1.5 + 1.5 * (0.12 / 0.35)), 1);
    // $100 of 10,000 at a 1.80 stop: 0.56 lot.
    expect(leg!.volume).toBe(0.56);
    const [copy] = follower.listPositions();
    expect(copy).toMatchObject({ side: 'buy', stopLoss: leg!.stopLoss, takeProfit: leg!.takeProfit, origin: 'copy' });

    // One position at a time by default.
    await quote(last + 0.3);
    expect(aiLegs(master)).toHaveLength(1);
    expect(runtime.journal.list().some((l) => /^AI BUY 0\.56 XAUUSD @ /.test(l.message))).toBe(true);
  });

  it('stays out below the bar, in danger, and in a volatile market', async () => {
    const { runtime, master, quote, think, last } = setup();
    runtime.bot.start();
    think(reading({ p: 0.58 }));
    await quote(last);
    expect(aiLegs(master)).toHaveLength(0);
    think(reading({ p: 0.8, danger: { level: 0.8, reasons: ['spread 3.2× its average'] } }));
    await quote(last);
    expect(aiLegs(master)).toHaveLength(0);
    expect(runtime.journal.list().some((l) => /AI holding off — spread 3\.2× its average/.test(l.message))).toBe(true);
    think(reading({ p: 0.8, regime: 'volatile' }));
    await quote(last);
    expect(aiLegs(master)).toHaveLength(0);
    // A raised threshold (after losses) is respected too.
    think(reading({ p: 0.66, threshold: 0.7 }));
    await quote(last);
    expect(aiLegs(master)).toHaveLength(0);
    think(reading({ p: 0.25, regime: 'trend-down' }));
    await quote(last);
    expect(aiLegs(master)[0]?.side).toBe('sell');
  });

  it('moves the stop to break-even, then trails it, on the master and the copy', async () => {
    const { runtime, master, follower, quote, think, last } = setup();
    runtime.bot.start();
    think(reading({ p: 0.72 }));
    await quote(last);
    const leg = aiLegs(master)[0]!;
    think(reading({ p: 0.6 }));
    // One ATR in profit: the stop goes to the entry plus the spread.
    await quote(leg.openPrice + 1.1, 3000);
    await settle(5);
    const be = master.getPosition(leg.id)!.stopLoss!;
    expect(be).toBeGreaterThanOrEqual(leg.openPrice);
    expect(be).toBeLessThan(leg.openPrice + 0.5);
    // Two ATR in profit: the stop trails one ATR behind the bid.
    await quote(leg.openPrice + 2.2, 3000);
    await settle(5);
    const trailed = master.getPosition(leg.id)!.stopLoss!;
    expect(trailed).toBeCloseTo(leg.openPrice + 2.2 - 1, 1);
    expect(follower.listPositions()[0]!.stopLoss).toBe(trailed);
  });

  it('closes a trade when it turns firmly against it, and learns from the result', async () => {
    const { runtime, master, follower, quote, think, last } = setup();
    const lessons: { r: number; regime: string }[] = [];
    runtime.bot.on('ai-trade', (l: { r: number; regime: string }) => lessons.push(l));
    runtime.bot.start();
    think(reading({ p: 0.72 }));
    await quote(last);
    const leg = aiLegs(master)[0]!;
    think(reading({ p: 0.2, regime: 'trend-down' }));
    await quote(last - 0.5);
    await settle(5);
    expect(master.getPosition(leg.id)).toBeUndefined();
    expect(master.history[0]).toMatchObject({ reason: 'ai-exit', comment: 'AI BUY' });
    expect(follower.listPositions()).toHaveLength(0);
    expect(lessons).toHaveLength(1);
    expect(lessons[0]!.regime).toBe('trend-up');
    expect(lessons[0]!.r).toBeLessThan(0);
    // After a loss it waits three bars before its next entry.
    await quote(last - 0.5, 60_000);
    expect(aiLegs(master)).toHaveLength(0);
    await quote(last - 0.5, 125_000);
    expect(aiLegs(master)[0]?.side).toBe('sell');
  });

  it('will not trade a small account at more than the risk cap', async () => {
    const { runtime, master, quote, think, last } = setup({ balance: 10 });
    runtime.bot.start();
    think(reading({ p: 0.8 }));
    await quote(last);
    expect(aiLegs(master)).toHaveLength(0);
    expect(runtime.journal.list().some((l) => /minimum 0\.01 lot would risk 18\.0% of equity .* above the 2% cap/.test(l.message))).toBe(true);
  });

  it('stops for the day at its daily loss limit', async () => {
    const { runtime, master, quote, think, last } = setup();
    runtime.bot.updateConfig({ ai: { ...runtime.bot.config.ai, dailyLossPercent: 0.5, exitOnFlip: false } });
    runtime.bot.start();
    think(reading({ p: 0.72 }));
    await quote(last);
    const leg = aiLegs(master)[0]!;
    // The stop is hit: about −$100, over the 0.5% ($50) limit.
    await quote(leg.stopLoss! - 0.3);
    await settle(5);
    expect(master.history[0]?.reason).toBe('sl');
    await quote(last, 300_000);
    expect(aiLegs(master)).toHaveLength(0);
    expect(runtime.journal.list().some((l) => /AI daily loss limit reached/.test(l.message))).toBe(true);
  });
});

describe('the AI directing Burst', () => {
  it('sends the burst the way the AI calls it', async () => {
    const { runtime, master, quote, think, last } = setup({ balance: 10, strategy: 'burst' });
    expect(runtime.bot.config.burst.direction).toBe('ai');
    runtime.bot.start();
    think(reading({ p: 0.25, regime: 'trend-down' }));
    await quote(last);
    const legs = master.listPositions();
    expect(legs).toHaveLength(16);
    expect(legs.every((p) => p.side === 'sell' && p.comment === 'Sentinal SELL')).toBe(true);
    expect(runtime.bot.stats().lastSignal?.reason).toMatch(/AI calls SELL 75%/);
  });

  it('holds the burst back when the AI expects a turn against the trend, or reads danger', async () => {
    const { runtime, master, quote, think, last } = setup({ balance: 10, strategy: 'burst', drift: 0.05 });
    runtime.bot.start();
    // The trend is up, the AI leans down 58%: no burst.
    think(reading({ p: 0.42, regime: 'range' }));
    await quote(last);
    expect(master.listPositions()).toHaveLength(0);
    expect(runtime.bot.stats().lastSignal?.reason).toMatch(/AI expects a turn \(SELL 58%\) against the uptrend/);
    think(reading({ p: 0.7, danger: { level: 0.9, reasons: ['price jumped 2.1 ATR in one quote'] } }));
    await quote(last);
    expect(master.listPositions()).toHaveLength(0);
    expect(runtime.bot.stats().lastSignal?.reason).toMatch(/holding the burst back — price jumped/);
    // Unsure, not against: the burst follows the trend.
    think(reading({ p: 0.53, regime: 'range' }));
    await quote(last);
    expect(master.listPositions().length).toBe(16);
    expect(master.listPositions()[0]!.side).toBe('buy');
  });
});

describe('the AI end to end', () => {
  it('learns a trending market from history and trades it live with broker-held stops, without errors', async () => {
    const runtime = createRuntime({ seedPrice: 0, tickIntervalMs: 1000, seed: 1, historyBars: 240, source: 'external' });
    const master = runtime.accounts.add({ name: 'Master', login: '1', server: 'sim', role: 'master', initialBalance: 10_000, leverage: 1000 });
    let s = 99;
    const noise = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return (s / 4294967296 - 0.5) * 0.3;
    };
    // 400 bars of history trending up with noise …
    const t0 = Math.floor(Date.now() / 60_000) * 60_000 - 400 * 60_000;
    const candles: Candle[] = [];
    let price = 4200;
    for (let i = 0; i < 400; i += 1) {
      const open = price;
      let high = open;
      let low = open;
      for (let j = 0; j < 12; j += 1) {
        price += 0.04 + noise();
        high = Math.max(high, price);
        low = Math.min(low, price);
      }
      candles.push({ time: t0 + i * 60_000, open, high, low, close: price, volume: 100 });
    }
    runtime.feed.seedCandles(candles);
    runtime.bot.prime(candles);
    runtime.bot.updateConfig({ strategy: 'ai' });
    expect(runtime.ai.status().reading?.ready).toBe(true);
    runtime.bot.start();
    // … then two hours of live quotes carrying on up.
    let time = t0 + 400 * 60_000;
    for (let i = 0; i < 120 * 12; i += 1) {
      price += 0.04 + noise();
      time += 5_000;
      runtime.feed.pushTick({ symbol: 'XAUUSD', bid: +price.toFixed(2), ask: +(price + 0.2).toFixed(2), time });
      if (i % 4 === 0) await settle(0);
    }
    await settle(10);
    const trades = master.history.filter((t) => t.comment.startsWith('AI '));
    const open = master.listPositions().filter((p) => p.comment.startsWith('AI '));
    expect(trades.length + open.length).toBeGreaterThan(0);
    expect([...trades, ...open].every((t) => t.side === 'buy')).toBe(true);
    expect(open.every((p) => p.stopLoss !== null && p.takeProfit !== null)).toBe(true);
    expect(runtime.journal.list().filter((l) => l.level === 'error')).toHaveLength(0);
    const status = runtime.ai.status();
    expect(status.reading?.regime).toBe('trend-up');
    expect(runtime.snapshot().ai.reading?.learning.samples).toBeGreaterThan(400);
  });
});
