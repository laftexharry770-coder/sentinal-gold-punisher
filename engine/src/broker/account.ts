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
  type Deal,
  type PendingOrder,
  type PendingType,
  type Position,
  type PositionOrigin,
  type Side,
  type SymbolSpec,
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
  /** Explicit levels win over the money-based ones (used when copying and by EAs). */
  stopLoss?: number | null;
  takeProfit?: number | null;
  /** Links the order to the dispatch that sent it to several accounts at once. */
  clientId?: string | null;
  /** Largest price deviation accepted, in points. */
  slippagePoints?: number;
}

export type OpenResult =
  | { ok: true; position: Position }
  | { ok: false; error: string; code?: string };

export interface PendingRequest {
  symbol: string;
  type: PendingType;
  volume: number;
  openPrice: number;
  stopLimitPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  expiration?: number | null;
  magic?: number;
  comment?: string;
  clientId?: string | null;
}

export type PendingResult = { ok: true; order: PendingOrder } | { ok: false; error: string };

export type ActionResult = { ok: true } | { ok: false; error: string };

let ticketSeq = 50_000_000;

function nextTicket(): number {
  ticketSeq += 1;
  return ticketSeq;
}

/**
 * A single trading account.
 *
 * The simulated implementation fills against the live feed with spread, tracks
 * margin, executes pending orders when price reaches them, closes legs when
 * their stop or target is touched, and keeps a deal history the way MetaTrader
 * does. Remote providers subclass this and override the order entry points
 * while reusing the bookkeeping.
 */
export class TradingAccount extends Emitter {
  readonly id: string;
  config: AccountConfig;
  balance: number;
  connected = true;
  connectionError: string | null = null;
  /** Broker server time minus UTC, seconds — MQL5 programs see server time. */
  serverOffset = 0;

  protected positions = new Map<string, Position>();
  protected orders = new Map<string, PendingOrder>();
  protected closed: ClosedTrade[] = [];
  protected dealLog: Deal[] = [];
  protected lastTick: Tick | null = null;
  protected realised = 0;
  private latencies: number[] = [];
  lastLatencyMs: number | null = null;

  constructor(config: AccountConfig) {
    super();
    this.id = config.id;
    this.config = config;
    this.balance = config.initialBalance;
  }

  get history(): ClosedTrade[] {
    return this.closed;
  }

  /** The instrument this account trades, in its broker's naming. */
  get symbol(): string {
    return this.config.symbol ?? 'XAUUSD';
  }

  /** Contract specification for a symbol on this account. */
  spec(symbol = this.symbol): SymbolSpec {
    return getSymbolSpec(symbol);
  }

  quote(): Tick | null {
    return this.lastTick;
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

  listOrders(): PendingOrder[] {
    return [...this.orders.values()];
  }

  deals(): Deal[] {
    return this.dealLog;
  }

  /** Records how long the broker took to acknowledge an order. */
  recordLatency(ms: number): void {
    this.lastLatencyMs = Math.round(ms);
    this.latencies.push(ms);
    if (this.latencies.length > 20) this.latencies.shift();
  }

  averageLatency(): number | null {
    if (this.latencies.length === 0) return null;
    return Math.round(this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length);
  }

  /* --------------------------------------------------------------- */
  /* Deals                                                            */
  /* --------------------------------------------------------------- */

  protected bookDeal(deal: Omit<Deal, 'id' | 'accountId'>): Deal {
    const full: Deal = { ...deal, id: uid('deal'), accountId: this.id };
    this.dealLog.push(full);
    if (this.dealLog.length > 2000) this.dealLog.shift();
    return full;
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
      return { ok: false, error: `insufficient free margin (needs ${required.toFixed(2)})`, code: 'NO_MONEY' };
    }

    return { ok: true, position: this.book(req, price, volume, tick) };
  }

  /** Puts a filled position on the book, with its deal. */
  protected book(req: OpenRequest, price: number, volume: number, tick: Tick, ticket = nextTicket()): Position {
    const spec = getSymbolSpec(req.symbol);
    const derived = stopLevels(spec, req.side, volume, price, req.stopLossUsd ?? null, req.takeProfitUsd ?? null);
    const commission = round(commissionFor(spec, volume));

    const position: Position = {
      id: uid('pos'),
      ticket,
      accountId: this.id,
      symbol: req.symbol,
      side: req.side,
      volume,
      openPrice: price,
      openTime: tick.time,
      stopLoss: req.stopLoss !== undefined && req.stopLoss !== null ? req.stopLoss : derived.stopLoss,
      takeProfit: req.takeProfit !== undefined && req.takeProfit !== null ? req.takeProfit : derived.takeProfit,
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
      clientId: req.clientId ?? null,
    };

    this.positions.set(position.id, position);
    this.bookDeal({
      ticket,
      positionId: String(ticket),
      orderId: String(ticket),
      symbol: position.symbol,
      type: position.side,
      entry: 'in',
      volume,
      price,
      profit: 0,
      commission: -commission / 2,
      swap: 0,
      magic: position.magic,
      comment: position.comment,
      time: tick.time,
      reason: req.origin === 'bot' || req.origin === 'recovery' ? 'expert' : 'client',
      stopLoss: position.stopLoss,
      takeProfit: position.takeProfit,
    });
    this.revalue(tick);
    this.emit('opened', position, this);
    this.emit('changed', this);
    return position;
  }

  close(id: string, reason: CloseReason, priceOverride?: number, volume?: number): ClosedTrade | null {
    const position = this.positions.get(id);
    if (!position) return null;
    const tick = this.lastTick;
    const spec = getSymbolSpec(position.symbol);
    const price =
      priceOverride ?? (tick ? exitPrice(position.side, tick.bid, tick.ask) : position.currentPrice);

    const partial = volume !== undefined && volume > 0 && volume < position.volume - 1e-9;
    const closedVolume = partial ? roundLot(spec, volume) : position.volume;
    const share = closedVolume / position.volume;
    const gross = grossProfit(spec, position.side, closedVolume, position.openPrice, price);
    const commission = round(position.commission * share);
    const swap = round(position.swap * share);
    const net = round(gross + swap - commission);

    this.balance = round(this.balance + net);
    this.realised = round(this.realised + net);

    if (partial) {
      position.volume = round(position.volume - closedVolume, 2);
      position.commission = round(position.commission - commission);
      position.swap = round(position.swap - swap);
    } else {
      this.positions.delete(id);
    }

    const trade: ClosedTrade = {
      id: partial ? uid('part') : position.id,
      ticket: position.ticket,
      accountId: this.id,
      symbol: position.symbol,
      side: position.side,
      volume: closedVolume,
      openPrice: position.openPrice,
      closePrice: roundPrice(spec, price),
      openTime: position.openTime,
      closeTime: tick?.time ?? Date.now(),
      profit: round(gross),
      commission,
      swap,
      netProfit: net,
      reason,
      origin: position.origin,
      recoveryLayer: position.recoveryLayer,
      comment: position.comment,
    };

    this.closed.unshift(trade);
    if (this.closed.length > 500) this.closed.pop();

    this.bookDeal({
      ticket: nextTicket(),
      positionId: String(position.ticket),
      orderId: String(position.ticket),
      symbol: position.symbol,
      type: position.side === 'buy' ? 'sell' : 'buy',
      entry: 'out',
      volume: closedVolume,
      price: roundPrice(spec, price),
      profit: round(gross),
      commission: -commission / 2,
      swap,
      magic: position.magic,
      comment: reason === 'sl' ? '[sl]' : reason === 'tp' ? '[tp]' : position.comment,
      time: tick?.time ?? Date.now(),
      reason: reason === 'sl' ? 'sl' : reason === 'tp' ? 'tp' : position.origin === 'bot' ? 'expert' : 'client',
      stopLoss: position.stopLoss,
      takeProfit: position.takeProfit,
    });

    if (partial) {
      this.emit('partial', trade, position, this);
    } else {
      this.emit('closed', trade, position, this);
    }
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

  async submitClose(id: string, reason: CloseReason, volume?: number): Promise<ClosedTrade | null> {
    return this.close(id, reason, undefined, volume);
  }

  async submitModify(id: string, stopLoss: number | null, takeProfit: number | null): Promise<ActionResult> {
    return this.modify(id, stopLoss, takeProfit) ? { ok: true } : { ok: false, error: 'position not found' };
  }

  closeAll(reason: CloseReason, filter?: (p: Position) => boolean): ClosedTrade[] {
    const targets = this.listPositions().filter((p) => (filter ? filter(p) : true));
    return targets
      .map((p) => this.close(p.id, reason))
      .filter((t): t is ClosedTrade => t !== null);
  }

  /**
   * Asks for every matching position to be closed and says how many requests
   * went out. A simulated book closes on the spot; a broker account sends the
   * closes together and books each one as its broker confirms it.
   */
  requestCloseAll(reason: CloseReason, filter?: (p: Position) => boolean): number {
    return this.closeAll(reason, filter).length;
  }

  /**
   * The account is leaving the terminal. A simulated book has nowhere else to
   * live, so its positions close; a broker account keeps its positions at the
   * broker and only drops the connection.
   */
  release(): void {
    this.closeAll('manual');
    this.disconnect();
  }

  modify(id: string, stopLoss: number | null, takeProfit: number | null): boolean {
    const position = this.positions.get(id);
    if (!position) return false;
    position.stopLoss = stopLoss;
    position.takeProfit = takeProfit;
    this.emit('modified', position, this);
    this.emit('changed', this);
    return true;
  }

  /* --------------------------------------------------------------- */
  /* Pending orders                                                   */
  /* --------------------------------------------------------------- */

  async submitPending(req: PendingRequest): Promise<PendingResult> {
    if (!this.connected) return { ok: false, error: `${this.config.name} is not connected` };
    const spec = getSymbolSpec(req.symbol);
    const volume = roundLot(spec, req.volume);
    const ticket = nextTicket();
    const order: PendingOrder = {
      id: uid('ord'),
      ticket,
      accountId: this.id,
      symbol: req.symbol,
      type: req.type,
      volume,
      openPrice: roundPrice(spec, req.openPrice),
      stopLimitPrice: req.stopLimitPrice ?? null,
      stopLoss: req.stopLoss ?? null,
      takeProfit: req.takeProfit ?? null,
      expiration: req.expiration ?? null,
      magic: req.magic ?? 0,
      comment: req.comment ?? '',
      time: this.lastTick?.time ?? Date.now(),
      clientId: req.clientId ?? null,
    };
    this.orders.set(order.id, order);
    this.emit('orders', this.listOrders(), this);
    this.emit('changed', this);
    return { ok: true, order };
  }

  async cancelPending(id: string): Promise<ActionResult> {
    if (!this.orders.delete(id)) return { ok: false, error: 'order not found' };
    this.emit('orders', this.listOrders(), this);
    this.emit('changed', this);
    return { ok: true };
  }

  async modifyPending(
    id: string,
    openPrice: number,
    stopLoss: number | null,
    takeProfit: number | null,
    expiration?: number | null,
  ): Promise<ActionResult> {
    const order = this.orders.get(id);
    if (!order) return { ok: false, error: 'order not found' };
    order.openPrice = roundPrice(getSymbolSpec(order.symbol), openPrice);
    order.stopLoss = stopLoss;
    order.takeProfit = takeProfit;
    if (expiration !== undefined) order.expiration = expiration;
    this.emit('orders', this.listOrders(), this);
    return { ok: true };
  }

  /** Fills or expires pending orders against the quote, as a broker server does. */
  private checkPending(tick: Tick): void {
    for (const order of this.listOrders()) {
      if (order.symbol !== tick.symbol) continue;
      if (order.expiration !== null && tick.time >= order.expiration) {
        this.orders.delete(order.id);
        this.emit('orders', this.listOrders(), this);
        continue;
      }
      const buy = order.type.startsWith('buy');
      const price = buy ? tick.ask : tick.bid;
      let triggered = false;
      switch (order.type) {
        case 'buy-limit':
          triggered = price <= order.openPrice;
          break;
        case 'sell-limit':
          triggered = price >= order.openPrice;
          break;
        case 'buy-stop':
        case 'buy-stop-limit':
          triggered = price >= order.openPrice;
          break;
        case 'sell-stop':
        case 'sell-stop-limit':
          triggered = price <= order.openPrice;
          break;
      }
      if (!triggered) continue;
      if (order.type.endsWith('stop-limit') && order.stopLimitPrice !== null) {
        // A stop-limit becomes a limit order at its limit price.
        order.type = buy ? 'buy-limit' : 'sell-limit';
        order.openPrice = order.stopLimitPrice;
        order.stopLimitPrice = null;
        continue;
      }
      this.orders.delete(order.id);
      this.book(
        {
          symbol: order.symbol,
          side: buy ? 'buy' : 'sell',
          volume: order.volume,
          stopLoss: order.stopLoss,
          takeProfit: order.takeProfit,
          origin: 'bot',
          comment: order.comment,
          magic: order.magic,
          clientId: order.clientId,
        },
        roundPrice(getSymbolSpec(order.symbol), price),
        order.volume,
        tick,
        order.ticket,
      );
      this.emit('orders', this.listOrders(), this);
    }
  }

  /* --------------------------------------------------------------- */
  /* Valuation                                                        */
  /* --------------------------------------------------------------- */

  onTick(tick: Tick): void {
    this.lastTick = tick;
    this.checkStops(tick);
    if (this.orders.size > 0) this.checkPending(tick);
    this.revalue(tick);
  }

  /** Closes any leg whose stop or target has been touched. */
  private checkStops(tick: Tick): void {
    for (const position of this.listPositions()) {
      if (position.symbol !== tick.symbol) continue;
      const price = exitPrice(position.side, tick.bid, tick.ask);
      const long = position.side === 'buy';

      if (position.stopLoss !== null && position.stopLoss > 0) {
        const hit = long ? price <= position.stopLoss : price >= position.stopLoss;
        if (hit) {
          this.close(position.id, 'sl', position.stopLoss);
          continue;
        }
      }
      if (position.takeProfit !== null && position.takeProfit > 0) {
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

  /** 'demo' / 'real' for broker accounts; simulated accounts say so. */
  accountType(): AccountState['accountType'] {
    return 'sim';
  }

  quoteIntervalSec(): number | null {
    return null;
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
      symbol: this.symbol,
      accountType: this.accountType(),
      platform: this.config.provider === 'sim' ? 'sim' : 'mt5',
      metaApiId: this.config.metaApiId ?? null,
      lastLatencyMs: this.lastLatencyMs,
      avgLatencyMs: this.averageLatency(),
      quoteIntervalSec: this.quoteIntervalSec(),
      pendingOrders: this.orders.size,
    };
  }
}
