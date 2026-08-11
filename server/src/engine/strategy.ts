import type { BotConfig, Signal, Tick } from '@sentinal/shared';
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
