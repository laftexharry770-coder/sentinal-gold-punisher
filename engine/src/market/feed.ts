import { Emitter } from '../emitter.js';
import { roundPrice, type Candle, type SymbolSpec, type Tick } from '@sentinal/shared';
import { clamp, createRng, gaussian } from '../util.js';

export interface FeedOptions {
  spec: SymbolSpec;
  seedPrice: number;
  intervalMs: number;
  seed: number | null;
  historyBars: number;
  /**
   * 'simulated' generates its own ticks. 'external' generates nothing and waits
   * for a broker connection to push quotes in, so the terminal shows no prices
   * until one exists.
   */
  source?: 'simulated' | 'external';
}

/**
 * XAUUSD quote source.
 *
 * The default implementation synthesises ticks with volatility clustering and
 * mild mean reversion, which is enough to exercise the execution engine without
 * a live broker. Swap `start()` for a real socket subscription to go live —
 * everything downstream only consumes the `tick` / `candle` events.
 */
export class MarketFeed extends Emitter {
  readonly spec: SymbolSpec;
  private readonly opts: FeedOptions;
  private readonly rng: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;

  private mid: number;
  private volatility = 0.9;
  private drift = 0;
  private spread: number;

  private candlesM1: Candle[] = [];
  private current: Candle | null = null;
  private lastTick: Tick | null = null;

  constructor(opts: FeedOptions) {
    super();
    this.opts = opts;
    this.spec = opts.spec;
    this.rng = createRng(opts.seed);
    this.mid = opts.seedPrice;
    this.spread = opts.spec.baseSpread;
    // An external feed starts empty: its history and quotes come from the broker.
    if (opts.source !== 'external') this.seedHistory(opts.historyBars);
  }

  get isExternal(): boolean {
    return this.opts.source === 'external';
  }

  get quote(): Tick | null {
    return this.lastTick;
  }

  get candles(): Candle[] {
    return this.current ? [...this.candlesM1, this.current] : [...this.candlesM1];
  }

  /** Builds a plausible M1 history so the chart is populated on first paint. */
  private seedHistory(bars: number): void {
    const now = Date.now();
    const start = Math.floor(now / 60_000) * 60_000 - bars * 60_000;
    let price = this.mid - bars * 0.02;
    for (let i = 0; i < bars; i += 1) {
      const time = start + i * 60_000;
      const open = price;
      let high = open;
      let low = open;
      for (let s = 0; s < 12; s += 1) {
        price += gaussian(this.rng) * 0.32 + (this.opts.seedPrice - price) * 0.0015;
        high = Math.max(high, price);
        low = Math.min(low, price);
      }
      this.candlesM1.push({
        time,
        open: roundPrice(this.spec, open),
        high: roundPrice(this.spec, high),
        low: roundPrice(this.spec, low),
        close: roundPrice(this.spec, price),
        volume: Math.round(120 + this.rng() * 400),
      });
    }
    this.mid = price;
  }

  start(): void {
    if (this.timer || this.isExternal) return;
    this.emitTick();
    this.timer = setInterval(() => this.emitTick(), this.opts.intervalMs);
  }

  /** Loads broker history so the chart opens with real bars behind it. */
  seedCandles(candles: Candle[]): void {
    this.candlesM1 = candles.slice(-1500);
    this.current = null;
  }

  /**
   * Publishes a quote received from a broker. Candle aggregation, valuation and
   * every downstream listener behave exactly as they do for simulated ticks.
   */
  pushTick(tick: Tick): void {
    this.lastTick = tick;
    this.applyToCandle(tick, tick.time);
    this.emit('tick', tick);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Advances the model one step and publishes the resulting quote. */
  private emitTick(): void {
    const now = Date.now();
    this.step();

    const half = this.spread / 2;
    const tick: Tick = {
      symbol: this.spec.symbol,
      bid: roundPrice(this.spec, this.mid - half),
      ask: roundPrice(this.spec, this.mid + half),
      time: now,
    };
    this.lastTick = tick;
    this.applyToCandle(tick, now);
    this.emit('tick', tick);
  }

  private step(): void {
    // Volatility clusters: shocks decay back toward a baseline of 1.0.
    this.volatility = clamp(this.volatility + gaussian(this.rng) * 0.05 - (this.volatility - 1) * 0.04, 0.35, 3.2);
    // Drift is a slow random walk, giving trends the scalper can lean on.
    this.drift = clamp(this.drift + gaussian(this.rng) * 0.004 - this.drift * 0.02, -0.06, 0.06);

    const shock = gaussian(this.rng) * 0.11 * this.volatility;
    const pullback = (this.opts.seedPrice - this.mid) * 0.00008;
    this.mid = roundPrice(this.spec, this.mid + shock + this.drift + pullback);

    // Spread widens with volatility, as it does on a real gold feed.
    this.spread = roundPrice(this.spec, clamp(this.spec.baseSpread * (0.75 + this.volatility * 0.45), 0.12, 1.4));
  }

  private applyToCandle(tick: Tick, now: number): void {
    const bucket = Math.floor(now / 60_000) * 60_000;
    const price = roundPrice(this.spec, (tick.bid + tick.ask) / 2);

    if (!this.current || this.current.time !== bucket) {
      if (this.current) {
        this.candlesM1.push(this.current);
        if (this.candlesM1.length > 1500) this.candlesM1.shift();
        this.emit('candle', { candle: this.current, closed: true });
      }
      this.current = { time: bucket, open: price, high: price, low: price, close: price, volume: 1 };
    } else {
      this.current.high = Math.max(this.current.high, price);
      this.current.low = Math.min(this.current.low, price);
      this.current.close = price;
      this.current.volume += 1;
    }
    this.emit('candle', { candle: this.current, closed: false });
  }
}
