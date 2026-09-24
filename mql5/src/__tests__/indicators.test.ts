import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compileMql5 } from '../compiler/index.js';
import { IndicatorInstance } from '../runtime/indicators.js';
import { Expert } from '../runtime/expert.js';
import { BarSeries, barStart } from '../runtime/series.js';
import { SimHost, makeBars } from './simHost.js';

function series(closes: number[], spread = 1): BarSeries {
  const s = new BarSeries('XAUUSD', 1);
  s.reset(
    closes.map((c, i) => ({
      time: 60 * i,
      open: c,
      high: c + spread,
      low: c - spread,
      close: c,
      tickVolume: 10,
      spread: 20,
      realVolume: 0,
    })),
  );
  return s;
}

const CLOSES = [10, 11, 12, 11, 13, 14, 13, 15, 16, 15, 17, 18, 17, 19, 20, 19, 21, 22, 21, 23];

describe('indicators match the reference formulas', () => {
  it('EMA seeds from the first price and smooths by 2/(n+1)', () => {
    const ind = new IndicatorInstance({ kind: 'MA', symbol: 'XAUUSD', timeframe: 1, params: [5, 0, 1, 1] }, series(CLOSES));
    ind.update();
    const k = 2 / 6;
    let ema = CLOSES[0]!;
    for (let i = 1; i < CLOSES.length; i += 1) ema = CLOSES[i]! * k + ema * (1 - k);
    expect(ind.valueAt(0, 0)).toBeCloseTo(ema, 10);
  });

  it('SMA averages the window and honours ma_shift', () => {
    const ind = new IndicatorInstance({ kind: 'MA', symbol: 'XAUUSD', timeframe: 1, params: [4, 2, 0, 1] }, series(CLOSES));
    ind.update();
    const n = CLOSES.length;
    // Shifted two bars forward: the newest value is the SMA ending two bars back.
    const window = CLOSES.slice(n - 2 - 4, n - 2);
    expect(ind.valueAt(0, 0)).toBeCloseTo(window.reduce((a, b) => a + b, 0) / 4, 10);
  });

  it('RSI uses MetaTrader\'s smoothed averages', () => {
    const period = 5;
    const ind = new IndicatorInstance({ kind: 'RSI', symbol: 'XAUUSD', timeframe: 1, params: [period, 1] }, series(CLOSES));
    ind.update();
    let pos = 0;
    let neg = 0;
    for (let i = 1; i <= period; i += 1) {
      const d = CLOSES[i]! - CLOSES[i - 1]!;
      pos += Math.max(d, 0);
      neg += Math.max(-d, 0);
    }
    pos /= period;
    neg /= period;
    for (let i = period + 1; i < CLOSES.length; i += 1) {
      const d = CLOSES[i]! - CLOSES[i - 1]!;
      pos = (pos * (period - 1) + Math.max(d, 0)) / period;
      neg = (neg * (period - 1) + Math.max(-d, 0)) / period;
    }
    expect(ind.valueAt(0, 0)).toBeCloseTo(100 - 100 / (1 + pos / neg), 10);
  });

  it('ATR is a simple average of true range, as MT5 computes it', () => {
    const period = 4;
    const s = series(CLOSES, 0.5);
    const ind = new IndicatorInstance({ kind: 'ATR', symbol: 'XAUUSD', timeframe: 1, params: [period] }, s);
    ind.update();
    const n = CLOSES.length;
    let sum = 0;
    for (let i = n - period; i < n; i += 1) {
      sum += Math.max(s.high[i]!, s.close[i - 1]!) - Math.min(s.low[i]!, s.close[i - 1]!);
    }
    expect(ind.valueAt(0, 0)).toBeCloseTo(sum / period, 10);
  });

  it('updates incrementally on a new tick exactly as a full recompute would', () => {
    const s = series(CLOSES);
    const live = new IndicatorInstance({ kind: 'RSI', symbol: 'XAUUSD', timeframe: 1, params: [6, 1] }, s);
    live.update();
    s.apply(24.5, 60 * CLOSES.length + 5, 20);
    s.apply(23.9, 60 * CLOSES.length + 20, 20);
    live.update();
    const fresh = new IndicatorInstance({ kind: 'RSI', symbol: 'XAUUSD', timeframe: 1, params: [6, 1] }, s);
    fresh.update();
    expect(live.valueAt(0, 0)).toBeCloseTo(fresh.valueAt(0, 0), 12);
    expect(live.valueAt(0, 1)).toBeCloseTo(fresh.valueAt(0, 1), 12);
  });
});

describe('bar boundaries follow MetaTrader', () => {
  it('opens weeks on Sunday and months on the first', () => {
    // Wednesday 24 September 2025, 13:37 server time.
    const t = Date.UTC(2025, 8, 24, 13, 37) / 1000;
    expect(new Date(barStart(t, 32769) * 1000).toISOString()).toBe('2025-09-21T00:00:00.000Z');
    expect(new Date(barStart(t, 49153) * 1000).toISOString()).toBe('2025-09-01T00:00:00.000Z');
    expect(new Date(barStart(t, 16388) * 1000).toISOString()).toBe('2025-09-24T12:00:00.000Z');
  });
});

describe('the Sentinal expert advisor', () => {
  const source = readFileSync(fileURLToPath(new URL('./fixtures/Sentinal.mq5', import.meta.url)), 'utf8');

  it('compiles, exposes its inputs and trades a simulated market', async () => {
    const compiled = compileMql5(source, 'Sentinal.mq5');
    if (!compiled.ok) throw new Error(compiled.diagnostics.map((d) => `${d.line}: ${d.message}`).join('\n'));
    expect(compiled.inputs).toHaveLength(55);
    expect(compiled.inputs.find((i) => i.name === 'InpStrategy')?.options?.map((o) => o.label)).toEqual([
      'EMA cross (fast crosses slow)',
      'RSI reversion (leaves oversold/overbought)',
      'Breakout of N-bar high/low',
    ]);

    const start = 1_758_700_000 - (1_758_700_000 % 60);
    const host = new SimHost('XAUUSD', 1, start, 3300);
    host.seedBars(1, makeBars(300, start));
    const expert = new Expert(compiled, host);
    const started = await expert.start({ InpAutoTrade: true, InpNewYorkOnly: false, InpVerboseLog: false, InpMaxSpreadPoints: 0, InpMaxSpreadATR: 0 });
    expect(started).toBe(true);

    let price = 3300;
    let t = start;
    let seed = 42;
    for (let i = 0; i < 3000; i += 1) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      price += (seed / 4294967296 - 0.5) * 0.8;
      t += 5;
      host.quoteAt(+price.toFixed(2), t);
      expert.tick();
      await expert.idle();
    }
    await expert.stop();

    expect(expert.error).toBeNull();
    const entries = host.requests.filter((r) => r.action === 1 && r.position === 0);
    expect(entries.length).toBeGreaterThan(0);
    for (const r of entries) {
      expect(r.magic).toBe(770001);
      expect(r.comment).toBe('Sentinal');
      // Dollar stops: $2 at 0.01 lots is a $2.00 move in gold, halved when the ladder doubles the lot.
      const stop = Math.abs(r.price - r.sl);
      expect(stop).toBeCloseTo(2 / (r.volume * 100), 1);
    }
    expect(host.logs.some((l) => l.message.startsWith('======== Sentinal summary'))).toBe(true);
    expect(host.logs.some((l) => /^Bars evaluated: \d+ {3}Orders placed: \d+$/.test(l.message))).toBe(true);
  });
});
