import { describe, expect, it } from 'vitest';
import type { Candle } from '@sentinal/shared';
import { MarketBrain } from '../engine/ai/brain.js';

/** Deterministic pseudo-random numbers. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function gauss(r: () => number): number {
  const u = Math.max(1e-12, r());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

/** One-minute candles from a per-step price change: each bar is twelve steps. */
function candles(count: number, step: (i: number, price: number) => number, start = 4000, t0 = Date.UTC(2026, 8, 21, 8)): Candle[] {
  const out: Candle[] = [];
  let price = start;
  let k = 0;
  for (let b = 0; b < count; b += 1) {
    const open = price;
    let high = open;
    let low = open;
    for (let j = 0; j < 12; j += 1) {
      price += step(k, price);
      k += 1;
      high = Math.max(high, price);
      low = Math.min(low, price);
    }
    out.push({ time: t0 + b * 60_000, open, high, low, close: price, volume: 100 });
  }
  return out;
}

const weightOf = (brain: MarketBrain, regime: 'trend-up' | 'range', expert: 'trend' | 'reversion' | 'momentum') =>
  brain.weightTable()[regime][expert];

describe('the AI brain', () => {
  it('warms up on history and reads a clean uptrend as one', () => {
    const r = rng(1);
    const brain = new MarketBrain();
    brain.prime(candles(400, () => 0.06 + gauss(r) * 0.12));
    const reading = brain.read(0.6);
    expect(reading.ready).toBe(true);
    expect(reading.regime).toBe('trend-up');
    expect(reading.side).toBe('buy');
    expect(reading.probabilityUp).toBeGreaterThan(0.6);
    expect(reading.learning.samples).toBeGreaterThan(300);
    expect(reading.reasons[0]).toMatch(/Trending up/);
    expect(reading.reasons.length).toBeGreaterThan(1);
  });

  it('is not ready, and names no side, before it has enough bars', () => {
    const brain = new MarketBrain();
    brain.prime(candles(40, () => 0.05));
    const reading = brain.read(0.6);
    expect(reading.ready).toBe(false);
    expect(reading.side).toBeNull();
    expect(reading.warmup).toMatch(/\d+\/60 bars/);
  });

  it('learns to trust the faders in a range and the trend followers in a trend', () => {
    // A market that swings back and forth around a level.
    const r1 = rng(7);
    const ranging = new MarketBrain();
    ranging.prime(candles(1500, (i, p) => (4000 + 3 * Math.sin(i / 40) - p) * 0.08 + gauss(r1) * 0.1));
    expect(weightOf(ranging, 'range', 'reversion')).toBeGreaterThan(weightOf(ranging, 'range', 'trend'));

    // A market that trends with persistent moves.
    const r2 = rng(9);
    const trending = new MarketBrain();
    trending.prime(candles(1500, () => 0.05 + gauss(r2) * 0.1));
    const table = trending.weightTable()['trend-up'];
    expect(table.trend + table.momentum).toBeGreaterThan(table.reversion * 2);
  });

  it('beats a coin toss on a market with real structure, scored on bars it had not seen', () => {
    // Trends that last a while, then turn: direction five bars out is
    // predictable within a trend and noise around the turns.
    const r = rng(21);
    let drift = 0.04;
    const series = candles(1600, (i) => {
      if (i % (12 * 70) === 0 && r() < 0.6) drift = -drift;
      return drift + gauss(r) * 0.12;
    });
    const brain = new MarketBrain();
    brain.prime(series.slice(0, 800));
    let right = 0;
    let called = 0;
    for (let i = 800; i < series.length - 6; i += 1) {
      brain.prime(series.slice(0, i + 1));
      const reading = brain.read(0.6, series[i]!.time);
      if (!reading.side || reading.confidence < 0.1) continue;
      const move = series[i + 5]!.close - series[i]!.close;
      called += 1;
      if ((reading.side === 'buy') === move > 0) right += 1;
    }
    expect(called).toBeGreaterThan(300);
    expect(right / called).toBeGreaterThan(0.6);
  });

  it('mostly stays out of a market with nothing to learn', () => {
    // A pure random walk: no expert can have an edge, and the calibration
    // should learn that rather than trade on local noise.
    const r = rng(122);
    const walk = candles(2400, () => gauss(r) * 0.12);
    const brain = new MarketBrain();
    brain.prime(walk.slice(0, 1000));
    let wouldTrade = 0;
    let bars = 0;
    for (let i = 1000; i < walk.length; i += 1) {
      brain.prime(walk.slice(0, i + 1));
      const reading = brain.read(0.6, walk[i]!.time);
      bars += 1;
      if (reading.ready && Math.max(reading.probabilityUp, 1 - reading.probabilityUp) >= reading.threshold) wouldTrade += 1;
    }
    expect(wouldTrade / bars).toBeLessThan(0.08);
  });

  it('keeps what it learned across a save and restore, and does not learn the same bars twice', () => {
    const r = rng(3);
    const series = candles(500, () => 0.02 + gauss(r) * 0.15);
    const first = new MarketBrain();
    first.prime(series);
    const saved = JSON.parse(JSON.stringify(first.exportState(1_000)));

    const second = new MarketBrain();
    expect(second.importState(saved)).toBe(true);
    expect(second.weightTable()).toEqual(first.weightTable());
    const samples = second.read(0.6).learning.samples;
    // The same history again (a reload): nothing is learned twice.
    second.prime(series);
    expect(second.read(0.6).learning.samples).toBe(samples);
    expect(second.read(0.6).probabilityUp).toBeCloseTo(first.read(0.6).probabilityUp, 6);

    expect(new MarketBrain().importState({ v: 1, weights: [[1]] })).toBe(false);
    expect(new MarketBrain().importState(null)).toBe(false);
  });

  it('reads a spread blow-out and a price jump as danger', () => {
    const r = rng(5);
    const brain = new MarketBrain();
    const series = candles(200, () => gauss(r) * 0.1);
    brain.prime(series);
    let t = series[series.length - 1]!.time + 1_000;
    let mid = series[series.length - 1]!.close;
    for (let i = 0; i < 120; i += 1) {
      mid += gauss(r) * 0.05;
      t += 500;
      brain.update({ symbol: 'XAUUSD', bid: mid - 0.1, ask: mid + 0.1, time: t });
    }
    expect(brain.read(0.6, t).danger.level).toBeLessThan(0.3);
    // News: the price leaps and the spread widens tenfold.
    mid += 6;
    t += 500;
    brain.update({ symbol: 'XAUUSD', bid: mid - 1, ask: mid + 1, time: t });
    const danger = brain.read(0.6, t).danger;
    expect(danger.level).toBeGreaterThanOrEqual(0.7);
    expect(danger.reasons.join(' ')).toMatch(/spread .*× its average/);
    expect(danger.reasons.join(' ')).toMatch(/jumped .* ATR/);
  });

  it('asks for more after a losing streak and less once it wins again', () => {
    const brain = new MarketBrain();
    expect(brain.threshold(0.6, 'range')).toBeCloseTo(0.6, 6);
    brain.recordTrade({ regime: 'range', side: 'buy', r: -1 });
    brain.recordTrade({ regime: 'range', side: 'buy', r: -1 });
    brain.recordTrade({ regime: 'range', side: 'sell', r: -1 });
    expect(brain.threshold(0.6, 'range')).toBeGreaterThan(0.63);
    brain.recordTrade({ regime: 'range', side: 'sell', r: 2 });
    expect(brain.threshold(0.6, 'trend-up')).toBeCloseTo(0.6, 6);
  });

  it('lets a review scale an expert’s say', () => {
    const brain = new MarketBrain();
    const before = brain.weightTable().range.reversion;
    brain.nudge({ reversion: 0.5 });
    expect(brain.weightTable().range.reversion).toBeLessThan(before);
    const sum = Object.values(brain.weightTable().range).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 2);
  });
});
