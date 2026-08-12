import { Emitter } from '../emitter.js';
import {
  commissionFor,
  entryPrice,
  exitPrice,
  getSymbolSpec,
  grossProfit,
  marginRequired,
  positionProfit,
  roundLot,
  roundPrice,
  stopLevels,
  type AccountConfig,
  type AccountState,
  type ClosedTrade,
  type CloseReason,
  type Position,
  type PositionOrigin,
  type Side,
  type Tick,
} from '@sentinal/shared';
import { round, uid } from '../util.js';

export interface OpenRequest {
  symbol: string;
  side: Side;
  volume: number;
  stopLossUsd?: number | null;
  takeProfitUsd?: number | null;
  origin: PositionOrigin;
  comment?: string;
  basketIndex?: number;
  recoveryLayer?: number;
  sourceId?: string | null;
  magic?: number;
  /** Explicit levels win over the money-based ones (used when copying). */
  stopLoss?: number | null;
  takeProfit?: number | null;
}

export type OpenResult =
  | { ok: true; position: Position }
  | { ok: false; error: string };

let ticketSeq = 50_000_000;

/**
 * A single trading account.
 *
 * The simulated implementation fills against the live feed with spread and a
 * touch of slippage, tracks margin, and closes legs when their money-based
 * stop or target is touched. Remote providers subclass this and override the
 * order entry points while reusing the bookkeeping.
 */
export class TradingAccount extends Emitter {
  readonly id: string;
  config: AccountConfig;
  balance: number;
  connected = true;
  connectionError: string | null = null;

  protected positions = new Map<string, Position>();
  protected closed: ClosedTrade[] = [];
  protected lastTick: Tick | null = null;
  protected realised = 0;

  constructor(config: AccountConfig) {
    super();
    this.id = config.id;
    this.config = config;
    this.balance = config.initialBalance;
  }

  get history(): ClosedTrade[] {
    return this.closed;
  }

  listPositions(): Position[] {
    return [...this.positions.values()];
  }

  getPosition(id: string): Position | undefined {
    return this.positions.get(id);
  }

  positionsFor(symbol: string, origin?: PositionOrigin): Position[] {
    return this.listPositions().filter(
      (p) => p.symbol === symbol && (origin === undefined || p.origin === origin),
    );
  }

  /* --------------------------------------------------------------- */
  /* Order entry                                                      */
  /* --------------------------------------------------------------- */

  open(req: OpenRequest): OpenResult {
    if (!this.connected) return { ok: false, error: `${this.config.name} is not connected` };
    const tick = this.lastTick;
    if (!tick) return { ok: false, error: 'no quote available yet' };

    const spec = getSymbolSpec(req.symbol);
    const volume = roundLot(spec, req.volume);
    if (volume < spec.minLot) return { ok: false, error: `volume below broker minimum (${spec.minLot})` };

    const price = roundPrice(spec, entryPrice(req.side, tick.bid, tick.ask));
    const required = marginRequired(spec, volume, price, this.config.leverage);
    if (required > this.freeMargin()) {
      return { ok: false, error: `insufficient free margin (needs ${required.toFixed(2)})` };
    }

    const derived = stopLevels(
      spec,
      req.side,
      volume,
      price,
      req.stopLossUsd ?? null,
      req.takeProfitUsd ?? null,
    );
    const commission = round(commissionFor(spec, volume));

    const position: Position = {
      id: uid('pos'),
      ticket: (ticketSeq += 1),
      accountId: this.id,
      symbol: req.symbol,
      side: req.side,
      volume,
      openPrice: price,
      openTime: tick.time,
      stopLoss: req.stopLoss !== undefined ? req.stopLoss : derived.stopLoss,
      takeProfit: req.takeProfit !== undefined ? req.takeProfit : derived.takeProfit,
      stopLossUsd: req.stopLossUsd ?? null,
      takeProfitUsd: req.takeProfitUsd ?? null,
      currentPrice: roundPrice(spec, exitPrice(req.side, tick.bid, tick.ask)),
      profit: 0,
      swap: 0,
      commission,
      origin: req.origin,
      basketIndex: req.basketIndex ?? 0,
      recoveryLayer: req.recoveryLayer ?? 0,
      comment: req.comment ?? '',
      magic: req.magic ?? 20260811,
      sourceId: req.sourceId ?? null,
    };

    this.positions.set(position.id, position);
    this.revalue(tick);
    this.emit('opened', position, this);
    this.emit('changed', this);
    return { ok: true, position };
  }

  close(id: string, reason: CloseReason, priceOverride?: number): ClosedTrade | null {
    const position = this.positions.get(id);
    if (!position) return null;
    const tick = this.lastTick;
    const spec = getSymbolSpec(position.symbol);
    const price =
      priceOverride ?? (tick ? exitPrice(position.side, tick.bid, tick.ask) : position.currentPrice);

    const gross = grossProfit(spec, position.side, position.volume, position.openPrice, price);
    const net = round(gross + position.swap - position.commission);

    this.balance = round(this.balance + net);
    this.realised = round(this.realised + net);
    this.positions.delete(id);

    const trade: ClosedTrade = {
      id: position.id,
      ticket: position.ticket,
      accountId: this.id,
      symbol: position.symbol,
      side: position.side,
      volume: position.volume,
      openPrice: position.openPrice,
      closePrice: roundPrice(spec, price),
      openTime: position.openTime,
      closeTime: tick?.time ?? Date.now(),
      profit: round(gross),
      commission: position.commission,
      swap: position.swap,
      netProfit: net,
      reason,
      origin: position.origin,
      recoveryLayer: position.recoveryLayer,
      comment: position.comment,
    };

    this.closed.unshift(trade);
    if (this.closed.length > 500) this.closed.pop();

    this.emit('closed', trade, position, this);
    this.emit('changed', this);
    return trade;
  }

  /**
   * Connection lifecycle. A local account is live the moment it exists;
   * remote providers override these to dial and drop their broker session.
   */
  async connect(): Promise<void> {
    this.connected = true;
  }

  disconnect(): void {
    /* nothing to tear down for a local account */
  }

  /**
   * Async order entry used by every caller. Local accounts resolve immediately;
   * remote providers override this to talk to their broker API.
   */
  async submit(req: OpenRequest): Promise<OpenResult> {
    return this.open(req);
  }

  async submitClose(id: string, reason: CloseReason): Promise<ClosedTrade | null> {
    return this.close(id, reason);
  }

  closeAll(reason: CloseReason, filter?: (p: Position) => boolean): ClosedTrade[] {
    const targets = this.listPositions().filter((p) => (filter ? filter(p) : true));
    return targets
      .map((p) => this.close(p.id, reason))
      .filter((t): t is ClosedTrade => t !== null);
  }

  modify(id: string, stopLoss: number | null, takeProfit: number | null): boolean {
    const position = this.positions.get(id);
    if (!position) return false;
    position.stopLoss = stopLoss;
    position.takeProfit = takeProfit;
    this.emit('changed', this);
    return true;
  }

  /* --------------------------------------------------------------- */
  /* Valuation                                                        */
  /* --------------------------------------------------------------- */

  onTick(tick: Tick): void {
    this.lastTick = tick;
    this.checkStops(tick);
    this.revalue(tick);
  }

  /** Closes any leg whose money-based stop or target has been touched. */
  private checkStops(tick: Tick): void {
    for (const position of this.listPositions()) {
      if (position.symbol !== tick.symbol) continue;
      const price = exitPrice(position.side, tick.bid, tick.ask);
      const long = position.side === 'buy';

      if (position.stopLoss !== null) {
        const hit = long ? price <= position.stopLoss : price >= position.stopLoss;
        if (hit) {
          this.close(position.id, 'sl', position.stopLoss);
          continue;
        }
      }
      if (position.takeProfit !== null) {
        const hit = long ? price >= position.takeProfit : price <= position.takeProfit;
        if (hit) this.close(position.id, 'tp', position.takeProfit);
      }
    }
  }

  protected revalue(tick: Tick): void {
    for (const position of this.positions.values()) {
      if (position.symbol !== tick.symbol) continue;
      const spec = getSymbolSpec(position.symbol);
      position.currentPrice = roundPrice(spec, exitPrice(position.side, tick.bid, tick.ask));
      position.profit = round(positionProfit(spec, position, tick.bid, tick.ask) - position.commission);
    }
  }

  /** Adopts the balance the broker reports, so displayed figures stay true. */
  syncBalance(balance: number): void {
    if (!Number.isFinite(balance)) return;
    this.balance = round(balance);
    this.emit('changed', this);
  }

  floatingProfit(): number {
    let total = 0;
    for (const position of this.positions.values()) total += position.profit;
    return round(total);
  }

  usedMargin(): number {
    let total = 0;
    for (const position of this.positions.values()) {
      const spec = getSymbolSpec(position.symbol);
      total += marginRequired(spec, position.volume, position.openPrice, this.config.leverage);
    }
    return round(total);
  }

  equity(): number {
    return round(this.balance + this.floatingProfit());
  }

  freeMargin(): number {
    return round(this.equity() - this.usedMargin());
  }

  state(): AccountState {
    const margin = this.usedMargin();
    const equity = this.equity();
    return {
      id: this.id,
      name: this.config.name,
      provider: this.config.provider,
      login: this.config.login,
      server: this.config.server,
      broker: this.config.broker,
      currency: this.config.currency,
      leverage: this.config.leverage,
      role: this.config.role,
      connected: this.connected,
      connectionError: this.connectionError,
      balance: round(this.balance),
      equity,
      margin,
      freeMargin: round(equity - margin),
      marginLevel: margin > 0 ? round((equity / margin) * 100) : 0,
      totalProfit: round(this.realised + this.floatingProfit()),
      openPositions: this.positions.size,
      copy: this.config.copy,
    };
  }
}
