import {
  Expert,
  MarketData,
  RETCODE,
  TRADE_ACTION,
  type Bar,
  type ChartObject,
  type CompiledProgram,
  type ExpertHost,
  type HostAccount,
  type HostDeal,
  type HostOrder,
  type HostPosition,
  type HostQuote,
  type HostSymbolSpec,
  type KeyValueStore,
  type LogLevel,
  type TradeRequest,
  type TradeResult,
} from '@sentinal/mql5';
import { roundPrice, type Deal, type PendingOrder, type PendingType, type Position, type StrategyInfo, type StrategyInput, type SymbolSpec, type Tick } from '@sentinal/shared';
import { Emitter } from '../emitter.js';
import type { OpenRequest, PendingRequest, TradingAccount } from '../broker/account.js';
import type { Journal } from '../journal.js';
import type { CopyTradeEngine } from './copier.js';

/** Supplies history for any symbol and timeframe an expert asks for. */
export interface HistoryProvider {
  /** Bars oldest first, stamped in broker server time (seconds). */
  loadBars(account: TradingAccount, symbol: string, timeframe: number, count: number): Promise<Bar[]>;
}

const PENDING_TYPES: Record<number, PendingType> = {
  2: 'buy-limit',
  3: 'sell-limit',
  4: 'buy-stop',
  5: 'sell-stop',
  6: 'buy-stop-limit',
  7: 'sell-stop-limit',
};

const PENDING_CODES: Record<PendingType, number> = {
  'buy-limit': 2,
  'sell-limit': 3,
  'buy-stop': 4,
  'sell-stop': 5,
  'buy-stop-limit': 6,
  'sell-stop-limit': 7,
};

const TRADE_MODES: Record<NonNullable<SymbolSpec['tradeMode']>, number> = {
  disabled: 0,
  'long-only': 1,
  'short-only': 2,
  'close-only': 3,
  full: 4,
};

/** Broker error text → the MQL5 return code an EA would see for it. */
export function retcodeFor(error: string, code?: string): number {
  const known = code && /^TRADE_RETCODE_/.test(code) ? code.replace('TRADE_RETCODE_', '') : '';
  const table: Record<string, number> = {
    REQUOTE: RETCODE.REQUOTE,
    REJECT: RETCODE.REJECT,
    CANCEL: RETCODE.CANCEL,
    ERROR: RETCODE.ERROR,
    TIMEOUT: RETCODE.TIMEOUT,
    INVALID: RETCODE.INVALID,
    INVALID_VOLUME: RETCODE.INVALID_VOLUME,
    INVALID_PRICE: RETCODE.INVALID_PRICE,
    INVALID_STOPS: RETCODE.INVALID_STOPS,
    TRADE_DISABLED: RETCODE.TRADE_DISABLED,
    MARKET_CLOSED: RETCODE.MARKET_CLOSED,
    NO_MONEY: RETCODE.NO_MONEY,
    PRICE_CHANGED: RETCODE.PRICE_CHANGED,
    PRICE_OFF: RETCODE.PRICE_OFF,
    TOO_MANY_REQUESTS: RETCODE.TOO_MANY_REQUESTS,
    CONNECTION: RETCODE.CONNECTION,
    LIMIT_POSITIONS: RETCODE.LIMIT_POSITIONS,
    POSITION_CLOSED: RETCODE.POSITION_CLOSED,
  };
  if (known && table[known]) return table[known]!;
  if (code === 'NO_MONEY' || /margin|money|funds/i.test(error)) return RETCODE.NO_MONEY;
  if (/market.*closed|closed market/i.test(error)) return RETCODE.MARKET_CLOSED;
  if (/volume|lot/i.test(error)) return RETCODE.INVALID_VOLUME;
  if (/stop|sl|tp/i.test(error)) return RETCODE.INVALID_STOPS;
  if (/connect/i.test(error)) return RETCODE.CONNECTION;
  return RETCODE.REJECT;
}

interface PanelObject {
  y: number;
  x: number;
  text: string;
}

/**
 * Runs an uploaded MQL5 expert on the master account.
 *
 * Implements the runtime's host over the engine: the EA's OrderSend becomes a
 * dispatch that reaches the master and every follower at once, its view of
 * positions, orders and deals is the master's book, and its bars come from the
 * broker's own history kept current by the live quotes.
 */
export class ExpertRunner extends Emitter {
  private program: CompiledProgram | null = null;
  private fileName: string | null = null;
  private expert: Expert | null = null;
  private master: TradingAccount | null = null;
  private market = new MarketData();
  private loading = 0;
  private status: StrategyInfo['status'] = 'idle';
  private detail: string | null = null;
  private commentText = '';
  private panel: string[] = [];
  private loadedAt: number | null = null;
  private timeframe = 1;
  private lastServerTime = 0;
  /** The last quote's time and when it arrived, for the EA's millisecond clock. */
  private lastTickAt = 0;
  private lastTickWall = 0;
  private lastClock = 0;
  private stopUnsub: (() => void) | null = null;
  /** Set by the bot: false blocks the EA's orders as AutoTrading-off would. */
  tradingAllowed = true;
  /**
   * The AI's guard over new entries: a reason to refuse one, or null to let
   * it through. Exits, stop changes and cancels are never asked.
   */
  entryGuard: ((side: 'buy' | 'sell', kind: 'market' | 'pending') => string | null) | null = null;
  private guardNotedAt = 0;
  /** Tickets of pending orders this EA placed, so their fills are known to be its own. */
  private readonly placed = new Set<number>();

  /** True (once) when a new position is the fill of one of this EA's pending orders. */
  claims(position: Position): boolean {
    if (!this.placed.has(position.ticket)) return false;
    this.placed.delete(position.ticket);
    return true;
  }

  /** The guard's answer, journalled at most every 30 s so a vetoed EA does not flood the log. */
  private vetoed(side: 'buy' | 'sell', kind: 'market' | 'pending', accountId: string): string | null {
    const reason = this.entryGuard?.(side, kind) ?? null;
    if (reason) {
      const now = Date.now();
      if (now - this.guardNotedAt > 30_000) {
        this.guardNotedAt = now;
        this.journal.write('warn', accountId, `AI guard refused ${this.info().name}'s ${side.toUpperCase()} ${kind === 'pending' ? 'order' : 'entry'} — ${reason}`);
      }
    }
    return reason;
  }

  constructor(
    private readonly journal: Journal,
    private readonly dispatcher: () => CopyTradeEngine | null,
    private history: HistoryProvider | null = null,
    private readonly storage?: KeyValueStore,
  ) {
    super();
  }

  setHistoryProvider(provider: HistoryProvider | null): void {
    this.history = provider;
  }

  get loaded(): boolean {
    return this.program !== null;
  }

  get running(): boolean {
    return this.expert?.status === 'running';
  }

  /** Replaces the strategy. A running expert is detached first. */
  async load(program: CompiledProgram, fileName: string): Promise<void> {
    if (this.running) await this.stop();
    this.program = program;
    this.fileName = fileName;
    this.loadedAt = Date.now();
    this.status = 'idle';
    this.detail = null;
    this.commentText = '';
    this.panel = [];
    this.publish();
  }

  unload(): void {
    this.program = null;
    this.fileName = null;
    this.status = 'idle';
    this.detail = null;
    this.publish();
  }

  inputs(): StrategyInput[] {
    return (this.program?.inputs ?? []) as StrategyInput[];
  }

  info(): StrategyInfo {
    return {
      source: 'mql5',
      name: this.program?.name ?? 'No expert loaded',
      fileName: this.fileName,
      status: this.status,
      detail: this.detail,
      inputs: this.inputs(),
      diagnostics: this.program?.diagnostics ?? [],
      fingerprint: null,
      comment: this.commentText,
      panel: this.panel,
      lastTickMs: this.expert ? Math.round(this.expert.lastTickMs * 1000) / 1000 : null,
      ticks: this.expert?.ticksProcessed ?? 0,
      loadedAt: this.loadedAt,
    };
  }

  private publish(): void {
    this.emit('strategy', this.info());
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  async start(master: TradingAccount, timeframe: number, inputs: Record<string, unknown>): Promise<boolean> {
    if (!this.program) {
      this.journal.write('error', null, 'Upload an expert advisor before arming the bot in EA mode.');
      return false;
    }
    if (this.running) return true;
    this.master = master;
    this.timeframe = timeframe;
    this.market = new MarketData();
    this.stopUnsub?.();
    this.stopUnsub = this.market.onRequest(({ symbol, timeframe: tf }) => void this.loadSeries(symbol, tf));
    this.status = 'waiting';
    this.detail = 'loading history';
    this.publish();

    // History for the chart first, so OnInit sees a populated chart as it would in MT5.
    this.market.get(master.symbol, timeframe);
    await this.whenLoaded();

    const host = this.createHost(master);
    this.expert = new Expert(this.program, host, {
      status: (status, detail) => {
        this.status = status === 'running' ? 'running' : status === 'failed' ? 'failed' : status === 'stopped' ? 'stopped' : 'idle';
        this.detail = detail;
        this.publish();
      },
    });
    const ok = await this.expert.start(inputs);
    if (!ok) {
      this.status = 'failed';
      this.detail = this.expert.error;
      this.publish();
      return false;
    }
    this.status = 'running';
    this.detail = null;
    this.publish();
    return true;
  }

  async stop(): Promise<void> {
    const expert = this.expert;
    if (!expert) return;
    await expert.stop();
    this.expert = null;
    this.status = 'stopped';
    this.publish();
  }

  /** Feeds a quote: bars first, then the expert, once its history is synchronised. */
  onTick(tick: Tick): void {
    const master = this.master;
    if (!master || !this.expert) return;
    if (tick.symbol !== master.symbol) return;
    const serverTime = tick.time / 1000 + master.serverOffset;
    this.lastServerTime = Math.floor(serverTime);
    this.lastTickAt = tick.time;
    this.lastTickWall = Date.now();
    const point = master.spec().point ?? master.spec().tickSize;
    this.market.onQuote(tick.symbol, tick.bid, tick.ask, serverTime, point);
    if (this.loading > 0) return;
    this.expert.tick();
  }

  clockMs(): number {
    const now = this.lastTickAt > 0 ? this.lastTickAt + (Date.now() - this.lastTickWall) : Date.now();
    this.lastClock = Math.max(this.lastClock, now);
    return this.lastClock;
  }

  /** Resolves once the expert has worked through every queued event. */
  async idle(): Promise<void> {
    await this.expert?.idle();
  }

  /** The account changed outside the EA's own requests. */
  notifyTrade(): void {
    this.expert?.notifyTrade();
  }

  private loadWaiters: (() => void)[] = [];

  /** Resolves the moment every requested series has arrived. */
  private whenLoaded(): Promise<void> {
    if (this.loading === 0) return Promise.resolve();
    return new Promise((resolve) => this.loadWaiters.push(resolve));
  }

  private async loadSeries(symbol: string, timeframe: number): Promise<void> {
    const master = this.master;
    if (!master) return;
    if (!this.history) {
      this.market.seed(symbol, timeframe, []);
      return;
    }
    this.loading += 1;
    try {
      const bars = await this.history.loadBars(master, symbol, timeframe, 1000);
      this.market.seed(symbol, timeframe, bars);
    } catch (err) {
      this.journal.write('warn', master.id, `History for ${symbol} (${timeframe}) could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
      this.market.seed(symbol, timeframe, []);
    } finally {
      this.loading -= 1;
      if (this.loading === 0) {
        const waiters = this.loadWaiters;
        this.loadWaiters = [];
        for (const resolve of waiters) resolve();
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Host                                                                */
  /* ------------------------------------------------------------------ */

  private toServer(ms: number, master: TradingAccount): number {
    return Math.floor(ms / 1000) + master.serverOffset;
  }

  private hostSpec(master: TradingAccount, symbol: string): HostSymbolSpec {
    const spec = master.spec(symbol);
    const point = spec.point ?? spec.tickSize;
    const tickValue = spec.tickValue ?? spec.tickSize * spec.contractSize;
    return {
      name: symbol,
      description: spec.description ?? symbol,
      digits: spec.digits,
      point,
      tickSize: spec.tickSize,
      tickValue,
      tickValueProfit: tickValue,
      tickValueLoss: tickValue,
      contractSize: spec.contractSize,
      volumeMin: spec.minLot,
      volumeMax: spec.maxLot,
      volumeStep: spec.lotStep,
      volumeLimit: 0,
      stopsLevel: spec.stopsLevel ?? 0,
      freezeLevel: spec.freezeLevel ?? 0,
      tradeMode: TRADE_MODES[spec.tradeMode ?? 'full'],
      fillingFlags: spec.fillingFlags ?? 3,
      executionMode: 2,
      calcMode: 4,
      orderMode: 127,
      swapLong: 0,
      swapShort: 0,
      marginInitial: 0,
      marginMaintenance: 0,
      currencyBase: symbol.slice(0, 3),
      currencyProfit: master.config.currency,
      currencyMargin: symbol.slice(0, 3),
      path: symbol,
    };
  }

  private hostPosition(p: Position, master: TradingAccount): HostPosition {
    const open = this.toServer(p.openTime, master);
    return {
      ticket: p.ticket,
      identifier: p.ticket,
      symbol: p.symbol,
      type: p.side === 'buy' ? 0 : 1,
      volume: p.volume,
      priceOpen: p.openPrice,
      priceCurrent: p.currentPrice,
      sl: p.stopLoss ?? 0,
      tp: p.takeProfit ?? 0,
      // MT5 reports position profit before commission, which is booked on the deals.
      profit: Math.round((p.profit + p.commission) * 100) / 100,
      swap: p.swap,
      commission: -p.commission,
      magic: p.magic,
      comment: p.comment,
      externalId: '',
      time: open,
      timeMsc: p.openTime + master.serverOffset * 1000,
      timeUpdate: open,
      reason: p.origin === 'bot' || p.origin === 'recovery' ? 3 : 0,
    };
  }

  private hostOrder(o: PendingOrder, master: TradingAccount): HostOrder {
    const setup = this.toServer(o.time, master);
    return {
      ticket: o.ticket,
      symbol: o.symbol,
      type: PENDING_CODES[o.type],
      state: 1,
      volumeInitial: o.volume,
      volumeCurrent: o.volume,
      priceOpen: o.openPrice,
      priceCurrent: master.quote()?.bid ?? o.openPrice,
      priceStopLimit: o.stopLimitPrice ?? 0,
      sl: o.stopLoss ?? 0,
      tp: o.takeProfit ?? 0,
      timeSetup: setup,
      timeSetupMsc: o.time + master.serverOffset * 1000,
      timeExpiration: o.expiration ? this.toServer(o.expiration, master) : 0,
      timeDone: 0,
      timeDoneMsc: 0,
      typeFilling: 0,
      typeTime: o.expiration ? 2 : 0,
      magic: o.magic,
      comment: o.comment,
      externalId: '',
      positionId: 0,
      positionById: 0,
      reason: 3,
    };
  }

  private hostDeal(d: Deal, master: TradingAccount): HostDeal {
    const types = { buy: 0, sell: 1, balance: 2, other: 5 } as const;
    const entries = { in: 0, out: 1, inout: 2, 'out-by': 3 } as const;
    const reasons = { client: 0, expert: 3, sl: 4, tp: 5, so: 6, other: 0 } as const;
    return {
      ticket: d.ticket,
      order: Number(d.orderId) || d.ticket,
      time: this.toServer(d.time, master),
      timeMsc: d.time + master.serverOffset * 1000,
      type: types[d.type],
      entry: entries[d.entry],
      magic: d.magic,
      reason: reasons[d.reason],
      positionId: Number(d.positionId) || 0,
      volume: d.volume,
      price: d.price,
      commission: d.commission,
      swap: d.swap,
      profit: d.profit,
      fee: 0,
      sl: d.stopLoss ?? 0,
      tp: d.takeProfit ?? 0,
      symbol: d.symbol,
      comment: d.comment,
      externalId: '',
    };
  }

  private hostAccount(master: TradingAccount): HostAccount {
    const s = master.state();
    return {
      login: Number(s.login) || 0,
      name: s.name,
      server: s.server,
      company: s.broker,
      currency: s.currency,
      balance: s.balance,
      credit: 0,
      equity: s.equity,
      profit: Math.round((s.equity - s.balance) * 100) / 100,
      margin: s.margin,
      freeMargin: s.freeMargin,
      marginLevel: s.marginLevel,
      leverage: s.leverage,
      tradeMode: s.accountType === 'real' ? 2 : s.accountType === 'contest' ? 1 : 0,
      marginMode: 2,
      marginSoCall: 50,
      marginSoSo: 30,
      marginSoMode: 0,
      limitOrders: 1024,
      currencyDigits: 2,
    };
  }

  private panelFrom(objects: ChartObject[]): string[] {
    const labels: PanelObject[] = [];
    for (const obj of objects) {
      // OBJ_LABEL, OBJ_EDIT, OBJ_BUTTON and OBJ_TEXT carry text an EA means to be read.
      if (![102, 107, 103, 101].includes(obj.type)) continue;
      const text = obj.string.get(1);
      if (!text) continue;
      labels.push({ text, y: obj.integer.get(27) ?? 0, x: obj.integer.get(26) ?? 0 });
    }
    labels.sort((a, b) => a.y - b.y || a.x - b.x);
    return labels.map((l) => l.text);
  }

  private createHost(master: TradingAccount): ExpertHost {
    const runner = this;
    const market = this.market;
    const journal = this.journal;
    const logLevel = (level: LogLevel): 'info' | 'warn' | 'error' | 'trade' =>
      level === 'error' ? 'error' : level === 'alert' || level === 'warn' ? 'warn' : level === 'trade' ? 'trade' : 'info';

    const failure = (retcode: number, comment: string): TradeResult => {
      const q = master.quote();
      return { retcode, deal: 0, order: 0, volume: 0, price: 0, bid: q?.bid ?? 0, ask: q?.ask ?? 0, comment, requestId: 0, retcodeExternal: 0 };
    };
    const done = (fields: Partial<TradeResult>): TradeResult => {
      const q = master.quote();
      return { retcode: RETCODE.DONE, deal: 0, order: 0, volume: 0, price: 0, bid: q?.bid ?? 0, ask: q?.ask ?? 0, comment: 'Request executed', requestId: 0, retcodeExternal: 0, ...fields };
    };
    const byTicket = (ticket: number) => master.listPositions().find((p) => p.ticket === ticket);
    const orderByTicket = (ticket: number) => master.listOrders().find((o) => o.ticket === ticket);

    return {
      market,
      symbol: master.symbol,
      timeframe: this.timeframe,
      symbols: () => [master.symbol],
      spec: (symbol) => (symbol === master.symbol ? runner.hostSpec(master, symbol) : null),
      quote: (symbol): HostQuote | null => {
        const q = master.quote();
        if (!q || symbol !== master.symbol) return null;
        const serverMs = q.time + master.serverOffset * 1000;
        return { bid: q.bid, ask: q.ask, last: q.bid, time: Math.floor(serverMs / 1000), timeMsc: serverMs, volume: 1 };
      },
      serverTime: () => runner.lastServerTime || Math.floor(Date.now() / 1000) + master.serverOffset,
      // Market time, running on between quotes: live it is the wall clock; a
      // replay faster than real time keeps an EA's millisecond throttles honest.
      clockMs: () => runner.clockMs(),
      serverOffset: () => master.serverOffset,
      account: () => runner.hostAccount(master),
      connected: () => master.connected,
      tradeAllowed: () => runner.tradingAllowed && master.connected,
      positions: () => master.listPositions().map((p) => runner.hostPosition(p, master)),
      orders: () => master.listOrders().map((o) => runner.hostOrder(o, master)),
      deals: (from, to) =>
        master
          .deals()
          .map((d) => runner.hostDeal(d, master))
          .filter((d) => d.time >= from && d.time <= to),
      historyOrders: () => [],
      async orderSend(req: TradeRequest): Promise<TradeResult> {
        const dispatcher = runner.dispatcher();
        // Prices exactly on the broker's tick grid: an EA's `open - 0.2` is
        // 4355.820000000001 in floating point, which a trade server refuses.
        const spec = master.spec(req.symbol || master.symbol);
        const px = (v: number): number | null => (v > 0 ? roundPrice(spec, v) : null);
        switch (req.action) {
          case TRADE_ACTION.DEAL: {
            if (req.position > 0) {
              const position = byTicket(req.position);
              if (!position) return failure(RETCODE.POSITION_CLOSED, `position #${req.position} is not open`);
              const volume = req.volume > 0 && req.volume < position.volume ? req.volume : undefined;
              const trade = dispatcher
                ? await dispatcher.close(master, position.id, 'manual', volume)
                : await master.submitClose(position.id, 'manual', volume);
              if (!trade) return failure(RETCODE.REJECT, 'close rejected by the broker');
              return done({ deal: trade.ticket, order: trade.ticket, volume: trade.volume, price: trade.closePrice });
            }
            if (req.type !== 0 && req.type !== 1) return failure(RETCODE.INVALID, 'a market order must be a buy or a sell');
            const veto = runner.vetoed(req.type === 0 ? 'buy' : 'sell', 'market', master.id);
            if (veto) return failure(RETCODE.REJECT, `AI guard: ${veto}`);
            const open: OpenRequest = {
              symbol: req.symbol || master.symbol,
              side: req.type === 0 ? 'buy' : 'sell',
              volume: req.volume,
              stopLoss: px(req.sl),
              takeProfit: px(req.tp),
              origin: 'bot',
              comment: req.comment,
              magic: req.magic,
              slippagePoints: req.deviation,
            };
            const result = dispatcher ? await dispatcher.open(master, open) : await master.submit(open);
            if (!result.ok) return failure(retcodeFor(result.error, result.code), result.error);
            runner.emit('opened', result.position);
            return done({ deal: result.position.ticket, order: result.position.ticket, volume: result.position.volume, price: result.position.openPrice });
          }
          case TRADE_ACTION.SLTP: {
            const position = byTicket(req.position);
            if (!position) return failure(RETCODE.POSITION_CLOSED, `position #${req.position} is not open`);
            const sl = px(req.sl);
            const tp = px(req.tp);
            if (sl === position.stopLoss && tp === position.takeProfit) return { ...done({}), retcode: RETCODE.NO_CHANGES };
            const result = dispatcher ? await dispatcher.modify(master, position.id, sl, tp) : await master.submitModify(position.id, sl, tp);
            return result.ok ? done({}) : failure(retcodeFor(result.error), result.error);
          }
          case TRADE_ACTION.PENDING: {
            const type = PENDING_TYPES[req.type];
            if (!type) return failure(RETCODE.INVALID, 'invalid pending order type');
            const vetoPending = runner.vetoed(type.startsWith('buy') ? 'buy' : 'sell', 'pending', master.id);
            if (vetoPending) return failure(RETCODE.REJECT, `AI guard: ${vetoPending}`);
            const pending: PendingRequest = {
              symbol: req.symbol || master.symbol,
              type,
              volume: req.volume,
              openPrice: px(req.price) ?? req.price,
              stopLimitPrice: px(req.stoplimit),
              stopLoss: px(req.sl),
              takeProfit: px(req.tp),
              expiration: req.expiration > 0 ? (req.expiration - master.serverOffset) * 1000 : null,
              magic: req.magic,
              comment: req.comment,
            };
            // Mirrored onto every follower, so each broker fills its own copy at this price.
            const result = dispatcher ? await dispatcher.placePending(master, pending) : await master.submitPending(pending);
            if (!result.ok) return failure(retcodeFor(result.error), result.error);
            runner.placed.add(result.order.ticket);
            if (runner.placed.size > 500) runner.placed.delete(runner.placed.values().next().value!);
            return done({ order: result.order.ticket, volume: result.order.volume, price: result.order.openPrice });
          }
          case TRADE_ACTION.MODIFY: {
            const order = orderByTicket(req.order);
            if (!order) return failure(RETCODE.INVALID_ORDER, `order #${req.order} not found`);
            const expiration = req.expiration > 0 ? (req.expiration - master.serverOffset) * 1000 : null;
            const price = px(req.price) ?? req.price;
            const result = dispatcher
              ? await dispatcher.modifyPending(master, order.id, price, px(req.sl), px(req.tp), expiration)
              : await master.modifyPending(order.id, price, px(req.sl), px(req.tp), expiration);
            return result.ok ? done({ order: order.ticket }) : failure(retcodeFor(result.error), result.error);
          }
          case TRADE_ACTION.REMOVE: {
            const order = orderByTicket(req.order);
            if (!order) return failure(RETCODE.INVALID_ORDER, `order #${req.order} not found`);
            const result = dispatcher ? await dispatcher.cancelPending(master, order.id) : await master.cancelPending(order.id);
            return result.ok ? done({ order: order.ticket }) : failure(retcodeFor(result.error), result.error);
          }
          case TRADE_ACTION.CLOSE_BY: {
            const a = byTicket(req.position);
            const b = byTicket(req.positionBy);
            if (!a || !b) return failure(RETCODE.POSITION_CLOSED, 'position not open');
            const volume = Math.min(a.volume, b.volume);
            const close = (p: Position) =>
              dispatcher ? dispatcher.close(master, p.id, 'manual', volume < p.volume ? volume : undefined) : master.submitClose(p.id, 'manual', volume < p.volume ? volume : undefined);
            const [x, y] = await Promise.all([close(a), close(b)]);
            return x && y ? done({ volume }) : failure(RETCODE.REJECT, 'close by rejected');
          }
          default:
            return failure(RETCODE.INVALID, `trade action ${req.action} is not supported`);
        }
      },
      log(level, message) {
        journal.write(logLevel(level), master.id, `${runner.program?.name ?? 'EA'}: ${message}`);
        if (level === 'alert') runner.emit('alert', message);
      },
      comment(text) {
        runner.commentText = text;
        runner.publish();
      },
      objects(objects) {
        runner.panel = runner.panelFrom(objects);
        runner.publish();
      },
      notify(text) {
        runner.emit('alert', text);
      },
      storage: this.storage,
    } satisfies ExpertHost & { market: MarketData };
  }
}
