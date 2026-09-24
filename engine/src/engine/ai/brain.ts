import {
  AI_EXPERTS,
  AI_REGIMES,
  AI_REGIME_LABELS,
  type AiDanger,
  type AiExpertName,
  type AiLearning,
  type AiReading,
  type AiRegime,
  type Candle,
  type Side,
  type Tick,
} from '@sentinal/shared';
import {
  adx,
  atr,
  bollinger,
  clamp,
  donchian,
  efficiency,
  ema,
  meanRange,
  percentileRank,
  rsi,
  sigmoid,
  type Series,
} from './indicators.js';

const EXPERTS: AiExpertName[] = AI_EXPERTS.map((e) => e.name);
const NE = EXPERTS.length;
const NR = AI_REGIMES.length;
const IX = Object.fromEntries(EXPERTS.map((name, i) => [name, i])) as Record<AiExpertName, number>;

/** Bars needed before the AI will name a direction. */
export const WARMUP_BARS = 60;
const MAX_BARS = 3000;
/** Logistic inputs: bias, the vote, and the vote again per kind of market. */
const NZ = 6;
/**
 * Prior belief about the calibration before any evidence: no bias, a mild
 * edge in the experts' vote, nothing regime-specific. The precisions say how
 * firmly: the bias is held near zero, the slopes give way to a few hundred
 * scored bars.
 */
const PRIOR_MEAN = [0, 1.5, 0, 0, 0, 0];
const PRIOR_PRECISION = [50, 3, 3, 3, 3, 3];
/** Scored bars the calibration is fitted on. */
const CALIBRATION_WINDOW = 500;

/**
 * Where each regime's weights start, before any learning: trends favour the
 * trend-following experts, ranges the faders, volatile markets the tape.
 * Order follows AI_EXPERTS: trend, momentum, breakout, reversion, squeeze,
 * flow, candles, session.
 */
const PRIORS: Record<AiRegime, number[]> = {
  'trend-up': [3, 2, 2, 0.5, 1, 1.5, 1, 0.5],
  'trend-down': [3, 2, 2, 0.5, 1, 1.5, 1, 0.5],
  range: [0.7, 0.8, 0.7, 3, 1, 1.5, 2, 0.8],
  volatile: [1.5, 1.5, 2, 0.8, 1, 2.5, 1, 0.3],
  quiet: [1, 1, 1, 2, 2.5, 1, 1.5, 1],
};

interface Bar {
  minute: number;
  open: number;
  high: number;
  low: number;
  close: number;
  ticks: number;
  up: number;
  down: number;
}

/** A prediction waiting for its horizon to pass so it can be scored. */
interface Pending {
  index: number;
  horizon: number;
  minute: number;
  close: number;
  atr: number;
  regime: number;
  scores: number[];
  z: number[];
  p: number;
  hour: number;
}

interface Snapshot {
  close: number;
  atr: number;
  adx: number;
  er: number;
  volRatio: number;
  regime: AiRegime;
  scores: number[];
  ensemble: number;
  z: number[];
  p: number;
  width: number;
}

/** Everything the AI has learned, small enough to keep in a browser. */
export interface BrainState {
  v: 1;
  weights: number[][];
  beta: number[];
  hourDrift: number[];
  hourCount: number[];
  hit: number[];
  hitCount: number[];
  accuracy: number;
  accuracyCount: number;
  confAccuracy: number;
  confCount: number;
  edge: number;
  edgeCount: number;
  samples: number;
  trades: number;
  winRate: number;
  expectancyR: number;
  regimeExp: number[];
  regimeCount: number[];
  lossStreak: number;
  learnedThrough: number;
  updatedAt: number;
  /** The calibration window: inputs, outcome and weight of each scored bar. */
  calib?: [number[], number, number][];
}

export interface TradeLesson {
  regime: AiRegime;
  side: Side;
  /** Result in units of the initial risk: +1.5 is one and a half times what was risked. */
  r: number;
}

/** Running mean for the first samples, then an exponential average. */
function blend(prev: number, x: number, count: number, alpha: number): number {
  return count < 1 / alpha ? prev + (x - prev) / Math.max(1, count) : prev + alpha * (x - prev);
}

function normalise(w: number[]): number[] {
  const sum = w.reduce((a, b) => a + b, 0);
  return sum > 0 ? w.map((v) => v / sum) : w.map(() => 1 / w.length);
}

/** Solves a small symmetric positive-definite system by Gaussian elimination; null if singular. */
function solve(a: number[][], rhs: number[]): number[] | null {
  const n = rhs.length;
  const m = a.map((row, i) => [...row, rhs[i]!]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < n; r += 1) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    if (Math.abs(m[pivot]![col]!) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const f = m[r]![col]! / m[col]![col]!;
      if (f === 0) continue;
      for (let c = col; c <= n; c += 1) m[r]![c] = m[r]![c]! - f * m[col]![c]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

function regimeIndex(regime: AiRegime): number {
  return AI_REGIMES.indexOf(regime);
}

/**
 * The AI's model of the market.
 *
 * It keeps its own one-minute bars from history and live quotes. On every
 * closed bar it classifies the kind of market, asks eight experts for a
 * score between −1 (sell) and +1 (buy), combines them with the weights it
 * holds for that kind of market, calibrates the vote into a probability,
 * and files the prediction. When the prediction's horizon has passed it is
 * scored against what price actually did: experts that were right gain
 * weight in that regime (multiplicative weights with a fixed share, so a
 * sidelined expert can come back when the market changes), the calibration
 * is nudged by a gradient step, and its hit rates are updated. Closed trades
 * teach it too: losing streaks and regimes that keep losing raise the
 * probability it asks for before trading.
 */
export class MarketBrain {
  private bars: Bar[] = [];
  private readonly s: Series = { open: [], high: [], low: [], close: [] };
  private minutes: number[] = [];
  private widths: number[] = [];
  private forming: Bar | null = null;
  private pending: Pending[] = [];

  /* Tape statistics, live only. */
  private lastMid = 0;
  private flow: { time: number; dir: number }[] = [];
  private tickTimes: number[] = [];
  private spreadAvg = 0;
  private spreadNow = 0;
  private jump = { size: 0, time: 0 };
  private lastTickTime = 0;

  /* What it has learned. */
  private weights: number[][] = AI_REGIMES.map((r) => normalise(PRIORS[r]));
  private beta: number[] = [...PRIOR_MEAN];
  /** Recent scored predictions, for fitting the calibration: inputs, outcome, weight. */
  private calib: { z: number[]; y: number; w: number }[] = [];
  private sinceFit = 0;
  private hourDrift: number[] = new Array(24).fill(0);
  private hourCount: number[] = new Array(24).fill(0);
  private hit: number[] = new Array(NE).fill(0.5);
  private hitCount: number[] = new Array(NE).fill(0);
  private accuracy = 0.5;
  private accuracyCount = 0;
  private confAccuracy = 0.5;
  private confCount = 0;
  /** Accuracy over a long window (~200 scored bars): the evidence of a real edge. */
  private edge = 0.5;
  private edgeCount = 0;
  private samples = 0;
  private trades = 0;
  private winRate = 0;
  private expectancyR = 0;
  private regimeExp: number[] = new Array(NR).fill(0);
  private regimeCount: number[] = new Array(NR).fill(0);
  private lossStreak = 0;
  private learnedThrough = 0;
  private updatedAt: number | null = null;

  /* Settings the bot passes in. */
  private horizon = 5;
  private eta = 0.3;

  private cached: { at: number; minProbability: number; reading: AiReading } | null = null;

  /** New learning settings; predictions already filed keep their own horizon. */
  configure(opts: { horizonBars?: number; learningRate?: number }): void {
    if (opts.horizonBars !== undefined) this.horizon = clamp(Math.round(opts.horizonBars), 1, 60);
    if (opts.learningRate !== undefined) this.eta = clamp(opts.learningRate, 0.01, 2);
  }

  get barCount(): number {
    return this.bars.length;
  }

  get ready(): boolean {
    return this.bars.length >= WARMUP_BARS;
  }

  /* --------------------------------------------------------------- */
  /* Data in                                                          */
  /* --------------------------------------------------------------- */

  /**
   * Learns from history: every bar is replayed as if it had just closed, so
   * the weights and the calibration are fitted before the first trade. The
   * last candle is taken as the bar still forming.
   */
  prime(candles: Candle[]): void {
    const sorted = [...candles].sort((a, b) => a.time - b.time);
    const lastMinute = this.forming?.minute ?? this.minutes[this.minutes.length - 1] ?? -Infinity;
    const fresh = sorted.filter((c) => Math.floor(c.time / 60_000) > lastMinute);
    if (fresh.length === 0) return;
    if (this.forming) {
      this.closeBar(this.forming);
      this.forming = null;
    }
    for (let i = 0; i < fresh.length; i += 1) {
      const c = fresh[i]!;
      const bar: Bar = { minute: Math.floor(c.time / 60_000), open: c.open, high: c.high, low: c.low, close: c.close, ticks: 0, up: 0, down: 0 };
      if (i === fresh.length - 1) this.forming = bar;
      else this.closeBar(bar);
    }
    this.cached = null;
  }

  update(tick: Tick): void {
    const mid = (tick.bid + tick.ask) / 2;
    const minute = Math.floor(tick.time / 60_000);
    if (this.forming && minute < this.forming.minute) return;
    if (this.forming && minute > this.forming.minute) {
      this.closeBar(this.forming);
      this.forming = null;
    }
    const dir = this.lastMid > 0 ? Math.sign(mid - this.lastMid) : 0;
    if (!this.forming) {
      this.forming = { minute, open: mid, high: mid, low: mid, close: mid, ticks: 0, up: 0, down: 0 };
    }
    const bar = this.forming;
    bar.high = Math.max(bar.high, mid);
    bar.low = Math.min(bar.low, mid);
    bar.close = mid;
    bar.ticks += 1;
    if (dir > 0) bar.up += 1;
    else if (dir < 0) bar.down += 1;

    // The tape: direction of each quote, how often they come, how wide the spread is.
    if (dir !== 0) this.flow.push({ time: tick.time, dir });
    while (this.flow.length > 0 && tick.time - this.flow[0]!.time > 60_000) this.flow.shift();
    this.tickTimes.push(tick.time);
    while (this.tickTimes.length > 0 && tick.time - this.tickTimes[0]! > 120_000) this.tickTimes.shift();
    this.spreadNow = Math.max(0, tick.ask - tick.bid);
    this.spreadAvg = this.spreadAvg > 0 ? this.spreadAvg + 0.02 * (this.spreadNow - this.spreadAvg) : this.spreadNow;
    const a = this.currentAtr();
    if (this.lastMid > 0 && a > 0) {
      const size = Math.abs(mid - this.lastMid) / a;
      if (size > this.jump.size || tick.time - this.jump.time > 30_000) this.jump = { size, time: tick.time };
    }
    this.lastMid = mid;
    this.lastTickTime = tick.time;
  }

  private currentAtr(): number {
    return this.s.close.length > 1 ? atr(this.s, 14) : 0;
  }

  private closeBar(bar: Bar): void {
    const last = this.minutes[this.minutes.length - 1];
    if (last !== undefined && bar.minute <= last) return;
    this.bars.push(bar);
    this.minutes.push(bar.minute);
    this.s.open.push(bar.open);
    this.s.high.push(bar.high);
    this.s.low.push(bar.low);
    this.s.close.push(bar.close);
    this.widths.push(bollinger(this.s.close, 20, 2).width);
    if (this.bars.length > MAX_BARS) {
      const cut = this.bars.length - MAX_BARS;
      this.bars.splice(0, cut);
      this.minutes.splice(0, cut);
      this.s.open.splice(0, cut);
      this.s.high.splice(0, cut);
      this.s.low.splice(0, cut);
      this.s.close.splice(0, cut);
      this.widths.splice(0, cut);
      for (const p of this.pending) p.index -= cut;
    }
    this.onBarClosed(bar);
  }

  /* --------------------------------------------------------------- */
  /* Learning                                                         */
  /* --------------------------------------------------------------- */

  private onBarClosed(bar: Bar): void {
    const index = this.bars.length - 1;
    // Score every prediction whose horizon has now passed.
    const due = this.pending.filter((p) => index - p.index >= p.horizon);
    if (due.length > 0) {
      this.pending = this.pending.filter((p) => index - p.index < p.horizon);
      for (const p of due) this.learn(p, bar);
    }
    if (this.bars.length < 30) return;
    const snap = this.evaluate(false, bar);
    this.pending.push({
      index,
      horizon: this.horizon,
      minute: bar.minute,
      close: bar.close,
      atr: snap.atr,
      regime: regimeIndex(snap.regime),
      scores: snap.scores,
      z: snap.z,
      p: snap.p,
      hour: new Date(bar.minute * 60_000).getUTCHours(),
    });
    if (this.pending.length > 200) this.pending.shift();
    this.cached = null;
  }

  private learn(p: Pending, outcome: Bar): void {
    // A replay of history the saved model has already learned is not learned twice.
    if (outcome.minute <= this.learnedThrough || p.atr <= 0) return;
    this.learnedThrough = outcome.minute;
    const ret = (outcome.close - p.close) / p.atr;
    const r = clamp(ret, -2, 2);

    // Experts that called it gain weight in that kind of market.
    const w = this.weights[p.regime]!;
    for (let i = 0; i < NE; i += 1) w[i] = w[i]! * Math.exp(this.eta * 0.5 * p.scores[i]! * r);
    const norm = normalise(w);
    const share = 0.01;
    this.weights[p.regime] = norm.map((v) => (1 - share) * v + share / NE);

    // Hit rates, on calls that were made with some conviction and moves worth scoring.
    if (Math.abs(ret) >= 0.1) {
      for (let i = 0; i < NE; i += 1) {
        if (Math.abs(p.scores[i]!) < 0.25) continue;
        this.hitCount[i] = this.hitCount[i]! + 1;
        const right = Math.sign(p.scores[i]!) === Math.sign(ret) ? 1 : 0;
        this.hit[i] = blend(this.hit[i]!, right, this.hitCount[i]!, 0.02);
      }
      const right = (p.p - 0.5) * ret > 0 ? 1 : 0;
      this.accuracyCount += 1;
      this.accuracy = blend(this.accuracy, right, this.accuracyCount, 0.02);
      this.edgeCount += 1;
      this.edge = blend(this.edge, right, this.edgeCount, 0.005);
      if (Math.abs(2 * p.p - 1) >= 0.2) {
        this.confCount += 1;
        this.confAccuracy = blend(this.confAccuracy, right, this.confCount, 0.03);
      }
    }

    // Calibration: file the outcome, weighted by the size of the move, and
    // refit on the recent window every ten scored bars.
    if (Math.abs(ret) >= 0.05) {
      this.calib.push({ z: p.z, y: ret > 0 ? 1 : 0, w: Math.min(1, Math.abs(ret) / 0.5) });
      if (this.calib.length > CALIBRATION_WINDOW) this.calib.shift();
      this.sinceFit += 1;
      if (this.sinceFit >= 10) this.refit();
    }

    // What this hour of the day tends to do.
    this.hourCount[p.hour] = this.hourCount[p.hour]! + 1;
    this.hourDrift[p.hour] = blend(this.hourDrift[p.hour]!, r, this.hourCount[p.hour]!, 0.03);
    this.samples += 1;
  }

  /**
   * Fits the calibration exactly on the recent window: Bayesian logistic
   * regression with a Gaussian prior, solved by Newton's method. On a market
   * with no edge the slope falls toward zero and the AI abstains; on one with
   * an edge the evidence outweighs the prior.
   */
  private refit(): void {
    this.sinceFit = 0;
    let b = [...this.beta];
    for (let iter = 0; iter < 6; iter += 1) {
      const g = new Array<number>(NZ).fill(0);
      const h = Array.from({ length: NZ }, () => new Array<number>(NZ).fill(0));
      for (const sample of this.calib) {
        let v = 0;
        for (let k = 0; k < NZ; k += 1) v += b[k]! * sample.z[k]!;
        const prob = sigmoid(v);
        const resid = sample.w * (sample.y - prob);
        const curv = sample.w * prob * (1 - prob);
        for (let j = 0; j < NZ; j += 1) {
          const zj = sample.z[j]!;
          if (zj === 0) continue;
          g[j] = g[j]! + resid * zj;
          for (let k = 0; k < NZ; k += 1) h[j]![k] = h[j]![k]! + curv * zj * sample.z[k]!;
        }
      }
      for (let k = 0; k < NZ; k += 1) {
        g[k] = g[k]! - PRIOR_PRECISION[k]! * (b[k]! - PRIOR_MEAN[k]!);
        h[k]![k] = h[k]![k]! + PRIOR_PRECISION[k]!;
      }
      const step = solve(h, g);
      if (!step) break;
      b = b.map((v, k) => v + step[k]!);
      if (step.every((d) => Math.abs(d) < 1e-6)) break;
    }
    // A lean must come from the vote, not from assuming the last hour's drift carries on …
    b[0] = clamp(b[0]!, -0.25, 0.25);
    // … a vote with no edge behind it may fade to nothing …
    b[1] = clamp(b[1]!, 0, 8);
    // … and a stronger vote for up never means a lower chance of up, in any market.
    for (let k = 2; k < NZ; k += 1) b[k] = clamp(b[k]!, -b[1]!, 6);
    this.beta = b;
  }

  /** A closed AI trade: streaks and losing regimes raise the bar for the next one. */
  recordTrade(lesson: TradeLesson): void {
    this.trades += 1;
    const win = lesson.r > 0 ? 1 : 0;
    this.winRate = blend(this.winRate, win, this.trades, 0.05);
    this.expectancyR = blend(this.expectancyR, clamp(lesson.r, -3, 5), this.trades, 0.05);
    const ri = regimeIndex(lesson.regime);
    this.regimeCount[ri] = this.regimeCount[ri]! + 1;
    this.regimeExp[ri] = blend(this.regimeExp[ri]!, clamp(lesson.r, -3, 5), this.regimeCount[ri]!, 0.1);
    this.lossStreak = win ? 0 : this.lossStreak + 1;
    this.cached = null;
  }

  /** Claude's nudge: scale an expert's say in every regime (0.5 halves it, 1.5 raises it by half). */
  nudge(multipliers: Partial<Record<AiExpertName, number>>): void {
    for (let r = 0; r < NR; r += 1) {
      const w = [...this.weights[r]!];
      for (const [name, m] of Object.entries(multipliers) as [AiExpertName, number][]) {
        const i = IX[name];
        if (i === undefined || !Number.isFinite(m)) continue;
        w[i] = w[i]! * clamp(m, 0.25, 2);
      }
      this.weights[r] = normalise(w);
    }
    this.cached = null;
  }

  /**
   * The probability it asks for before trading: raised by losing streaks, by
   * regimes that keep losing, and when its predictions have not been beating
   * a coin toss over the last couple of hundred bars.
   */
  threshold(minProbability: number, regime: AiRegime): number {
    let t = minProbability;
    if (this.edgeCount >= 150) {
      if (this.edge < 0.5) t += 0.1;
      else if (this.edge < 0.52) t += 0.05;
    }
    if (this.lossStreak >= 2) t += Math.min(0.08, 0.02 * (this.lossStreak - 1));
    const ri = regimeIndex(regime);
    if (this.regimeCount[ri]! >= 6) {
      if (this.regimeExp[ri]! < -0.3) t += 0.1;
      else if (this.regimeExp[ri]! < -0.1) t += 0.05;
    }
    return clamp(t, 0.5, 0.95);
  }

  /* --------------------------------------------------------------- */
  /* Reading the market                                               */
  /* --------------------------------------------------------------- */

  private dot(z: number[]): number {
    let v = 0;
    for (let k = 0; k < NZ; k += 1) v += this.beta[k]! * z[k]!;
    return v;
  }

  /** Closes on five-minute bars, from the tail of the one-minute ones. */
  private m5(end: number): number[] {
    const out: number[] = [];
    let bucket = Number.NaN;
    const from = Math.max(0, end - 5 * 21 * 4);
    for (let i = from; i < end; i += 1) {
      const b = Math.floor(this.minutes[i]! / 5);
      if (b === bucket) out[out.length - 1] = this.s.close[i]!;
      else {
        out.push(this.s.close[i]!);
        bucket = b;
      }
    }
    return out;
  }

  /**
   * Scores the market on the bars up to now. With `live` the forming bar is
   * included as the latest; otherwise `closed` is the bar that just closed.
   */
  private evaluate(live: boolean, closed?: Bar): Snapshot {
    const s = this.s;
    let pushed = false;
    const current = live ? this.forming : closed;
    if (live && this.forming) {
      s.open.push(this.forming.open);
      s.high.push(this.forming.high);
      s.low.push(this.forming.low);
      s.close.push(this.forming.close);
      this.minutes.push(this.forming.minute);
      pushed = true;
    }
    try {
      const n = s.close.length;
      const close = s.close[n - 1] ?? 0;
      const a = Math.max(atr(s, 14), 1e-9);
      const longRange = meanRange(s, 200);
      const volRatio = longRange > 0 ? a / longRange : 1;
      const adxV = adx(s, 14);
      const er = efficiency(s.close, 20);
      const e9 = ema(s.close, 9);
      const e21 = ema(s.close, 21);
      const regime: AiRegime =
        volRatio > 1.8
          ? 'volatile'
          : er > 0.35 && adxV > 20
            ? e9 >= e21
              ? 'trend-up'
              : 'trend-down'
            : volRatio < 0.65 && er < 0.25
              ? 'quiet'
              : 'range';

      const scores = new Array<number>(NE).fill(0);

      // Trend: fast over slow on M1, and on M5.
      const m1 = Math.tanh(((e9 - e21) / a) * 1.5);
      const closes5 = this.m5(n);
      const m5 = closes5.length >= 8 ? Math.tanh(((ema(closes5, 8) - ema(closes5, 21)) / (a * 2.2)) * 1.2) : 0;
      scores[IX.trend] = clamp(0.55 * m1 + 0.45 * m5, -1, 1);

      // Momentum: where price is against ten bars ago, and RSI.
      const rsiV = rsi(s.close, 14);
      const roc = n > 10 ? (close - s.close[n - 11]!) / a : 0;
      scores[IX.momentum] = clamp(Math.tanh(0.5 * roc) * 0.6 + ((rsiV - 50) / 50) * 0.4, -1, 1);

      // Breakout: a close beyond the prior 20-bar range.
      const dc = donchian(s, 20);
      if (Number.isFinite(dc.high) && close > dc.high) scores[IX.breakout] = clamp(0.5 + (close - dc.high) / a, 0.5, 1);
      else if (Number.isFinite(dc.low) && close < dc.low) scores[IX.breakout] = -clamp(0.5 + (dc.low - close) / a, 0.5, 1);

      // Mean reversion: fade the edges of the bands, less so in a strong trend.
      const bands = bollinger(s.close, 20, 2);
      let rev = -Math.tanh((bands.percentB - 0.5) * 2.2);
      if (rsiV > 70) rev -= 0.3;
      if (rsiV < 30) rev += 0.3;
      rev *= 1 - 0.6 * clamp((adxV - 20) / 20, 0, 1);
      scores[IX.reversion] = clamp(rev, -1, 1);

      // Squeeze: bands widening out of their narrowest in a hundred bars.
      const widths = live ? [...this.widths, bands.width] : this.widths;
      const w = widths.length;
      if (w > 30) {
        let minRank = 1;
        for (let back = 1; back <= 10 && w - back > 0; back += 1) {
          minRank = Math.min(minRank, percentileRank(widths, 100, w - back));
        }
        const earlier = widths[w - 4] ?? bands.width;
        if (minRank < 0.15 && bands.width > earlier * 1.1 && bands.sd > 0) {
          scores[IX.squeeze] = clamp((close - bands.mid) / (2 * bands.sd), -1, 1);
        }
      }

      // Order flow: upticks against downticks.
      if (live) {
        let up = 0;
        let down = 0;
        for (const f of this.flow) {
          if (f.dir > 0) up += 1;
          else down += 1;
        }
        if (up + down >= 10) scores[IX.flow] = clamp(((up - down) / (up + down)) * 1.5, -1, 1);
      } else if (current && current.up + current.down >= 10) {
        scores[IX.flow] = clamp(((current.up - current.down) / (current.up + current.down)) * 1.5, -1, 1);
      }

      // Price action: bodies and rejection wicks of the last two bars.
      let pa = 0;
      let counted = 0;
      for (let i = Math.max(0, n - 2); i < n; i += 1) {
        const range = s.high[i]! - s.low[i]!;
        if (range <= 0) continue;
        const body = (s.close[i]! - s.open[i]!) / range;
        const lower = (Math.min(s.open[i]!, s.close[i]!) - s.low[i]!) / range;
        const upper = (s.high[i]! - Math.max(s.open[i]!, s.close[i]!)) / range;
        pa += 0.6 * body + 0.4 * (lower - upper);
        counted += 1;
      }
      scores[IX.candles] = counted > 0 ? clamp(pa / counted, -1, 1) : 0;

      // Session: the drift this hour has shown, trusted as it gathers evidence.
      const minute = this.minutes[this.minutes.length - 1] ?? 0;
      const hour = new Date(minute * 60_000).getUTCHours();
      const trust = Math.min(1, this.hourCount[hour]! / 20);
      scores[IX.session] = clamp(Math.tanh(this.hourDrift[hour]! * 4) * trust, -1, 1);

      const ri = regimeIndex(regime);
      const wts = this.weights[ri]!;
      let ensemble = 0;
      for (let i = 0; i < NE; i += 1) ensemble += wts[i]! * scores[i]!;
      ensemble = clamp(ensemble, -1, 1);
      const trending = regime === 'trend-up' || regime === 'trend-down' ? 1 : 0;
      const z = [
        1,
        ensemble,
        ensemble * trending,
        ensemble * (regime === 'range' ? 1 : 0),
        ensemble * (regime === 'volatile' ? 1 : 0),
        ensemble * (regime === 'quiet' ? 1 : 0),
      ];
      const p = clamp(sigmoid(this.dot(z)), 0.02, 0.98);
      return { close, atr: a, adx: adxV, er, volRatio, regime, scores, ensemble, z, p, width: bands.width };
    } finally {
      if (pushed) {
        s.open.pop();
        s.high.pop();
        s.low.pop();
        s.close.pop();
        this.minutes.pop();
      }
    }
  }

  private danger(snap: Snapshot, now: number): AiDanger {
    const reasons: string[] = [];
    let level = 0;
    if (snap.volRatio > 1.8) {
      level += 0.2 + 0.5 * clamp((snap.volRatio - 1.8) / 1.2, 0, 1);
      reasons.push(`volatility ${snap.volRatio.toFixed(1)}× its normal level`);
    }
    const spreadRatio = this.spreadAvg > 0 ? this.spreadNow / this.spreadAvg : 1;
    if (spreadRatio > 2) {
      level += 0.25 + 0.4 * clamp((spreadRatio - 2) / 2, 0, 1);
      reasons.push(`spread ${spreadRatio.toFixed(1)}× its average`);
    }
    if (now - this.jump.time <= 30_000 && this.jump.size > 1) {
      level += 0.3 + 0.3 * clamp(this.jump.size - 1, 0, 1);
      reasons.push(`price jumped ${this.jump.size.toFixed(1)} ATR in one quote`);
    }
    const recent = this.tickTimes.filter((t) => now - t <= 10_000).length;
    const baseline = this.tickTimes.length / 12;
    if (this.tickTimes.length >= 60 && baseline > 0 && recent / baseline > 3) {
      level += 0.15;
      reasons.push(`quotes arriving ${(recent / baseline).toFixed(1)}× faster than usual`);
    }
    if (snap.regime === 'volatile') level += 0.1;
    return { level: Math.round(clamp(level, 0, 1) * 100) / 100, reasons };
  }

  private learning(): AiLearning {
    return {
      samples: this.samples,
      accuracy: this.accuracyCount >= 20 ? this.accuracy : null,
      confidentAccuracy: this.confCount >= 10 ? this.confAccuracy : null,
      trades: this.trades,
      winRate: this.trades > 0 ? this.winRate : null,
      expectancyR: this.trades > 0 ? this.expectancyR : null,
      updatedAt: this.updatedAt,
    };
  }

  /**
   * What the AI makes of the market right now. Recomputed at most four times
   * a second of market time; every caller in between shares the answer.
   */
  read(minProbability: number, now = this.lastTickTime): AiReading {
    const c = this.cached;
    if (c && c.minProbability === minProbability && now - c.at < 250 && now >= c.at) return c.reading;
    const reading = this.compute(minProbability, now);
    this.cached = { at: now, minProbability, reading };
    return reading;
  }

  private compute(minProbability: number, now: number): AiReading {
    const expertsIdle = () =>
      AI_EXPERTS.map((e, i) => ({ name: e.name, label: e.label, score: 0, weight: this.weights[2]![i]!, hitRate: null }));
    if (this.bars.length < 30) {
      return {
        ready: false,
        warmup: `learning the market — ${this.bars.length}/${WARMUP_BARS} bars`,
        time: now,
        regime: 'range',
        probabilityUp: 0.5,
        side: null,
        confidence: 0,
        ensemble: 0,
        experts: expertsIdle(),
        atr: 0,
        adx: 0,
        efficiency: 0,
        volatilityRatio: 1,
        spreadRatio: 1,
        danger: { level: 0, reasons: [] },
        reasons: [],
        threshold: clamp(minProbability, 0.5, 0.95),
        learning: this.learning(),
      };
    }
    const snap = this.evaluate(true);
    const ri = regimeIndex(snap.regime);
    const weights = this.weights[ri]!;
    const experts = AI_EXPERTS.map((e, i) => ({
      name: e.name,
      label: e.label,
      score: Math.round(snap.scores[i]! * 100) / 100,
      weight: Math.round(weights[i]! * 1000) / 1000,
      hitRate: this.hitCount[i]! >= 15 ? Math.round(this.hit[i]! * 1000) / 1000 : null,
    }));
    const confidence = Math.abs(2 * snap.p - 1);
    const side: Side | null = confidence < 0.04 ? null : snap.p > 0.5 ? 'buy' : 'sell';
    const ready = this.bars.length >= WARMUP_BARS;

    // The reasons behind the lean: the experts contributing most to it.
    const reasons: string[] = [`${AI_REGIME_LABELS[snap.regime]} (ADX ${snap.adx.toFixed(0)}, efficiency ${(snap.er * 100).toFixed(0)}%)`];
    if (side) {
      const sign = side === 'buy' ? 1 : -1;
      const ranked = AI_EXPERTS.map((e, i) => ({ e, v: weights[i]! * snap.scores[i]! * sign, s: snap.scores[i]! }))
        .filter((x) => x.v > 0.005)
        .sort((a, b) => b.v - a.v)
        .slice(0, 3);
      for (const x of ranked) {
        reasons.push(`${x.e.label} ${x.s > 0 ? 'bullish' : 'bearish'} ${Math.round(Math.abs(x.s) * 100)}% — ${x.e.reads}`);
      }
    }
    return {
      ready,
      warmup: ready ? null : `learning the market — ${this.bars.length}/${WARMUP_BARS} bars`,
      time: now,
      regime: snap.regime,
      probabilityUp: Math.round(snap.p * 1000) / 1000,
      side: ready ? side : null,
      confidence: Math.round(confidence * 1000) / 1000,
      ensemble: Math.round(snap.ensemble * 1000) / 1000,
      experts,
      atr: Math.round(snap.atr * 1000) / 1000,
      adx: Math.round(snap.adx * 10) / 10,
      efficiency: Math.round(snap.er * 1000) / 1000,
      volatilityRatio: Math.round(snap.volRatio * 100) / 100,
      spreadRatio: Math.round((this.spreadAvg > 0 ? this.spreadNow / this.spreadAvg : 1) * 100) / 100,
      danger: this.danger(snap, now),
      reasons,
      threshold: this.threshold(minProbability, snap.regime),
      learning: this.learning(),
    };
  }

  /* --------------------------------------------------------------- */
  /* Persistence                                                      */
  /* --------------------------------------------------------------- */

  exportState(now = Date.now()): BrainState {
    this.updatedAt = now;
    return {
      v: 1,
      weights: this.weights.map((w) => [...w]),
      beta: [...this.beta],
      hourDrift: [...this.hourDrift],
      hourCount: [...this.hourCount],
      hit: [...this.hit],
      hitCount: [...this.hitCount],
      accuracy: this.accuracy,
      accuracyCount: this.accuracyCount,
      confAccuracy: this.confAccuracy,
      confCount: this.confCount,
      edge: this.edge,
      edgeCount: this.edgeCount,
      samples: this.samples,
      trades: this.trades,
      winRate: this.winRate,
      expectancyR: this.expectancyR,
      regimeExp: [...this.regimeExp],
      regimeCount: [...this.regimeCount],
      lossStreak: this.lossStreak,
      learnedThrough: this.learnedThrough,
      updatedAt: now,
      calib: this.calib.map((c) => [c.z.map((v) => Math.round(v * 1e4) / 1e4), c.y, Math.round(c.w * 1e3) / 1e3]),
    };
  }

  /** Restores a saved model; anything malformed is ignored and the defaults stay. */
  importState(state: unknown): boolean {
    const st = state as Partial<BrainState> | null;
    const numbers = (v: unknown, len: number): v is number[] =>
      Array.isArray(v) && v.length === len && v.every((x) => typeof x === 'number' && Number.isFinite(x));
    if (!st || st.v !== 1) return false;
    if (!Array.isArray(st.weights) || st.weights.length !== NR || !st.weights.every((w) => numbers(w, NE))) return false;
    if (!numbers(st.beta, NZ) || !numbers(st.hourDrift, 24) || !numbers(st.hourCount, 24)) return false;
    if (!numbers(st.hit, NE) || !numbers(st.hitCount, NE) || !numbers(st.regimeExp, NR) || !numbers(st.regimeCount, NR)) return false;
    this.weights = st.weights.map((w) => normalise(w));
    this.beta = [...st.beta];
    this.hourDrift = [...st.hourDrift];
    this.hourCount = [...st.hourCount];
    this.hit = [...st.hit];
    this.hitCount = [...st.hitCount];
    const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    this.accuracy = num(st.accuracy, 0.5);
    this.accuracyCount = num(st.accuracyCount, 0);
    this.confAccuracy = num(st.confAccuracy, 0.5);
    this.confCount = num(st.confCount, 0);
    this.edge = num(st.edge, 0.5);
    this.edgeCount = num(st.edgeCount, 0);
    this.samples = num(st.samples, 0);
    this.trades = num(st.trades, 0);
    this.winRate = num(st.winRate, 0);
    this.expectancyR = num(st.expectancyR, 0);
    this.regimeExp = [...st.regimeExp];
    this.regimeCount = [...st.regimeCount];
    this.lossStreak = num(st.lossStreak, 0);
    this.learnedThrough = num(st.learnedThrough, 0);
    this.updatedAt = num(st.updatedAt, Date.now());
    this.calib = Array.isArray(st.calib)
      ? st.calib
          .filter((c) => Array.isArray(c) && numbers(c[0], NZ) && (c[1] === 0 || c[1] === 1) && typeof c[2] === 'number')
          .slice(-CALIBRATION_WINDOW)
          .map((c) => ({ z: [...c[0]], y: c[1], w: c[2] }))
      : [];
    this.sinceFit = 0;
    this.cached = null;
    return true;
  }

  /** The weights table, for Claude's review: regime → expert → share of the vote. */
  weightTable(): Record<AiRegime, Record<AiExpertName, number>> {
    const out = {} as Record<AiRegime, Record<AiExpertName, number>>;
    AI_REGIMES.forEach((r, ri) => {
      out[r] = {} as Record<AiExpertName, number>;
      EXPERTS.forEach((e, i) => {
        out[r][e] = Math.round(this.weights[ri]![i]! * 1000) / 1000;
      });
    });
    return out;
  }

  /** Per-regime trade results, for Claude's review. */
  regimeResults(): Record<AiRegime, { trades: number; expectancyR: number | null }> {
    const out = {} as Record<AiRegime, { trades: number; expectancyR: number | null }>;
    AI_REGIMES.forEach((r, ri) => {
      out[r] = { trades: this.regimeCount[ri]!, expectancyR: this.regimeCount[ri]! > 0 ? Math.round(this.regimeExp[ri]! * 100) / 100 : null };
    });
    return out;
  }

  /** The last closed bars, for Claude's review. */
  recentBars(count: number): { time: number; open: number; high: number; low: number; close: number }[] {
    return this.bars.slice(-count).map((b) => ({ time: b.minute * 60_000, open: b.open, high: b.high, low: b.low, close: b.close }));
  }
}
