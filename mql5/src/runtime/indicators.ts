import type { BarSeries } from './series.js';

/**
 * MetaTrader 5's built-in indicators, computed the way MetaTrader computes
 * them.
 *
 * Several differ from the textbook versions and EAs are tuned against
 * MetaTrader's numbers, so these follow MetaQuotes' own source: MT5's ATR is a
 * simple average of true range (not Wilder's), iADX smooths with an EMA while
 * iADXWilder uses Wilder's method, the MACD signal line is a simple average,
 * and EMAs start from the first price rather than from an SMA.
 *
 * Every indicator computes incrementally, like OnCalculate with
 * prev_calculated: a new tick recomputes only the forming bar.
 */

export const EMPTY = Number.MAX_VALUE;

export type IndicatorKind =
  | 'MA' | 'RSI' | 'ATR' | 'ADX' | 'ADXW' | 'BANDS' | 'MACD' | 'OSMA' | 'STOCH' | 'CCI' | 'MOMENTUM' | 'SAR'
  | 'WPR' | 'ENVELOPES' | 'STDDEV' | 'AO' | 'AC' | 'DEMA' | 'TEMA' | 'MFI' | 'OBV' | 'FORCE' | 'DEMARKER'
  | 'BULLS' | 'BEARS' | 'ICHIMOKU' | 'ALLIGATOR' | 'FRACTALS' | 'VOLUMES';

/** Visible buffers per indicator. Hidden working buffers follow them. */
const VISIBLE: Record<IndicatorKind, number> = {
  MA: 1, RSI: 1, ATR: 1, ADX: 3, ADXW: 3, BANDS: 3, MACD: 2, OSMA: 1, STOCH: 2, CCI: 1, MOMENTUM: 1, SAR: 1,
  WPR: 1, ENVELOPES: 2, STDDEV: 1, AO: 1, AC: 1, DEMA: 1, TEMA: 1, MFI: 1, OBV: 1, FORCE: 1, DEMARKER: 1,
  BULLS: 1, BEARS: 1, ICHIMOKU: 5, ALLIGATOR: 3, FRACTALS: 2, VOLUMES: 1,
};

export function appliedPrice(s: BarSeries, i: number, applied: number): number {
  switch (applied) {
    case 2:
      return s.open[i]!;
    case 3:
      return s.high[i]!;
    case 4:
      return s.low[i]!;
    case 5:
      return (s.high[i]! + s.low[i]!) / 2;
    case 6:
      return (s.high[i]! + s.low[i]! + s.close[i]!) / 3;
    case 7:
      return (s.high[i]! + s.low[i]! + 2 * s.close[i]!) / 4;
    default:
      return s.close[i]!;
  }
}

/**
 * A moving average of `src` into `dst` from index `from`, with MT5's four
 * methods. `begin` is the first index `src` holds meaningful data at.
 */
export function maOnArray(src: number[], dst: number[], from: number, n: number, period: number, method: number, begin = 0): void {
  const p = Math.max(1, Math.floor(period));
  for (let i = Math.max(from, 0); i < n; i += 1) {
    if (i < begin) {
      dst[i] = 0;
      continue;
    }
    switch (method) {
      case 1: {
        // EMA — seeded with the first value, as MovingAverages.mqh does.
        const k = 2 / (p + 1);
        dst[i] = i === begin ? src[i]! : src[i]! * k + dst[i - 1]! * (1 - k);
        break;
      }
      case 2: {
        // SMMA — the first value is an SMA, then (prev*(n-1)+price)/n.
        if (i < begin + p - 1) {
          dst[i] = 0;
        } else if (i === begin + p - 1) {
          let sum = 0;
          for (let k = 0; k < p; k += 1) sum += src[i - k]!;
          dst[i] = sum / p;
        } else {
          dst[i] = (dst[i - 1]! * (p - 1) + src[i]!) / p;
        }
        break;
      }
      case 3: {
        // LWMA — the newest value weighs `period`, the oldest 1.
        if (i < begin + p - 1) {
          dst[i] = 0;
          break;
        }
        let sum = 0;
        let weights = 0;
        for (let k = 0; k < p; k += 1) {
          const w = p - k;
          sum += src[i - k]! * w;
          weights += w;
        }
        dst[i] = sum / weights;
        break;
      }
      default: {
        if (i < begin + p - 1) {
          dst[i] = 0;
          break;
        }
        let sum = 0;
        for (let k = 0; k < p; k += 1) sum += src[i - k]!;
        dst[i] = sum / p;
      }
    }
  }
}

export interface IndicatorSpec {
  kind: IndicatorKind;
  symbol: string;
  timeframe: number;
  params: number[];
}

export class IndicatorInstance {
  readonly buffers: number[][];
  /** Plot shift per visible buffer: positive moves the line into the future. */
  readonly shifts: number[];
  private calculated = 0;
  private version = -1;
  private firstTime = -1;
  /** Scratch arrays by name, for intermediate series. */
  private readonly work = new Map<string, number[]>();

  constructor(
    readonly spec: IndicatorSpec,
    readonly series: BarSeries,
  ) {
    const extra = { RSI: 2, ATR: 1, ADX: 3, ADXW: 6, MACD: 2, OSMA: 3, STOCH: 2, CCI: 2, SAR: 3, AC: 1, DEMA: 2, TEMA: 3, MFI: 1, FORCE: 1, DEMARKER: 2, BULLS: 1, BEARS: 1 } as Partial<Record<IndicatorKind, number>>;
    const total = VISIBLE[spec.kind] + (extra[spec.kind] ?? 0);
    this.buffers = Array.from({ length: total }, () => []);
    this.shifts = new Array(VISIBLE[spec.kind]).fill(0);
    const p = spec.params;
    if (spec.kind === 'MA' || spec.kind === 'BANDS' || spec.kind === 'ENVELOPES' || spec.kind === 'STDDEV' || spec.kind === 'DEMA' || spec.kind === 'TEMA') {
      this.shifts.fill(p[1] ?? 0);
    }
    if (spec.kind === 'ALLIGATOR') {
      this.shifts[0] = p[1] ?? 8;
      this.shifts[1] = p[3] ?? 5;
      this.shifts[2] = p[5] ?? 3;
    }
    if (spec.kind === 'ICHIMOKU') {
      const kijun = p[1] ?? 26;
      this.shifts[2] = kijun;
      this.shifts[3] = kijun;
      this.shifts[4] = -kijun;
    }
  }

  get visible(): number {
    return VISIBLE[this.spec.kind];
  }

  private scratch(name: string): number[] {
    let arr = this.work.get(name);
    if (!arr) {
      arr = [];
      this.work.set(name, arr);
    }
    return arr;
  }

  /** Brings the buffers up to date with the series. Returns the bars calculated. */
  update(): number {
    const s = this.series;
    const n = s.length;
    if (n === 0) return 0;
    if (s.version === this.version && n === this.calculated) return n;
    let from = this.calculated > 0 ? this.calculated - 1 : 0;
    if (s.time[0] !== this.firstTime || n < this.calculated) {
      from = 0;
      for (const b of this.buffers) b.length = 0;
      for (const w of this.work.values()) w.length = 0;
    }
    this.compute(from, n);
    this.firstTime = s.time[0]!;
    this.calculated = n;
    this.version = s.version;
    return n;
  }

  /**
   * Value of buffer `buffer` at `shift` bars back from the newest, with the
   * plot shift applied: a line shifted forward by k shows, at the newest bar,
   * what was computed k bars earlier.
   */
  valueAt(buffer: number, shift: number): number {
    const n = this.series.length;
    const plot = this.shifts[buffer] ?? 0;
    const i = n - 1 - shift - plot;
    const buf = this.buffers[buffer];
    if (!buf || i < 0 || i >= n) return EMPTY;
    return buf[i] ?? EMPTY;
  }

  private compute(from: number, n: number): void {
    const s = this.series;
    const p = this.spec.params;
    const b = this.buffers;
    switch (this.spec.kind) {
      case 'MA': {
        const src = this.scratch('src');
        for (let i = from; i < n; i += 1) src[i] = appliedPrice(s, i, p[3] ?? 1);
        maOnArray(src, b[0]!, from, n, p[0] ?? 14, p[2] ?? 0);
        break;
      }
      case 'RSI': {
        const period = Math.max(1, p[0] ?? 14);
        const rsi = b[0]!;
        const pos = b[1]!;
        const neg = b[2]!;
        const price = (i: number) => appliedPrice(s, i, p[1] ?? 1);
        let start = from;
        if (start <= period) {
          for (let i = 0; i < Math.min(period, n); i += 1) {
            rsi[i] = 0;
            pos[i] = 0;
            neg[i] = 0;
          }
          if (n <= period) break;
          let sumP = 0;
          let sumN = 0;
          for (let i = 1; i <= period; i += 1) {
            const diff = price(i) - price(i - 1);
            sumP += diff > 0 ? diff : 0;
            sumN += diff < 0 ? -diff : 0;
          }
          pos[period] = sumP / period;
          neg[period] = sumN / period;
          rsi[period] = neg[period]! !== 0 ? 100 - 100 / (1 + pos[period]! / neg[period]!) : pos[period]! !== 0 ? 100 : 50;
          start = period + 1;
        }
        for (let i = start; i < n; i += 1) {
          const diff = price(i) - price(i - 1);
          pos[i] = (pos[i - 1]! * (period - 1) + (diff > 0 ? diff : 0)) / period;
          neg[i] = (neg[i - 1]! * (period - 1) + (diff < 0 ? -diff : 0)) / period;
          rsi[i] = neg[i]! !== 0 ? 100 - 100 / (1 + pos[i]! / neg[i]!) : pos[i]! !== 0 ? 100 : 50;
        }
        break;
      }
      case 'ATR': {
        const period = Math.max(1, p[0] ?? 14);
        const atr = b[0]!;
        const tr = b[1]!;
        for (let i = from; i < n; i += 1) {
          tr[i] = i === 0 ? s.high[0]! - s.low[0]! : Math.max(s.high[i]!, s.close[i - 1]!) - Math.min(s.low[i]!, s.close[i - 1]!);
        }
        for (let i = from; i < n; i += 1) {
          if (i < period) atr[i] = 0;
          else if (i === period) {
            let sum = 0;
            for (let k = 1; k <= period; k += 1) sum += tr[k]!;
            atr[i] = sum / period;
          } else atr[i] = atr[i - 1]! + (tr[i]! - tr[i - period]!) / period;
        }
        break;
      }
      case 'ADX': {
        const period = Math.max(1, p[0] ?? 14);
        const k = 2 / (period + 1);
        const [adx, pdi, ndi, pd, nd, tmp] = b as [number[], number[], number[], number[], number[], number[]];
        for (let i = Math.max(from, 0); i < n; i += 1) {
          if (i === 0) {
            adx[0] = 0;
            pdi[0] = 0;
            ndi[0] = 0;
            pd[0] = 0;
            nd[0] = 0;
            tmp[0] = 0;
            continue;
          }
          let dmP = s.high[i]! - s.high[i - 1]!;
          let dmN = s.low[i - 1]! - s.low[i]!;
          if (dmP < 0) dmP = 0;
          if (dmN < 0) dmN = 0;
          if (dmP > dmN) dmN = 0;
          else if (dmP < dmN) dmP = 0;
          else {
            dmP = 0;
            dmN = 0;
          }
          const tr = Math.max(Math.abs(s.high[i]! - s.low[i]!), Math.abs(s.high[i]! - s.close[i - 1]!), Math.abs(s.low[i]! - s.close[i - 1]!));
          pd[i] = tr !== 0 ? (100 * dmP) / tr : 0;
          nd[i] = tr !== 0 ? (100 * dmN) / tr : 0;
          pdi[i] = pd[i]! * k + pdi[i - 1]! * (1 - k);
          ndi[i] = nd[i]! * k + ndi[i - 1]! * (1 - k);
          const sum = pdi[i]! + ndi[i]!;
          tmp[i] = sum !== 0 ? 100 * Math.abs((pdi[i]! - ndi[i]!) / sum) : 0;
          adx[i] = tmp[i]! * k + adx[i - 1]! * (1 - k);
        }
        break;
      }
      case 'ADXW': {
        const period = Math.max(1, p[0] ?? 14);
        const [adx, pdi, ndi, trS, pS, nS, dx] = b as [number[], number[], number[], number[], number[], number[], number[]];
        for (let i = Math.max(from, 0); i < n; i += 1) {
          if (i === 0) {
            adx[0] = pdi[0] = ndi[0] = trS[0] = pS[0] = nS[0] = dx[0] = 0;
            continue;
          }
          const up = s.high[i]! - s.high[i - 1]!;
          const down = s.low[i - 1]! - s.low[i]!;
          const dmP = up > down && up > 0 ? up : 0;
          const dmN = down > up && down > 0 ? down : 0;
          const tr = Math.max(s.high[i]!, s.close[i - 1]!) - Math.min(s.low[i]!, s.close[i - 1]!);
          if (i <= period) {
            trS[i] = trS[i - 1]! + tr;
            pS[i] = pS[i - 1]! + dmP;
            nS[i] = nS[i - 1]! + dmN;
          } else {
            trS[i] = trS[i - 1]! - trS[i - 1]! / period + tr;
            pS[i] = pS[i - 1]! - pS[i - 1]! / period + dmP;
            nS[i] = nS[i - 1]! - nS[i - 1]! / period + dmN;
          }
          pdi[i] = trS[i]! !== 0 ? (100 * pS[i]!) / trS[i]! : 0;
          ndi[i] = trS[i]! !== 0 ? (100 * nS[i]!) / trS[i]! : 0;
          const sum = pdi[i]! + ndi[i]!;
          dx[i] = sum !== 0 ? (100 * Math.abs(pdi[i]! - ndi[i]!)) / sum : 0;
          if (i < 2 * period) {
            let acc = 0;
            let count = 0;
            for (let k = Math.max(period, 1); k <= i; k += 1) {
              acc += dx[k]!;
              count += 1;
            }
            adx[i] = count > 0 ? acc / count : 0;
          } else {
            adx[i] = (adx[i - 1]! * (period - 1) + dx[i]!) / period;
          }
        }
        break;
      }
      case 'BANDS': {
        const period = Math.max(1, p[0] ?? 20);
        const dev = p[2] ?? 2;
        const src = this.scratch('src');
        for (let i = from; i < n; i += 1) src[i] = appliedPrice(s, i, p[3] ?? 1);
        maOnArray(src, b[0]!, from, n, period, 0);
        for (let i = from; i < n; i += 1) {
          if (i < period - 1) {
            b[1]![i] = 0;
            b[2]![i] = 0;
            continue;
          }
          let sq = 0;
          for (let k = 0; k < period; k += 1) sq += (src[i - k]! - b[0]![i]!) ** 2;
          const sd = Math.sqrt(sq / period);
          b[1]![i] = b[0]![i]! + dev * sd;
          b[2]![i] = b[0]![i]! - dev * sd;
        }
        break;
      }
      case 'MACD':
      case 'OSMA': {
        const src = this.scratch('src');
        for (let i = from; i < n; i += 1) src[i] = appliedPrice(s, i, p[3] ?? 1);
        const fast = this.scratch('fast');
        const slow = this.scratch('slow');
        const main = this.spec.kind === 'MACD' ? b[0]! : this.scratch('main');
        const signal = this.spec.kind === 'MACD' ? b[1]! : this.scratch('signal');
        maOnArray(src, fast, from, n, p[0] ?? 12, 1);
        maOnArray(src, slow, from, n, p[1] ?? 26, 1);
        for (let i = from; i < n; i += 1) main[i] = fast[i]! - slow[i]!;
        maOnArray(main, signal, from, n, p[2] ?? 9, 0);
        if (this.spec.kind === 'OSMA') for (let i = from; i < n; i += 1) b[0]![i] = main[i]! - signal[i]!;
        break;
      }
      case 'STOCH': {
        const kp = Math.max(1, p[0] ?? 5);
        const dp = Math.max(1, p[1] ?? 3);
        const slowing = Math.max(1, p[2] ?? 3);
        const method = p[3] ?? 0;
        const closeClose = (p[4] ?? 0) === 1;
        const [main, signal, highes, lowes] = b as [number[], number[], number[], number[]];
        for (let i = from; i < n; i += 1) {
          if (i < kp - 1) {
            highes[i] = 0;
            lowes[i] = 0;
            continue;
          }
          let hi = -Infinity;
          let lo = Infinity;
          for (let k = 0; k < kp; k += 1) {
            const h = closeClose ? s.close[i - k]! : s.high[i - k]!;
            const l = closeClose ? s.close[i - k]! : s.low[i - k]!;
            if (h > hi) hi = h;
            if (l < lo) lo = l;
          }
          highes[i] = hi;
          lowes[i] = lo;
        }
        const first = kp - 1 + slowing - 1;
        for (let i = from; i < n; i += 1) {
          if (i < first) {
            main[i] = 0;
            continue;
          }
          let sumLow = 0;
          let sumHigh = 0;
          for (let k = 0; k < slowing; k += 1) {
            sumLow += s.close[i - k]! - lowes[i - k]!;
            sumHigh += highes[i - k]! - lowes[i - k]!;
          }
          main[i] = sumHigh === 0 ? 100 : (sumLow / sumHigh) * 100;
        }
        maOnArray(main, signal, from, n, dp, method, first);
        break;
      }
      case 'CCI': {
        const period = Math.max(1, p[0] ?? 14);
        const src = b[1]!;
        const sma = b[2]!;
        for (let i = from; i < n; i += 1) src[i] = appliedPrice(s, i, p[1] ?? 6);
        maOnArray(src, sma, from, n, period, 0);
        for (let i = from; i < n; i += 1) {
          if (i < period - 1) {
            b[0]![i] = 0;
            continue;
          }
          let dev = 0;
          for (let k = 0; k < period; k += 1) dev += Math.abs(src[i - k]! - sma[i]!);
          dev = (dev * 0.015) / period;
          b[0]![i] = dev !== 0 ? (src[i]! - sma[i]!) / dev : 0;
        }
        break;
      }
      case 'MOMENTUM': {
        const period = Math.max(1, p[0] ?? 14);
        for (let i = from; i < n; i += 1) {
          if (i < period) {
            b[0]![i] = 0;
            continue;
          }
          const past = appliedPrice(s, i - period, p[1] ?? 1);
          b[0]![i] = past !== 0 ? (appliedPrice(s, i, p[1] ?? 1) * 100) / past : 0;
        }
        break;
      }
      case 'WPR': {
        const period = Math.max(1, p[0] ?? 14);
        for (let i = from; i < n; i += 1) {
          if (i < period - 1) {
            b[0]![i] = 0;
            continue;
          }
          let hi = -Infinity;
          let lo = Infinity;
          for (let k = 0; k < period; k += 1) {
            hi = Math.max(hi, s.high[i - k]!);
            lo = Math.min(lo, s.low[i - k]!);
          }
          b[0]![i] = hi !== lo ? (-100 * (hi - s.close[i]!)) / (hi - lo) : i > 0 ? b[0]![i - 1]! : 0;
        }
        break;
      }
      case 'SAR': {
        const step = p[0] ?? 0.02;
        const maxStep = p[1] ?? 0.2;
        const [sar, trendBuf, epBuf, afBuf] = [b[0]!, b[1]!, b[2]!, b[3]!];
        for (let i = Math.max(from, 0); i < n; i += 1) {
          if (i === 0) {
            sar[0] = s.low[0]!;
            trendBuf[0] = 1;
            epBuf[0] = s.high[0]!;
            afBuf[0] = step;
            continue;
          }
          let trend = trendBuf[i - 1]!;
          let ep = epBuf[i - 1]!;
          let af = afBuf[i - 1]!;
          let value = sar[i - 1]! + af * (ep - sar[i - 1]!);
          if (trend > 0) {
            value = Math.min(value, s.low[i - 1]!, i > 1 ? s.low[i - 2]! : s.low[i - 1]!);
            if (s.low[i]! < value) {
              trend = -1;
              value = ep;
              ep = s.low[i]!;
              af = step;
            } else if (s.high[i]! > ep) {
              ep = s.high[i]!;
              af = Math.min(maxStep, af + step);
            }
          } else {
            value = Math.max(value, s.high[i - 1]!, i > 1 ? s.high[i - 2]! : s.high[i - 1]!);
            if (s.high[i]! > value) {
              trend = 1;
              value = ep;
              ep = s.high[i]!;
              af = step;
            } else if (s.low[i]! < ep) {
              ep = s.low[i]!;
              af = Math.min(maxStep, af + step);
            }
          }
          sar[i] = value;
          trendBuf[i] = trend;
          epBuf[i] = ep;
          afBuf[i] = af;
        }
        break;
      }
      case 'ENVELOPES': {
        const src = this.scratch('src');
        const ma = this.scratch('ma');
        for (let i = from; i < n; i += 1) src[i] = appliedPrice(s, i, p[3] ?? 1);
        maOnArray(src, ma, from, n, p[0] ?? 14, p[2] ?? 0);
        const dev = (p[4] ?? 0.1) / 100;
        for (let i = from; i < n; i += 1) {
          b[0]![i] = ma[i]! * (1 + dev);
          b[1]![i] = ma[i]! * (1 - dev);
        }
        break;
      }
      case 'STDDEV': {
        const period = Math.max(1, p[0] ?? 20);
        const src = this.scratch('src');
        const ma = this.scratch('ma');
        for (let i = from; i < n; i += 1) src[i] = appliedPrice(s, i, p[3] ?? 1);
        maOnArray(src, ma, from, n, period, p[2] ?? 0);
        for (let i = from; i < n; i += 1) {
          if (i < period - 1) {
            b[0]![i] = 0;
            continue;
          }
          let sq = 0;
          for (let k = 0; k < period; k += 1) sq += (src[i - k]! - ma[i]!) ** 2;
          b[0]![i] = Math.sqrt(sq / period);
        }
        break;
      }
      case 'AO':
      case 'AC': {
        const median = this.scratch('median');
        const fast = this.scratch('fast');
        const slow = this.scratch('slow');
        for (let i = from; i < n; i += 1) median[i] = (s.high[i]! + s.low[i]!) / 2;
        maOnArray(median, fast, from, n, 5, 0);
        maOnArray(median, slow, from, n, 34, 0);
        const ao = this.spec.kind === 'AO' ? b[0]! : b[1]!;
        for (let i = from; i < n; i += 1) ao[i] = i < 33 ? 0 : fast[i]! - slow[i]!;
        if (this.spec.kind === 'AC') {
          const aoMa = this.scratch('aoMa');
          maOnArray(ao, aoMa, from, n, 5, 0, 33);
          for (let i = from; i < n; i += 1) b[0]![i] = i < 37 ? 0 : ao[i]! - aoMa[i]!;
        }
        break;
      }
      case 'DEMA':
      case 'TEMA': {
        const period = p[0] ?? 14;
        const src = this.scratch('src');
        for (let i = from; i < n; i += 1) src[i] = appliedPrice(s, i, p[2] ?? 1);
        const e1 = b[1]!;
        const e2 = b[2]!;
        maOnArray(src, e1, from, n, period, 1);
        maOnArray(e1, e2, from, n, period, 1);
        if (this.spec.kind === 'DEMA') {
          for (let i = from; i < n; i += 1) b[0]![i] = 2 * e1[i]! - e2[i]!;
        } else {
          const e3 = b[3]!;
          maOnArray(e2, e3, from, n, period, 1);
          for (let i = from; i < n; i += 1) b[0]![i] = 3 * e1[i]! - 3 * e2[i]! + e3[i]!;
        }
        break;
      }
      case 'MFI': {
        const period = Math.max(1, p[0] ?? 14);
        const tp = b[1]!;
        for (let i = from; i < n; i += 1) tp[i] = (s.high[i]! + s.low[i]! + s.close[i]!) / 3;
        const vol = (i: number) => ((p[1] ?? 0) === 1 ? s.realVolume[i]! : s.tickVolume[i]!);
        for (let i = from; i < n; i += 1) {
          if (i < period) {
            b[0]![i] = 0;
            continue;
          }
          let posFlow = 0;
          let negFlow = 0;
          for (let k = 0; k < period; k += 1) {
            const j = i - k;
            if (tp[j]! > tp[j - 1]!) posFlow += tp[j]! * vol(j);
            else if (tp[j]! < tp[j - 1]!) negFlow += tp[j]! * vol(j);
          }
          b[0]![i] = negFlow !== 0 ? 100 - 100 / (1 + posFlow / negFlow) : 100;
        }
        break;
      }
      case 'OBV': {
        const vol = (i: number) => ((p[0] ?? 0) === 1 ? s.realVolume[i]! : s.tickVolume[i]!);
        for (let i = from; i < n; i += 1) {
          if (i === 0) {
            b[0]![0] = vol(0);
            continue;
          }
          const c = s.close[i]!;
          const prev = s.close[i - 1]!;
          b[0]![i] = b[0]![i - 1]! + (c > prev ? vol(i) : c < prev ? -vol(i) : 0);
        }
        break;
      }
      case 'FORCE': {
        const raw = b[1]!;
        const vol = (i: number) => ((p[2] ?? 0) === 1 ? s.realVolume[i]! : s.tickVolume[i]!);
        for (let i = from; i < n; i += 1) raw[i] = i === 0 ? 0 : (s.close[i]! - s.close[i - 1]!) * vol(i);
        maOnArray(raw, b[0]!, from, n, p[0] ?? 13, p[1] ?? 0, 1);
        break;
      }
      case 'DEMARKER': {
        const period = Math.max(1, p[0] ?? 14);
        const max = b[1]!;
        const min = b[2]!;
        for (let i = from; i < n; i += 1) {
          max[i] = i === 0 ? 0 : Math.max(0, s.high[i]! - s.high[i - 1]!);
          min[i] = i === 0 ? 0 : Math.max(0, s.low[i - 1]! - s.low[i]!);
        }
        for (let i = from; i < n; i += 1) {
          if (i < period) {
            b[0]![i] = 0;
            continue;
          }
          let sMax = 0;
          let sMin = 0;
          for (let k = 0; k < period; k += 1) {
            sMax += max[i - k]!;
            sMin += min[i - k]!;
          }
          b[0]![i] = sMax + sMin !== 0 ? sMax / (sMax + sMin) : 0;
        }
        break;
      }
      case 'BULLS':
      case 'BEARS': {
        const ema = b[1]!;
        const close = this.scratch('close');
        for (let i = from; i < n; i += 1) close[i] = s.close[i]!;
        maOnArray(close, ema, from, n, p[0] ?? 13, 1);
        for (let i = from; i < n; i += 1) b[0]![i] = this.spec.kind === 'BULLS' ? s.high[i]! - ema[i]! : s.low[i]! - ema[i]!;
        break;
      }
      case 'ICHIMOKU': {
        const [tenkanP, kijunP, senkouP] = [p[0] ?? 9, p[1] ?? 26, p[2] ?? 52];
        const mid = (i: number, len: number): number => {
          let hi = -Infinity;
          let lo = Infinity;
          for (let k = 0; k < len && i - k >= 0; k += 1) {
            hi = Math.max(hi, s.high[i - k]!);
            lo = Math.min(lo, s.low[i - k]!);
          }
          return (hi + lo) / 2;
        };
        for (let i = from; i < n; i += 1) {
          b[0]![i] = mid(i, tenkanP);
          b[1]![i] = mid(i, kijunP);
          b[2]![i] = (b[0]![i]! + b[1]![i]!) / 2;
          b[3]![i] = mid(i, senkouP);
          b[4]![i] = s.close[i]!;
        }
        break;
      }
      case 'ALLIGATOR': {
        const median = this.scratch('median');
        for (let i = from; i < n; i += 1) median[i] = appliedPrice(s, i, p[7] ?? 5);
        const method = p[6] ?? 2;
        maOnArray(median, b[0]!, from, n, p[0] ?? 13, method);
        maOnArray(median, b[1]!, from, n, p[2] ?? 8, method);
        maOnArray(median, b[2]!, from, n, p[4] ?? 5, method);
        break;
      }
      case 'FRACTALS': {
        // A fractal needs two bars on each side, so the last two stay unknown.
        const start = Math.max(0, from - 2);
        for (let i = start; i < n; i += 1) {
          b[0]![i] = EMPTY;
          b[1]![i] = EMPTY;
          if (i < 2 || i > n - 3) continue;
          const h = s.high[i]!;
          const l = s.low[i]!;
          if (h > s.high[i - 1]! && h > s.high[i - 2]! && h >= s.high[i + 1]! && h >= s.high[i + 2]!) b[0]![i] = h;
          if (l < s.low[i - 1]! && l < s.low[i - 2]! && l <= s.low[i + 1]! && l <= s.low[i + 2]!) b[1]![i] = l;
        }
        break;
      }
      case 'VOLUMES': {
        for (let i = from; i < n; i += 1) b[0]![i] = (p[0] ?? 0) === 1 ? s.realVolume[i]! : s.tickVolume[i]!;
        break;
      }
    }
  }
}
