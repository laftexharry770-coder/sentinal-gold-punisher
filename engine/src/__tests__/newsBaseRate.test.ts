import { describe, expect, it } from 'vitest';
import {
  EMPTY_BASE_RATE,
  baseRateConfidence,
  measureOutcome,
  summariseOutcomes,
  type Candle,
} from '@sentinal/shared';

const MINUTE = 60_000;

/** Bars every minute from `start`, closing at each given price. */
function bars(start: number, closes: number[]): Candle[] {
  return closes.map((close, index) => ({
    time: start + index * MINUTE,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
  }));
}

describe('news base rates', () => {
  it('measures the move over the window after a release', () => {
    const start = 1_700_000_000_000;
    const candles = bars(start, [3300, 3302, 3305, 3308]);
    // Release on the first bar, measured three minutes later.
    const outcome = measureOutcome(candles, start, 3 * MINUTE);
    expect(outcome).not.toBeNull();
    expect(outcome?.priceAtRelease).toBe(3300);
    expect(outcome?.priceAfter).toBe(3308);
    expect(outcome?.move).toBeCloseTo(8, 6);
  });

  it('returns nothing when the window has no bar on both sides', () => {
    const start = 1_700_000_000_000;
    expect(measureOutcome([], start, MINUTE)).toBeNull();
    // Only the release bar exists — nothing to compare against.
    expect(measureOutcome(bars(start, [3300]), start, MINUTE)).toBeNull();
  });

  it('counts direction and sizes the typical reaction', () => {
    const rate = summariseOutcomes([
      { time: 1, priceAtRelease: 3300, priceAfter: 3310, move: 10 },
      { time: 2, priceAtRelease: 3300, priceAfter: 3294, move: -6 },
      { time: 3, priceAtRelease: 3300, priceAfter: 3302, move: 2 },
      { time: 4, priceAtRelease: 3300, priceAfter: 3300, move: 0 },
    ]);

    expect(rate.samples).toBe(4);
    expect(rate.higher).toBe(2);
    expect(rate.lower).toBe(1);
    expect(rate.unchanged).toBe(1);
    expect(rate.higherPercent).toBeCloseTo(50, 6);
    expect(rate.averageAbsMove).toBeCloseTo(4.5, 6);
    expect(rate.averageMove).toBeCloseTo(1.5, 6);
    expect(rate.largestMove).toBeCloseTo(10, 6);
  });

  it('has no percentage at all without samples', () => {
    const rate = summariseOutcomes([]);
    expect(rate).toEqual(EMPTY_BASE_RATE);
    expect(rate.higherPercent).toBeNull();
  });

  it('rates its own confidence by sample count', () => {
    const of = (samples: number) =>
      summariseOutcomes(
        Array.from({ length: samples }, (_, i) => ({
          time: i,
          priceAtRelease: 3300,
          priceAfter: 3301,
          move: 1,
        })),
      );

    expect(baseRateConfidence(of(2))).toBe('none');
    expect(baseRateConfidence(of(5))).toBe('weak');
    expect(baseRateConfidence(of(12))).toBe('moderate');
  });
});
