import { TIMEFRAME_SECONDS } from '../compiler/builtins.js';

/**
 * Price history per symbol and timeframe, kept the way MetaTrader keeps it:
 * bars stamped in broker server time, oldest first, the last one forming.
 *
 * The engine seeds each series from the broker's own history and then feeds
 * every quote in; all tracked timeframes of that symbol update together, so
 * an EA reading M1 and H4 sees the same tick in both.
 */

export interface Bar {
  /** Bar open time, broker server time, seconds. */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  tickVolume: number;
  /** Spread at the bar's last tick, in points. */
  spread: number;
  realVolume: number;
}

export class BarSeries {
  time: number[] = [];
  open: number[] = [];
  high: number[] = [];
  low: number[] = [];
  close: number[] = [];
  tickVolume: number[] = [];
  spread: number[] = [];
  realVolume: number[] = [];
  /** Changes whenever any bar changes, so indicator caches know to recompute. */
  version = 0;
  loaded = false;

  constructor(
    readonly symbol: string,
    readonly timeframe: number,
    readonly limit = 5000,
  ) {}

  get length(): number {
    return this.time.length;
  }

  /** Bar `shift` places back from the newest (0 = forming bar). */
  index(shift: number): number {
    return this.time.length - 1 - shift;
  }

  reset(bars: Bar[]): void {
    const sorted = [...bars].sort((a, b) => a.time - b.time).slice(-this.limit);
    this.time = sorted.map((b) => b.time);
    this.open = sorted.map((b) => b.open);
    this.high = sorted.map((b) => b.high);
    this.low = sorted.map((b) => b.low);
    this.close = sorted.map((b) => b.close);
    this.tickVolume = sorted.map((b) => b.tickVolume);
    this.spread = sorted.map((b) => b.spread);
    this.realVolume = sorted.map((b) => b.realVolume);
    this.loaded = true;
    this.version += 1;
  }

  private push(bar: Bar): void {
    this.time.push(bar.time);
    this.open.push(bar.open);
    this.high.push(bar.high);
    this.low.push(bar.low);
    this.close.push(bar.close);
    this.tickVolume.push(bar.tickVolume);
    this.spread.push(bar.spread);
    this.realVolume.push(bar.realVolume);
    if (this.time.length > this.limit) {
      const drop = this.time.length - this.limit;
      for (const arr of [this.time, this.open, this.high, this.low, this.close, this.tickVolume, this.spread, this.realVolume]) {
        arr.splice(0, drop);
      }
    }
  }

  /** Applies one quote. Returns true when it opened a new bar. */
  apply(price: number, serverTime: number, spreadPoints: number, volume = 1): boolean {
    const start = barStart(serverTime, this.timeframe);
    const n = this.time.length;
    this.version += 1;
    if (n === 0 || start > this.time[n - 1]!) {
      this.push({ time: start, open: price, high: price, low: price, close: price, tickVolume: volume, spread: spreadPoints, realVolume: 0 });
      return true;
    }
    if (start < this.time[n - 1]!) return false; // a stale quote: never rewrite a closed bar
    const i = n - 1;
    if (price > this.high[i]!) this.high[i] = price;
    if (price < this.low[i]!) this.low[i] = price;
    this.close[i] = price;
    this.tickVolume[i] = this.tickVolume[i]! + volume;
    this.spread[i] = spreadPoints;
    return false;
  }

  bar(i: number): Bar {
    return {
      time: this.time[i]!,
      open: this.open[i]!,
      high: this.high[i]!,
      low: this.low[i]!,
      close: this.close[i]!,
      tickVolume: this.tickVolume[i]!,
      spread: this.spread[i]!,
      realVolume: this.realVolume[i]!,
    };
  }
}

/** Opening time of the bar containing `time` (server seconds). */
export function barStart(time: number, timeframe: number): number {
  const t = Math.floor(time);
  if (timeframe === 49153) {
    const d = new Date(t * 1000);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
  }
  if (timeframe === 32769) {
    // MetaTrader weeks open on Sunday. 1 January 1970 was a Thursday.
    const day = Math.floor(t / 86400);
    const sinceSunday = (day + 4) % 7;
    return (day - sinceSunday) * 86400;
  }
  const seconds = TIMEFRAME_SECONDS[timeframe] ?? 60;
  return Math.floor(t / seconds) * seconds;
}

/** MetaApi's timeframe strings, keyed by MQL5 timeframe code. */
export const METAAPI_TIMEFRAMES: Record<number, string> = {
  1: '1m', 2: '2m', 3: '3m', 4: '4m', 5: '5m', 6: '6m', 10: '10m', 12: '12m', 15: '15m', 20: '20m', 30: '30m',
  16385: '1h', 16386: '2h', 16387: '3h', 16388: '4h', 16390: '6h', 16392: '8h', 16396: '12h',
  16408: '1d', 32769: '1w', 49153: '1mn',
};

export function normaliseTimeframe(tf: number, chart: number): number {
  if (tf === 0) return chart;
  return TIMEFRAME_SECONDS[tf] !== undefined ? tf : chart;
}

export interface SeriesRequest {
  symbol: string;
  timeframe: number;
}

/**
 * Every series an expert reads. Missing series are requested from the
 * host and reported as not yet synchronised until they arrive — which is
 * exactly what MetaTrader does with history it has not downloaded.
 */
export class MarketData {
  private readonly series = new Map<string, BarSeries>();
  private readonly listeners = new Set<(request: SeriesRequest) => void>();

  private key(symbol: string, timeframe: number): string {
    return `${symbol}\u0000${timeframe}`;
  }

  get(symbol: string, timeframe: number): BarSeries {
    const key = this.key(symbol, timeframe);
    let s = this.series.get(key);
    if (!s) {
      s = new BarSeries(symbol, timeframe);
      this.series.set(key, s);
      for (const listener of this.listeners) listener({ symbol, timeframe });
    }
    return s;
  }

  has(symbol: string, timeframe: number): boolean {
    return this.series.get(this.key(symbol, timeframe))?.loaded ?? false;
  }

  /** Called whenever an expert touches a series nobody has loaded yet. */
  onRequest(listener: (request: SeriesRequest) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  seed(symbol: string, timeframe: number, bars: Bar[]): void {
    this.get(symbol, timeframe).reset(bars);
  }

  /** Feeds one quote to every tracked timeframe of the symbol. */
  onQuote(symbol: string, bid: number, ask: number, serverTime: number, point: number, volume = 1): void {
    const spread = point > 0 ? Math.round((ask - bid) / point) : 0;
    for (const s of this.series.values()) {
      if (s.symbol !== symbol) continue;
      s.apply(bid, serverTime, spread, volume);
    }
  }

  tracked(): SeriesRequest[] {
    return [...this.series.values()].map((s) => ({ symbol: s.symbol, timeframe: s.timeframe }));
  }
}
