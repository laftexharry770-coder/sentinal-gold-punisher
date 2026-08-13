import type { Candle } from './types.js';

/**
 * Historical base rates for a recurring economic release.
 *
 * This measures what gold *did* after past releases of the same event. It is
 * not a forecast: a base rate says "this happened N times out of M", and past
 * behaviour carries no promise about the next print. The UI must label it that
 * way, because a number like "58% higher" reads as a prediction if it is not.
 */
export interface EventOutcome {
  /** Release instant the window was measured from. */
  time: number;
  priceAtRelease: number;
  priceAfter: number;
  /** Signed move in price units over the window. */
  move: number;
}

export interface BaseRate {
  /** Releases with enough price history to measure. */
  samples: number;
  higher: number;
  lower: number;
  unchanged: number;
  /** Share of samples that closed higher, 0-100. Null when there are none. */
  higherPercent: number | null;
  /** Mean absolute move, i.e. typical size of the reaction. */
  averageAbsMove: number;
  /** Mean signed move: positive means gold tended to rise. */
  averageMove: number;
  largestMove: number;
}

export const EMPTY_BASE_RATE: BaseRate = {
  samples: 0,
  higher: 0,
  lower: 0,
  unchanged: 0,
  higherPercent: null,
  averageAbsMove: 0,
  averageMove: 0,
  largestMove: 0,
};

/**
 * Price at, and a window after, one release.
 *
 * Candles must be ordered oldest first. The bar containing the release is the
 * reference; the comparison is the last close at or before release + window.
 */
export function measureOutcome(
  candles: Candle[],
  releaseTime: number,
  windowMs: number,
): EventOutcome | null {
  if (candles.length === 0) return null;

  let atRelease: Candle | null = null;
  let after: Candle | null = null;
  const target = releaseTime + windowMs;

  for (const candle of candles) {
    if (candle.time <= releaseTime) atRelease = candle;
    if (candle.time <= target) after = candle;
  }

  // Without a bar on each side of the window the sample is not measurable.
  if (!atRelease || !after || after.time <= atRelease.time) return null;

  return {
    time: releaseTime,
    priceAtRelease: atRelease.close,
    priceAfter: after.close,
    move: after.close - atRelease.close,
  };
}

/** Aggregates measured outcomes into the base rate shown on the news screen. */
export function summariseOutcomes(outcomes: EventOutcome[]): BaseRate {
  if (outcomes.length === 0) return EMPTY_BASE_RATE;

  let higher = 0;
  let lower = 0;
  let unchanged = 0;
  let sum = 0;
  let absSum = 0;
  let largest = 0;

  for (const outcome of outcomes) {
    if (outcome.move > 0) higher += 1;
    else if (outcome.move < 0) lower += 1;
    else unchanged += 1;

    sum += outcome.move;
    absSum += Math.abs(outcome.move);
    if (Math.abs(outcome.move) > Math.abs(largest)) largest = outcome.move;
  }

  const samples = outcomes.length;
  return {
    samples,
    higher,
    lower,
    unchanged,
    higherPercent: (higher / samples) * 100,
    averageAbsMove: absSum / samples,
    averageMove: sum / samples,
    largestMove: largest,
  };
}

/**
 * How much weight a base rate deserves. Under a handful of samples the
 * percentage is noise, and the UI says so rather than showing a bare number.
 */
export function baseRateConfidence(rate: BaseRate): 'none' | 'weak' | 'moderate' {
  if (rate.samples < 3) return 'none';
  if (rate.samples < 8) return 'weak';
  return 'moderate';
}
