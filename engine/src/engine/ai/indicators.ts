/**
 * Indicator maths for the AI, over plain arrays (oldest first, last = now).
 * Each reads only the tail it needs, so a reading on every quote stays cheap.
 */

export interface Series {
  open: number[];
  high: number[];
  low: number[];
  close: number[];
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function sigmoid(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

/** Exponential average over the last `period * 4` values, seeded with their simple average. */
export function ema(values: number[], period: number, end = values.length): number {
  const n = Math.max(1, Math.round(period));
  const from = Math.max(0, end - n * 4);
  if (end - from < n) return values[end - 1] ?? Number.NaN;
  let value = 0;
  for (let i = from; i < from + n; i += 1) value += values[i]!;
  value /= n;
  const k = 2 / (n + 1);
  for (let i = from + n; i < end; i += 1) value += (values[i]! - value) * k;
  return value;
}

function trueRange(s: Series, i: number): number {
  const h = s.high[i]!;
  const l = s.low[i]!;
  if (i === 0) return h - l;
  const pc = s.close[i - 1]!;
  return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
}

/** Wilder's average true range over the tail. */
export function atr(s: Series, period: number, end = s.close.length): number {
  const from = Math.max(0, end - period * 4);
  if (end - from < 2) return end > 0 ? s.high[end - 1]! - s.low[end - 1]! : 0;
  let value = 0;
  const seed = Math.min(period, end - from);
  for (let i = from; i < from + seed; i += 1) value += trueRange(s, i);
  value /= seed;
  for (let i = from + seed; i < end; i += 1) value = (value * (period - 1) + trueRange(s, i)) / period;
  return value;
}

/** Mean true range over a long window: the market's normal bar size. */
export function meanRange(s: Series, window: number, end = s.close.length): number {
  const from = Math.max(0, end - window);
  if (end <= from) return 0;
  let sum = 0;
  for (let i = from; i < end; i += 1) sum += trueRange(s, i);
  return sum / (end - from);
}

/** Wilder's RSI over the tail, 0–100. */
export function rsi(closes: number[], period: number, end = closes.length): number {
  const from = Math.max(1, end - period * 5);
  if (end - from < period) return 50;
  let gain = 0;
  let loss = 0;
  for (let i = from; i < from + period; i += 1) {
    const d = closes[i]! - closes[i - 1]!;
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = from + period; i < end; i += 1) {
    const d = closes[i]! - closes[i - 1]!;
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

/** Wilder's ADX over the tail, 0–100. */
export function adx(s: Series, period: number, end = s.close.length): number {
  const from = Math.max(1, end - period * 6);
  if (end - from < period * 2) return 0;
  let trS = 0;
  let pS = 0;
  let mS = 0;
  let dxAvg = 0;
  let count = 0;
  for (let i = from; i < end; i += 1) {
    const up = s.high[i]! - s.high[i - 1]!;
    const down = s.low[i - 1]! - s.low[i]!;
    const pdm = up > down && up > 0 ? up : 0;
    const mdm = down > up && down > 0 ? down : 0;
    const tr = trueRange(s, i);
    if (i < from + period) {
      trS += tr;
      pS += pdm;
      mS += mdm;
      continue;
    }
    trS = trS - trS / period + tr;
    pS = pS - pS / period + pdm;
    mS = mS - mS / period + mdm;
    const pdi = trS > 0 ? (100 * pS) / trS : 0;
    const mdi = trS > 0 ? (100 * mS) / trS : 0;
    const dx = pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
    count += 1;
    dxAvg = count <= period ? dxAvg + (dx - dxAvg) / count : (dxAvg * (period - 1) + dx) / period;
  }
  return dxAvg;
}

/** Kaufman's efficiency ratio: net move over the path travelled, 0–1. */
export function efficiency(closes: number[], period: number, end = closes.length): number {
  const from = end - 1 - period;
  if (from < 0) return 0;
  let path = 0;
  for (let i = from + 1; i < end; i += 1) path += Math.abs(closes[i]! - closes[i - 1]!);
  return path > 0 ? Math.abs(closes[end - 1]! - closes[from]!) / path : 0;
}

export interface Bands {
  mid: number;
  sd: number;
  /** Where the close sits in the bands: 0 lower, 1 upper. */
  percentB: number;
  /** Band width relative to the mid. */
  width: number;
}

export function bollinger(closes: number[], period: number, mult: number, end = closes.length): Bands {
  const from = Math.max(0, end - period);
  const n = end - from;
  if (n < 2) return { mid: closes[end - 1] ?? 0, sd: 0, percentB: 0.5, width: 0 };
  let sum = 0;
  for (let i = from; i < end; i += 1) sum += closes[i]!;
  const mid = sum / n;
  let sq = 0;
  for (let i = from; i < end; i += 1) sq += (closes[i]! - mid) ** 2;
  const sd = Math.sqrt(sq / n);
  const upper = mid + mult * sd;
  const lower = mid - mult * sd;
  const percentB = upper > lower ? (closes[end - 1]! - lower) / (upper - lower) : 0.5;
  return { mid, sd, percentB, width: mid > 0 ? (upper - lower) / mid : 0 };
}

/** Highest high and lowest low of the `period` bars before `end - 1`. */
export function donchian(s: Series, period: number, end = s.close.length): { high: number; low: number } {
  const to = end - 1;
  const from = Math.max(0, to - period);
  let high = -Infinity;
  let low = Infinity;
  for (let i = from; i < to; i += 1) {
    if (s.high[i]! > high) high = s.high[i]!;
    if (s.low[i]! < low) low = s.low[i]!;
  }
  return { high, low };
}

/** Rank of `values[at]` among the `window` values before it, 0–1. */
export function percentileRank(values: number[], window: number, at = values.length - 1): number {
  if (at < 1) return 0.5;
  const from = Math.max(0, at - window);
  const v = values[at]!;
  let below = 0;
  for (let i = from; i < at; i += 1) if (values[i]! < v) below += 1;
  return below / Math.max(1, at - from);
}
