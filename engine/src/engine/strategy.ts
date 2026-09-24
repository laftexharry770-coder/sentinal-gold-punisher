import type { BotConfig, Candle, Side, Signal, Tick } from '@sentinal/shared';
import { clamp, round } from '../util.js';

const FAST_PERIOD = 9;
const SLOW_PERIOD = 34;
const MOMENTUM_LOOKBACK = 12;
const HISTORY = 240;

/**
 * Tick-driven signal generation for XAUUSD.
 *
 * Three interchangeable models share one indicator set:
 *  - adaptive-scalp: trades pullbacks in the direction of the fast/slow spread,
 *    scaling its confidence by how far the spread runs versus current volatility.
 *  - momentum: breakout of the recent tick range.
 *  - mean-reversion: fades stretched moves back toward the fast average.
 */
export class StrategyEngine {
  private prices: number[] = [];
  private fast = 0;
  private slow = 0;
  private volatility = 0.2;
  private lastPrice = 0;

  update(tick: Tick): void {
    const mid = (tick.bid + tick.ask) / 2;
    if (this.prices.length === 0) {
      this.fast = mid;
      this.slow = mid;
    }
    const kFast = 2 / (FAST_PERIOD + 1);
    const kSlow = 2 / (SLOW_PERIOD + 1);
    this.fast += (mid - this.fast) * kFast;
    this.slow += (mid - this.slow) * kSlow;

    if (this.lastPrice > 0) {
      const move = Math.abs(mid - this.lastPrice);
      this.volatility += (move - this.volatility) * 0.05;
    }
    this.lastPrice = mid;

    this.prices.push(mid);
    if (this.prices.length > HISTORY) this.prices.shift();
  }

  get ready(): boolean {
    return this.prices.length >= SLOW_PERIOD;
  }

  private momentum(): number {
    const n = this.prices.length;
    if (n <= MOMENTUM_LOOKBACK) return 0;
    const past = this.prices[n - 1 - MOMENTUM_LOOKBACK] ?? 0;
    const now = this.prices[n - 1] ?? 0;
    return now - past;
  }

  private range(lookback: number): { high: number; low: number } {
    const slice = this.prices.slice(-lookback);
    let high = -Infinity;
    let low = Infinity;
    for (const p of slice) {
      if (p > high) high = p;
      if (p < low) low = p;
    }
    return { high, low };
  }

  evaluate(cfg: BotConfig, tick: Tick): Signal {
    const price = (tick.bid + tick.ask) / 2;
    const spread = this.fast - this.slow;
    const momentum = this.momentum();
    const vol = Math.max(0.02, this.volatility);

    const base: Signal = {
      time: tick.time,
      symbol: cfg.symbol,
      side: null,
      strength: 0,
      fast: round(this.fast, 3),
      slow: round(this.slow, 3),
      momentum: round(momentum, 3),
      volatility: round(vol, 4),
      reason: 'warming up',
    };

    if (!this.ready) return base;

    switch (cfg.strategy) {
      case 'momentum': {
        const { high, low } = this.range(60);
        if (price >= high - vol * 0.2 && momentum > 0) {
          return { ...base, side: 'buy', strength: clamp(momentum / (vol * 6), 0, 1), reason: 'range breakout up' };
        }
        if (price <= low + vol * 0.2 && momentum < 0) {
          return { ...base, side: 'sell', strength: clamp(-momentum / (vol * 6), 0, 1), reason: 'range breakout down' };
        }
        return { ...base, reason: 'inside range' };
      }

      case 'mean-reversion': {
        const stretch = (price - this.fast) / vol;
        if (stretch > 2.2) {
          return { ...base, side: 'sell', strength: clamp((stretch - 2.2) / 2, 0, 1), reason: 'stretched above mean' };
        }
        if (stretch < -2.2) {
          return { ...base, side: 'buy', strength: clamp((-stretch - 2.2) / 2, 0, 1), reason: 'stretched below mean' };
        }
        return { ...base, reason: 'near mean' };
      }

      default: {
        // adaptive-scalp — trend from the EMA spread, timing from the pullback.
        const trend = spread / vol;
        const pullback = (price - this.fast) / vol;
        if (trend > 0.6 && pullback < 0.4 && momentum > -vol * 2) {
          const strength = clamp((trend - 0.6) / 2 + 0.25, 0, 1);
          return { ...base, side: 'buy', strength, reason: 'uptrend pullback entry' };
        }
        if (trend < -0.6 && pullback > -0.4 && momentum < vol * 2) {
          const strength = clamp((-trend - 0.6) / 2 + 0.25, 0, 1);
          return { ...base, side: 'sell', strength, reason: 'downtrend pullback entry' };
        }
        return { ...base, reason: trend > 0 ? 'trend up, awaiting pullback' : 'trend down, awaiting pullback' };
      }
    }
  }
}

export interface TrendReading {
  side: Side | null;
  fast: number;
  slow: number;
  price: number;
  ready: boolean;
  reason: string;
}

/** Exponential average seeded with the simple average of its first period. */
function ema(values: number[], period: number): number {
  if (values.length < period) return Number.NaN;
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i += 1) value += (values[i]! - value) * k;
  return value;
}

/**
 * The trend on closed-bar prices, for the burst model: fast average over the
 * slow one with price beyond the fast is up, the mirror image is down, and
 * anything in between is no trend. Kept as one-minute closes (history plus
 * live quotes) and rolled up to whatever timeframe is asked for.
 */
export class TrendTracker {
  private minutes: number[] = [];
  private closes: number[] = [];

  prime(candles: Candle[]): void {
    for (const candle of candles) this.record(Math.floor(candle.time / 60_000), candle.close);
  }

  update(tick: Tick): void {
    this.record(Math.floor(tick.time / 60_000), (tick.bid + tick.ask) / 2);
  }

  private record(minute: number, close: number): void {
    const last = this.minutes.length - 1;
    if (last >= 0 && this.minutes[last] === minute) {
      this.closes[last] = close;
      return;
    }
    if (last >= 0 && minute < this.minutes[last]!) return;
    this.minutes.push(minute);
    this.closes.push(close);
    if (this.minutes.length > 6000) {
      this.minutes.shift();
      this.closes.shift();
    }
  }

  /** Closes on the given timeframe, oldest first; the last is the forming bar. */
  private series(timeframeMin: number): number[] {
    const tf = Math.max(1, Math.round(timeframeMin));
    if (tf === 1) return this.closes;
    const out: number[] = [];
    let bucket = Number.NaN;
    for (let i = 0; i < this.minutes.length; i += 1) {
      const b = Math.floor(this.minutes[i]! / tf);
      if (b === bucket) out[out.length - 1] = this.closes[i]!;
      else {
        out.push(this.closes[i]!);
        bucket = b;
      }
    }
    return out;
  }

  read(timeframeMin: number, fastPeriod: number, slowPeriod: number): TrendReading {
    const closes = this.series(timeframeMin);
    const price = closes[closes.length - 1] ?? 0;
    const slowN = Math.max(2, Math.round(slowPeriod));
    const fastN = Math.max(1, Math.min(slowN - 1, Math.round(fastPeriod)));
    if (closes.length < slowN) {
      return { side: null, fast: 0, slow: 0, price, ready: false, reason: `reading the trend — ${closes.length}/${slowN} bars` };
    }
    const fast = ema(closes, fastN);
    const slow = ema(closes, slowN);
    const r = (v: number) => round(v, 3);
    // A crossing by a hair in a flat market is noise, not a trend: the gap
    // must be a real share of the bars' typical move, and of the price.
    let moves = 0;
    const from = Math.max(1, closes.length - slowN);
    for (let i = from; i < closes.length; i += 1) moves += Math.abs(closes[i]! - closes[i - 1]!);
    const typicalMove = moves / Math.max(1, closes.length - from);
    const minimumGap = Math.max(0.3 * typicalMove, price * 0.00001);
    if (Math.abs(fast - slow) < minimumGap) {
      return { side: null, fast: r(fast), slow: r(slow), price, ready: true, reason: 'no clear trend — waiting' };
    }
    if (fast > slow && price > fast) {
      return { side: 'buy', fast: r(fast), slow: r(slow), price, ready: true, reason: `uptrend — EMA${fastN} above EMA${slowN}` };
    }
    if (fast < slow && price < fast) {
      return { side: 'sell', fast: r(fast), slow: r(slow), price, ready: true, reason: `downtrend — EMA${fastN} below EMA${slowN}` };
    }
    return { side: null, fast: r(fast), slow: r(slow), price, ready: true, reason: 'no clear trend — waiting' };
  }
}
