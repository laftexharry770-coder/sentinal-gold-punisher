import {
  DEFAULT_COPY_SETTINGS,
  getSymbolSpec,
  registerSymbolSpec,
  roundLot,
  roundPrice,
  type AccountConfig,
  type AccountState,
  type Candle,
  type ClosedTrade,
  type CloseReason,
  type CopySettings,
  type Deal,
  type PendingOrder,
  type PendingType,
  type Position,
  type PositionOrigin,
  type SymbolSpec,
  type Tick,
} from '@sentinal/shared';
import { METAAPI_TIMEFRAMES, type Bar } from '@sentinal/mql5';
import type { HistoryProvider } from '../engine/expert.js';
import type { Runtime } from '../runtime.js';
import { round, uid } from '../util.js';
import {
  TradingAccount,
  type ActionResult,
  type OpenRequest,
  type OpenResult,
  type PendingRequest,
  type PendingResult,
} from './account.js';
import type { AccountFactory } from './manager.js';

/* ------------------------------------------------------------------------ */
/* The slice of the MetaApi SDK this adapter uses                            */
/*                                                                          */
/* Declared structurally so the engine carries no dependency on the SDK: the */
/* browser build hands in `new MetaApi(token)` from metaapi.cloud-sdk, the   */
/* server hands in the Node build, and the tests hand in a fake.             */
/* ------------------------------------------------------------------------ */

type When = Date | string;

export interface MtPosition {
  id: number | string;
  type: string;
  symbol: string;
  magic?: number;
  time: When;
  brokerTime?: string;
  openPrice: number;
  currentPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  volume: number;
  swap?: number;
  profit?: number;
  commission?: number;
  comment?: string;
  clientId?: string;
}

export interface MtOrder {
  id: number | string;
  type: string;
  state?: string;
  magic?: number;
  time: When;
  symbol: string;
  openPrice: number;
  stopLoss?: number;
  takeProfit?: number;
  volume: number;
  currentVolume?: number;
  comment?: string;
  clientId?: string;
  expirationType?: string;
  expirationTime?: When;
  stopLimitPrice?: number;
}

export interface MtDeal {
  id: string;
  type: string;
  entryType?: string;
  symbol?: string;
  magic?: number;
  time: When;
  volume?: number;
  price?: number;
  commission?: number;
  swap?: number;
  profit: number;
  positionId?: string;
  orderId?: string;
  comment?: string;
  clientId?: string;
  reason?: string;
  stopLoss?: number;
  takeProfit?: number;
}

export interface MtSpecification {
  symbol: string;
  tickSize: number;
  minVolume: number;
  maxVolume: number;
  volumeStep: number;
  fillingModes?: string[];
  contractSize: number;
  tradeMode?: string;
  digits: number;
  point: number;
  description?: string;
  stopsLevel?: number;
  freezeLevel?: number;
}

export interface MtPrice {
  symbol: string;
  bid: number;
  ask: number;
  profitTickValue?: number;
  lossTickValue?: number;
  time: When;
  brokerTime: string;
}

export interface MtAccountInformation {
  platform?: string;
  broker?: string;
  currency?: string;
  server?: string;
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  leverage?: number;
  marginLevel?: number;
  tradeAllowed?: boolean;
  name?: string;
  login?: number | string;
  type?: string;
}

export interface MtCandle {
  time: When;
  brokerTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  tickVolume: number;
  spread?: number;
  volume?: number;
}

export interface MtTradeResponse {
  numericCode?: number;
  stringCode?: string;
  message?: string;
  orderId?: string;
  positionId?: string;
}

export interface MtTradeOptions {
  comment?: string;
  clientId?: string;
  magic?: number;
  slippage?: number;
  expiration?: { type: string; time?: Date };
}

/** A stop as a price, or as money / points the broker converts at the fill. */
export type MtStop = number | { value: number; units: string } | undefined;

export interface MtTerminalState {
  readonly connected: boolean;
  readonly connectedToBroker: boolean;
  readonly accountInformation: MtAccountInformation | undefined;
  readonly positions: MtPosition[];
  readonly orders: MtOrder[];
  readonly specifications: MtSpecification[];
  specification(symbol: string): MtSpecification | undefined;
  price(symbol: string): MtPrice | undefined;
}

export interface MtConnection {
  connect(): Promise<unknown>;
  waitSynchronized(opts?: { timeoutInSeconds?: number }): Promise<unknown>;
  subscribeToMarketData(symbol: string, subscriptions?: { type: string; intervalInMilliseconds?: number }[]): Promise<unknown>;
  addSynchronizationListener(listener: never): void;
  removeSynchronizationListener(listener: never): void;
  close(): Promise<unknown>;
  readonly terminalState: MtTerminalState;
  readonly historyStorage: { readonly deals: MtDeal[] };
  createMarketBuyOrder(symbol: string, volume: number, stopLoss?: MtStop, takeProfit?: MtStop, options?: MtTradeOptions): Promise<MtTradeResponse>;
  createMarketSellOrder(symbol: string, volume: number, stopLoss?: MtStop, takeProfit?: MtStop, options?: MtTradeOptions): Promise<MtTradeResponse>;
  createLimitBuyOrder(symbol: string, volume: number, openPrice: number, stopLoss?: MtStop, takeProfit?: MtStop, options?: MtTradeOptions): Promise<MtTradeResponse>;
  createLimitSellOrder(symbol: string, volume: number, openPrice: number, stopLoss?: MtStop, takeProfit?: MtStop, options?: MtTradeOptions): Promise<MtTradeResponse>;
  createStopBuyOrder(symbol: string, volume: number, openPrice: number, stopLoss?: MtStop, takeProfit?: MtStop, options?: MtTradeOptions): Promise<MtTradeResponse>;
  createStopSellOrder(symbol: string, volume: number, openPrice: number, stopLoss?: MtStop, takeProfit?: MtStop, options?: MtTradeOptions): Promise<MtTradeResponse>;
  createStopLimitBuyOrder(symbol: string, volume: number, openPrice: number, stopLimitPrice: number, stopLoss?: MtStop, takeProfit?: MtStop, options?: MtTradeOptions): Promise<MtTradeResponse>;
  createStopLimitSellOrder(symbol: string, volume: number, openPrice: number, stopLimitPrice: number, stopLoss?: MtStop, takeProfit?: MtStop, options?: MtTradeOptions): Promise<MtTradeResponse>;
  modifyPosition(positionId: string, stopLoss?: MtStop, takeProfit?: MtStop): Promise<MtTradeResponse>;
  closePosition(positionId: string, options: MtTradeOptions): Promise<MtTradeResponse>;
  closePositionPartially(positionId: string, volume: number, options: MtTradeOptions): Promise<MtTradeResponse>;
  modifyOrder(orderId: string, openPrice: number, stopLoss?: MtStop, takeProfit?: MtStop): Promise<MtTradeResponse>;
  cancelOrder(orderId: string): Promise<MtTradeResponse>;
}

export interface MtAccount {
  readonly id: string;
  readonly name: string;
  readonly login: string;
  readonly server: string;
  readonly state: string;
  readonly connectionStatus: string;
  readonly region?: string;
  readonly type?: string;
  readonly version?: number;
  readonly magic: number;
  readonly quoteStreamingIntervalInSeconds?: number;
  reload(): Promise<void>;
  deploy(): Promise<void>;
  redeploy(): Promise<void>;
  waitDeployed(timeoutInSeconds?: number, intervalInMilliseconds?: number): Promise<void>;
  waitConnected(timeoutInSeconds?: number, intervalInMilliseconds?: number): Promise<void>;
  getStreamingConnection(): MtConnection;
  update(dto: { name: string; server: string; magic: number; quoteStreamingIntervalInSeconds?: number }): Promise<void>;
  getHistoricalCandles(symbol: string, timeframe: string, startTime?: Date, limit?: number): Promise<MtCandle[]>;
}

export interface MetaApiClient {
  readonly metatraderAccountApi: {
    getAccountsWithInfiniteScrollPagination(filter?: { limit?: number; offset?: number }): Promise<MtAccount[]>;
    getAccount(accountId: string): Promise<MtAccount>;
    createAccount(account: never): Promise<MtAccount>;
  };
  close(): void;
}

/* ------------------------------------------------------------------------ */
/* Conversions                                                              */
/* ------------------------------------------------------------------------ */

function ms(value: When | undefined): number {
  if (value === undefined) return Date.now();
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

/** MetaApi's broker time ("2026-09-24 11:05:07.123") read as the seconds MQL5 sees. */
export function brokerSeconds(brokerTime: string): number {
  return Math.floor(Date.parse(`${brokerTime.replace(' ', 'T')}Z`) / 1000);
}

/** Broker server time minus UTC, rounded to the quarter hour every broker uses. */
export function serverOffsetOf(time: When, brokerTime: string): number {
  const offset = brokerSeconds(brokerTime) - ms(time) / 1000;
  return Math.round(offset / 900) * 900;
}

const PENDING_FROM_MT: Record<string, PendingType> = {
  ORDER_TYPE_BUY_LIMIT: 'buy-limit',
  ORDER_TYPE_SELL_LIMIT: 'sell-limit',
  ORDER_TYPE_BUY_STOP: 'buy-stop',
  ORDER_TYPE_SELL_STOP: 'sell-stop',
  ORDER_TYPE_BUY_STOP_LIMIT: 'buy-stop-limit',
  ORDER_TYPE_SELL_STOP_LIMIT: 'sell-stop-limit',
};

const TRADE_MODES: Record<string, SymbolSpec['tradeMode']> = {
  SYMBOL_TRADE_MODE_DISABLED: 'disabled',
  SYMBOL_TRADE_MODE_LONGONLY: 'long-only',
  SYMBOL_TRADE_MODE_SHORTONLY: 'short-only',
  SYMBOL_TRADE_MODE_CLOSEONLY: 'close-only',
  SYMBOL_TRADE_MODE_FULL: 'full',
};

function dealReason(reason: string | undefined): Deal['reason'] {
  switch (reason) {
    case 'DEAL_REASON_CLIENT':
    case 'DEAL_REASON_MOBILE':
    case 'DEAL_REASON_WEB':
      return 'client';
    case 'DEAL_REASON_EXPERT':
      return 'expert';
    case 'DEAL_REASON_SL':
      return 'sl';
    case 'DEAL_REASON_TP':
      return 'tp';
    case 'DEAL_REASON_SO':
      return 'so';
    default:
      return 'other';
  }
}

function dealType(type: string): Deal['type'] {
  if (type === 'DEAL_TYPE_BUY') return 'buy';
  if (type === 'DEAL_TYPE_SELL') return 'sell';
  if (type === 'DEAL_TYPE_BALANCE' || type === 'DEAL_TYPE_CREDIT' || type === 'DEAL_TYPE_BONUS') return 'balance';
  return 'other';
}

function dealEntry(entry: string | undefined): Deal['entry'] {
  switch (entry) {
    case 'DEAL_ENTRY_OUT':
      return 'out';
    case 'DEAL_ENTRY_INOUT':
      return 'inout';
    case 'DEAL_ENTRY_OUT_BY':
      return 'out-by';
    default:
      return 'in';
  }
}

function isExit(deal: MtDeal): boolean {
  return deal.entryType === 'DEAL_ENTRY_OUT' || deal.entryType === 'DEAL_ENTRY_OUT_BY' || deal.entryType === 'DEAL_ENTRY_INOUT';
}

/** The rejection an order came back with, as text plus MetaTrader's return code. */
export function describeTradeError(err: unknown): { error: string; code?: string } {
  if (err && typeof err === 'object') {
    const e = err as { message?: unknown; stringCode?: unknown; name?: unknown };
    const code = typeof e.stringCode === 'string' ? e.stringCode : undefined;
    const message = typeof e.message === 'string' && e.message ? e.message : code ?? 'order rejected';
    return { error: message, code };
  }
  return { error: String(err) };
}

/** Client ids the dispatcher and the copier stamp on orders, so a reload can relink copies. */
const OWN_CLIENT_ID = /^[SM][0-9a-z]{2,24}$/;

function newClientId(): string {
  return `S${Date.now().toString(36).slice(-5)}${Math.floor(Math.random() * 46656).toString(36).padStart(3, '0')}`;
}

/** The gold instrument on a broker, whatever it decorates the name with. */
export function findGoldSymbol(specs: MtSpecification[], preferred?: string): MtSpecification | undefined {
  if (preferred) {
    const exact = specs.find((s) => s.symbol === preferred) ?? specs.find((s) => s.symbol.toUpperCase() === preferred.toUpperCase());
    if (exact) return exact;
  }
  const gold = specs.filter((s) => {
    const letters = s.symbol.toUpperCase().replace(/[^A-Z]/g, '');
    return letters.startsWith('XAUUSD') || letters === 'GOLD' || /^GOLD[A-Z]?$/.test(letters);
  });
  const tradable = gold.filter((s) => !s.tradeMode || s.tradeMode === 'SYMBOL_TRADE_MODE_FULL');
  const pool = tradable.length > 0 ? tradable : gold;
  return pool.sort((a, b) => (a.symbol === 'XAUUSD' ? -1 : b.symbol === 'XAUUSD' ? 1 : a.symbol.length - b.symbol.length))[0];
}

/* ------------------------------------------------------------------------ */
/* One MetaTrader account, through MetaApi                                   */
/* ------------------------------------------------------------------------ */

export interface MetaApiAccountOptions {
  /** MetaApi's handle for the account, fetched when the account connects. */
  handle: () => Promise<MtAccount>;
  /** Paper execution: the broker's quotes, contract and history, simulated fills. */
  paper?: boolean;
  log?: (level: 'info' | 'warn' | 'error', message: string, accountId: string) => void;
  /** Seconds allowed for the terminal to deploy, connect and synchronise. */
  timeoutSec?: number;
  /** How long an order waits for the broker's own report of the fill, ms. */
  fillWaitMs?: number;
}

interface CloseWait {
  timer: ReturnType<typeof setTimeout>;
  /** Volume closed, for a partial close; undefined for a full close. */
  volume?: number;
  waiters: ((trade: ClosedTrade | null) => void)[];
}

/**
 * A MetaTrader 4/5 account traded through MetaApi.
 *
 * The book is MetaTrader's own, kept current by MetaApi's streaming
 * connection: positions, pending orders, deals, balance, equity and margin all
 * come from the broker, so what the terminal shows is what the account holds.
 * Orders go straight out on the streaming socket with nothing awaited first,
 * each stamped with a client id so the fill the stream reports is recognised
 * as the order that caused it, and copies can be matched to their master after
 * a reload.
 *
 * Stops and targets are held by the broker, never checked here, and nothing is
 * filled locally. In paper mode the same connection supplies quotes, contract
 * and history while fills are simulated against those quotes.
 */
export class MetaApiAccount extends TradingAccount {
  readonly paper: boolean;
  private handleRef: MtAccount | null = null;
  private connection: MtConnection | null = null;
  private readonly listener: Record<string, (...args: never[]) => unknown>;
  private specCache: SymbolSpec | null = null;
  private info: MtAccountInformation | null = null;
  private synced = false;
  private connecting: Promise<void> | null = null;

  /** Broker position id → local position id. */
  private readonly byTicket = new Map<string, string>();
  private readonly orderByTicket = new Map<string, string>();
  /** Orders sent and not yet answered, by client id — their fills are ours. */
  private readonly inflight = new Map<string, OpenRequest>();
  private readonly positionWaiters = new Map<string, ((p: Position) => void)[]>();
  private readonly closeReasons = new Map<string, CloseReason>();
  private readonly closeWaits = new Map<string, CloseWait>();
  private readonly dealIds = new Set<string>();

  constructor(
    config: AccountConfig,
    private readonly opts: MetaApiAccountOptions,
  ) {
    super(config);
    this.paper = opts.paper ?? false;
    this.connected = false;
    this.listener = this.createListener();
  }

  /** MetaApi's id for this account. */
  get metaApiId(): string | undefined {
    return this.config.metaApiId;
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.opts.log?.(level, message, this.id);
  }

  /* ------------------------------------------------------------------ */
  /* Connection                                                          */
  /* ------------------------------------------------------------------ */

  /** Resolves once the account is synchronised, rejects if it cannot be. */
  ready(): Promise<void> {
    return this.connecting ?? this.connect();
  }

  override connect(): Promise<void> {
    if (!this.connecting) {
      this.connecting = this.open_().catch((err: unknown) => {
        this.connecting = null;
        throw err;
      });
    }
    return this.connecting;
  }

  private async open_(): Promise<void> {
    const timeout = this.opts.timeoutSec ?? 300;
    this.connected = false;
    this.connectionError = null;
    this.emit('changed', this);
    try {
      const account = this.handleRef ?? (this.handleRef = await this.opts.handle());
      if (account.state !== 'DEPLOYED') {
        this.log('info', `Starting MetaApi's server for ${account.login} (${account.server}) — this takes up to a minute the first time`);
        if (account.state !== 'DEPLOYING') await account.deploy();
        await account.waitDeployed(timeout);
      }
      await account.waitConnected(timeout);

      const connection = account.getStreamingConnection();
      this.connection = connection;
      connection.addSynchronizationListener(this.listener as never);
      await connection.connect();
      await connection.waitSynchronized({ timeoutInSeconds: timeout });

      const terminal = connection.terminalState;
      const gold = findGoldSymbol(terminal.specifications, this.config.symbol);
      if (!gold) {
        const offered = terminal.specifications.map((s) => s.symbol).filter((s) => /XAU|GOLD/i.test(s));
        throw new Error(
          this.config.symbol
            ? `${this.config.symbol} is not offered on ${account.server}.${offered.length ? ` Gold here is: ${offered.join(', ')}.` : ''}`
            : `No gold symbol found on ${account.server}. Type the broker's symbol name when you connect.`,
        );
      }
      this.config = { ...this.config, symbol: gold.symbol };
      this.applySpecification(gold);

      const information = terminal.accountInformation;
      if (information) this.applyInformation(information, true);
      this.config = {
        ...this.config,
        login: String(information?.login ?? account.login),
        server: information?.server ?? account.server,
        broker: information?.broker ?? account.server,
      };

      // Adopt what the account already holds before listening for changes to it.
      for (const p of terminal.positions) this.upsertPosition(p, false);
      for (const o of terminal.orders) this.upsertOrder(o);
      for (const d of connection.historyStorage.deals.slice(-500)) this.recordDeal(d);

      const price = terminal.price(gold.symbol);
      if (price) this.applyPrice(price);
      // Quotes for the account's own symbol, as fast as the account streams them.
      await connection.subscribeToMarketData(gold.symbol, [{ type: 'quotes' }]);

      this.synced = true;
      this.connected = true;
      this.connectionError = null;
      this.log(
        'info',
        `${this.config.name}: synchronised with ${this.config.broker} — ${gold.symbol}, ${this.positions.size} open position(s)` +
          (this.quoteIntervalSec() ? `, quotes every ${this.quoteIntervalSec()}s` : ', tick-by-tick quotes'),
      );
      this.emit('synced', this);
      this.emit('changed', this);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.connected = false;
      this.connectionError = message;
      this.log('error', `${this.config.name}: ${message}`);
      this.emit('changed', this);
      throw err;
    }
  }

  override disconnect(): void {
    const connection = this.connection;
    this.connection = null;
    this.connecting = null;
    this.connected = false;
    this.synced = false;
    if (connection) {
      connection.removeSynchronizationListener(this.listener as never);
      void connection.close().catch(() => undefined);
    }
  }

  /** Leaving the terminal never touches the positions held at the broker. */
  override release(): void {
    this.disconnect();
  }

  /**
   * Switches the account to tick-by-tick quotes. MetaApi applies the change
   * when the account's server restarts, so the account reconnects.
   */
  async streamEveryTick(): Promise<void> {
    const account = this.handleRef;
    if (!account) throw new Error('connect the account first');
    if (account.quoteStreamingIntervalInSeconds === 0) return;
    await account.update({ name: account.name, server: account.server, magic: account.magic, quoteStreamingIntervalInSeconds: 0 });
    this.disconnect();
    await account.redeploy();
    await account.reload();
    await this.connect();
  }

  /* ------------------------------------------------------------------ */
  /* History                                                             */
  /* ------------------------------------------------------------------ */

  /** Bars in broker server time, oldest first, for an expert's series. */
  async loadBars(symbol: string, timeframe: number, count: number): Promise<Bar[]> {
    const account = this.handleRef ?? (this.handleRef = await this.opts.handle());
    const tf = METAAPI_TIMEFRAMES[timeframe];
    if (!tf) throw new Error(`MetaApi has no history for timeframe ${timeframe}`);
    const candles = await account.getHistoricalCandles(symbol, tf, undefined, Math.max(1, Math.min(1000, count)));
    return candles
      .map((c) => ({
        time: brokerSeconds(c.brokerTime),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        tickVolume: c.tickVolume,
        spread: c.spread ?? 0,
        realVolume: c.volume ?? 0,
      }))
      .sort((a, b) => a.time - b.time);
  }

  /** One-minute candles in UTC for the chart. */
  async loadCandles(count: number): Promise<Candle[]> {
    const account = this.handleRef ?? (this.handleRef = await this.opts.handle());
    const candles = await account.getHistoricalCandles(this.symbol, '1m', undefined, Math.max(1, Math.min(1000, count)));
    return candles
      .map((c) => ({ time: ms(c.time), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.tickVolume }))
      .sort((a, b) => a.time - b.time);
  }

  /* ------------------------------------------------------------------ */
  /* Contract, quotes and money                                          */
  /* ------------------------------------------------------------------ */

  override spec(symbol = this.symbol): SymbolSpec {
    if (this.specCache && symbol === this.specCache.symbol) return this.specCache;
    const known = this.connection?.terminalState.specification(symbol);
    return known ? this.toSpec(known) : getSymbolSpec(symbol);
  }

  private toSpec(s: MtSpecification): SymbolSpec {
    const price = this.connection?.terminalState.price(s.symbol);
    const flags = (s.fillingModes ?? []).reduce(
      (acc, mode) => acc | (mode === 'SYMBOL_FILLING_FOK' ? 1 : mode === 'SYMBOL_FILLING_IOC' ? 2 : 0),
      0,
    );
    return {
      symbol: s.symbol,
      digits: s.digits,
      tickSize: s.tickSize || s.point,
      contractSize: s.contractSize,
      minLot: s.minVolume,
      maxLot: s.maxVolume,
      lotStep: s.volumeStep,
      baseSpread: price ? Math.max(0, price.ask - price.bid) : 0,
      // Commission arrives on the broker's deals; nothing is assumed here.
      commissionPerLot: 0,
      point: s.point,
      tickValue: price?.profitTickValue,
      stopsLevel: s.stopsLevel ?? 0,
      freezeLevel: s.freezeLevel ?? 0,
      fillingFlags: flags,
      description: s.description,
      tradeMode: s.tradeMode ? TRADE_MODES[s.tradeMode] ?? 'full' : 'full',
    };
  }

  private applySpecification(s: MtSpecification): void {
    const spec = this.toSpec(s);
    this.specCache = spec;
    // The shared registry serves paper fills and anything sized by symbol name.
    registerSymbolSpec(spec);
  }

  private applyPrice(price: MtPrice): void {
    if (price.symbol !== this.symbol) return;
    const tick: Tick = { symbol: price.symbol, bid: price.bid, ask: price.ask, time: ms(price.time) };
    if (price.brokerTime) this.serverOffset = serverOffsetOf(price.time, price.brokerTime);
    if (this.specCache) {
      this.specCache.baseSpread = Math.max(0, price.ask - price.bid);
      if (price.profitTickValue) this.specCache.tickValue = price.profitTickValue;
    }
    if (this.paper) {
      // Simulated fills, stops and valuation against the broker's own quotes.
      super.onTick(tick);
    } else {
      this.lastTick = tick;
      this.refreshValuation();
    }
    this.emit('quote', tick, this);
  }

  /** MetaApi revalues positions on every quote; read its figures rather than guess. */
  private refreshValuation(): void {
    const terminal = this.connection?.terminalState;
    if (!terminal || this.positions.size === 0) return;
    for (const p of terminal.positions) {
      const localId = this.byTicket.get(String(p.id));
      const position = localId ? this.positions.get(localId) : undefined;
      if (!position) continue;
      if (p.currentPrice !== undefined) position.currentPrice = p.currentPrice;
      position.profit = round((p.profit ?? 0) + (p.swap ?? 0) + (p.commission ?? 0));
      position.swap = round(p.swap ?? 0);
    }
  }

  private applyInformation(info: MtAccountInformation, first = false): void {
    this.info = info;
    if (this.paper) {
      // Paper books start from the real balance and then keep their own.
      if (first) {
        this.balance = round(info.balance);
        this.config = { ...this.config, initialBalance: round(info.balance) };
      }
    } else {
      this.balance = round(info.balance);
      if (first) this.config = { ...this.config, initialBalance: round(info.balance) };
    }
    this.config = {
      ...this.config,
      currency: info.currency ?? this.config.currency,
      leverage: info.leverage ?? this.config.leverage,
      broker: info.broker ?? this.config.broker,
    };
    this.emit('changed', this);
  }

  override onTick(): void {
    // Each account values itself on its own broker's quotes, which arrive on
    // its own stream; the shared feed carries the master's.
  }

  override floatingProfit(): number {
    let total = 0;
    for (const position of this.positions.values()) total += position.profit;
    return round(total);
  }

  override usedMargin(): number {
    if (this.paper || !this.info) return super.usedMargin();
    return round(this.info.margin);
  }

  override equity(): number {
    if (this.paper || !this.info) return super.equity();
    return round(this.info.equity);
  }

  override freeMargin(): number {
    if (this.paper || !this.info) return super.freeMargin();
    return round(this.info.freeMargin);
  }

  override accountType(): AccountState['accountType'] {
    switch (this.info?.type) {
      case 'ACCOUNT_TRADE_MODE_REAL':
        return 'real';
      case 'ACCOUNT_TRADE_MODE_CONTEST':
        return 'contest';
      default:
        return 'demo';
    }
  }

  override quoteIntervalSec(): number | null {
    return this.handleRef?.quoteStreamingIntervalInSeconds ?? null;
  }

  /** Whether the broker lets this account trade right now. */
  get tradeAllowed(): boolean {
    return this.info?.tradeAllowed !== false;
  }

  override state(): AccountState {
    const state = super.state();
    return {
      ...state,
      platform: this.handleRef?.version === 4 || this.info?.platform === 'mt4' ? 'mt4' : 'mt5',
      marginLevel: !this.paper && this.info?.marginLevel !== undefined ? round(this.info.marginLevel) : state.marginLevel,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Book, from the broker's stream                                      */
  /* ------------------------------------------------------------------ */

  private originOf(p: MtPosition): PositionOrigin {
    const sent = p.clientId ? this.inflight.get(p.clientId) : undefined;
    if (sent) return sent.origin;
    if (p.clientId && OWN_CLIENT_ID.test(p.clientId)) return this.config.role === 'slave' ? 'copy' : 'bot';
    return 'external';
  }

  private toPosition(p: MtPosition, origin: PositionOrigin, sent?: OpenRequest): Position {
    const spec = this.spec(p.symbol);
    return {
      id: uid('pos'),
      ticket: Number(p.id) || 0,
      accountId: this.id,
      symbol: p.symbol,
      side: p.type === 'POSITION_TYPE_SELL' ? 'sell' : 'buy',
      volume: p.volume,
      openPrice: roundPrice(spec, p.openPrice),
      openTime: ms(p.time),
      stopLoss: p.stopLoss || null,
      takeProfit: p.takeProfit || null,
      stopLossUsd: sent?.stopLossUsd ?? null,
      takeProfitUsd: sent?.takeProfitUsd ?? null,
      currentPrice: p.currentPrice ?? p.openPrice,
      profit: round((p.profit ?? 0) + (p.swap ?? 0) + (p.commission ?? 0)),
      swap: round(p.swap ?? 0),
      // MetaTrader reports commission as a negative amount; the book keeps the charge.
      commission: round(-(p.commission ?? 0)),
      origin,
      basketIndex: sent?.basketIndex ?? 0,
      recoveryLayer: sent?.recoveryLayer ?? 0,
      comment: p.comment ?? '',
      magic: p.magic ?? 0,
      sourceId: sent?.sourceId ?? null,
      clientId: p.clientId ?? null,
    };
  }

  /**
   * Folds a position report into the book. `live` says whether it is news —
   * a position opened while connected — or the state found on (re)connection.
   */
  private upsertPosition(p: MtPosition, live: boolean): void {
    const ticket = String(p.id);
    const localId = this.byTicket.get(ticket);
    const existing = localId ? this.positions.get(localId) : undefined;

    if (existing) {
      this.mergePosition(existing, p);
      return;
    }
    if (this.paper) return;

    const sent = p.clientId ? this.inflight.get(p.clientId) : undefined;
    const position = this.toPosition(p, this.originOf(p), sent);
    this.byTicket.set(ticket, position.id);
    this.positions.set(position.id, position);

    // News is a position opened while connected. What the first
    // synchronisation finds is existing exposure — possibly copied already by
    // an earlier session — and is adopted without copying it. After a
    // reconnection, a trade MetaTrader itself opened during the gap moments
    // ago is still news, so mirror mode does not miss it.
    const fresh = this.synced && (live || (position.origin === 'external' && Date.now() - position.openTime < 60_000));
    if (fresh) {
      this.emit('opened', position, this);
    } else {
      this.log('info', `${this.config.name}: holding #${ticket} ${position.side.toUpperCase()} ${position.volume} ${position.symbol} from before this session`);
    }
    this.emit('changed', this);
    for (const resolve of this.positionWaiters.get(ticket) ?? []) resolve(position);
    this.positionWaiters.delete(ticket);
  }

  private mergePosition(position: Position, p: MtPosition): void {
    const ticket = String(p.id);
    const spec = this.spec(p.symbol);
    const sl = p.stopLoss || null;
    const tp = p.takeProfit || null;
    const levelsMoved = sl !== position.stopLoss || tp !== position.takeProfit;

    position.openPrice = roundPrice(spec, p.openPrice);
    if (p.currentPrice !== undefined) position.currentPrice = p.currentPrice;
    position.profit = round((p.profit ?? 0) + (p.swap ?? 0) + (p.commission ?? 0));
    position.swap = round(p.swap ?? 0);
    position.stopLoss = sl;
    position.takeProfit = tp;
    if (p.clientId) position.clientId = p.clientId;

    if (p.volume < position.volume - 1e-9 && !this.closeWaits.has(ticket)) {
      // Part of it closed: book that part when its deal arrives.
      this.awaitExit(ticket, round(position.volume - p.volume, 2));
    } else if (!this.closeWaits.has(ticket)) {
      position.volume = p.volume;
      position.commission = round(-(p.commission ?? 0));
    }
    if (levelsMoved) this.emit('modified', position, this);
    this.emit('changed', this);
  }

  /** The broker no longer holds the position; book it once its exit deal is known. */
  private removePosition(ticket: string): void {
    if (!this.byTicket.has(ticket)) return;
    const wait = this.closeWaits.get(ticket);
    if (wait && wait.volume === undefined) return;
    if (wait) {
      // A partial close was pending; the full close supersedes it.
      clearTimeout(wait.timer);
      this.closeWaits.delete(ticket);
      this.awaitExit(ticket, undefined, wait.waiters);
      return;
    }
    this.awaitExit(ticket);
  }

  /**
   * Books an exit as soon as its deal is in, which in MetaApi's update
   * packets follows the position change by a few microseconds. If the deal
   * never shows, the exit is booked from the last known valuation.
   */
  private awaitExit(ticket: string, volume?: number, waiters: CloseWait['waiters'] = []): void {
    const deal = this.exitDealFor(ticket, volume);
    if (deal) {
      this.bookExit(ticket, deal, volume, waiters);
      return;
    }
    const timer = setTimeout(() => {
      const wait = this.closeWaits.get(ticket);
      this.closeWaits.delete(ticket);
      this.bookExit(ticket, null, volume, wait?.waiters ?? waiters);
    }, 2000);
    this.closeWaits.set(ticket, { timer, volume, waiters });
  }

  /** The unbooked exit deal for a position, matching the closed volume when it can. */
  private exitDealFor(ticket: string, volume?: number): Deal | undefined {
    const localId = this.byTicket.get(ticket);
    const want = volume ?? (localId ? this.positions.get(localId)?.volume : undefined);
    let fallback: Deal | undefined;
    for (let i = this.dealLog.length - 1; i >= 0; i -= 1) {
      const d = this.dealLog[i]!;
      if (d.positionId !== ticket || d.entry === 'in' || this.usedExitDeals.has(d.id)) continue;
      if (want === undefined || Math.abs(d.volume - want) < 1e-6) return d;
      if (volume === undefined) fallback ??= d;
    }
    return fallback;
  }

  private readonly usedExitDeals = new Set<string>();

  private bookExit(ticket: string, deal: Deal | null, volume: number | undefined, waiters: CloseWait['waiters']): void {
    const localId = this.byTicket.get(ticket);
    const position = localId ? this.positions.get(localId) : undefined;
    if (!position) {
      for (const resolve of waiters) resolve(null);
      this.flushCloseResolvers(ticket, null);
      return;
    }
    if (deal) this.usedExitDeals.add(deal.id);

    const closedVolume = volume ?? position.volume;
    const partial = volume !== undefined && volume < position.volume - 1e-9;
    const share = position.volume > 0 ? closedVolume / position.volume : 1;
    const entryCommission = round(position.commission * share);
    const exitCommission = deal ? round(-deal.commission) : 0;
    const commission = round(entryCommission + exitCommission);
    const swap = deal ? round(deal.swap) : round(position.swap * share);
    const gross = deal ? round(deal.profit) : round((position.profit + position.commission - position.swap) * share);
    const net = round(gross + swap - commission);
    const reason: CloseReason =
      this.closeReasons.get(ticket) ??
      (deal?.reason === 'sl' ? 'sl' : deal?.reason === 'tp' ? 'tp' : deal?.reason === 'so' ? 'stop-out' : 'manual');

    const trade: ClosedTrade = {
      id: partial ? uid('part') : position.id,
      ticket: position.ticket,
      accountId: this.id,
      symbol: position.symbol,
      side: position.side,
      volume: closedVolume,
      openPrice: position.openPrice,
      closePrice: deal?.price ?? position.currentPrice,
      openTime: position.openTime,
      closeTime: deal?.time ?? Date.now(),
      profit: gross,
      commission,
      swap,
      netProfit: net,
      reason,
      origin: position.origin,
      recoveryLayer: position.recoveryLayer,
      comment: position.comment,
    };

    this.realised = round(this.realised + net);
    this.closed.unshift(trade);
    if (this.closed.length > 500) this.closed.pop();

    if (partial) {
      position.volume = round(position.volume - closedVolume, 2);
      position.commission = round(position.commission - entryCommission);
      this.emit('partial', trade, position, this);
    } else {
      this.positions.delete(position.id);
      this.byTicket.delete(ticket);
      this.closeReasons.delete(ticket);
      this.emit('closed', trade, position, this);
    }
    this.emit('changed', this);
    for (const resolve of waiters) resolve(trade);
    this.flushCloseResolvers(ticket, trade);
  }

  private recordDeal(d: MtDeal): Deal | null {
    if (this.dealIds.has(d.id)) return null;
    this.dealIds.add(d.id);
    const deal = this.bookDeal({
      ticket: Number(d.id) || 0,
      positionId: d.positionId ?? '',
      orderId: d.orderId ?? '',
      symbol: d.symbol ?? '',
      type: dealType(d.type),
      entry: dealEntry(d.entryType),
      volume: d.volume ?? 0,
      price: d.price ?? 0,
      profit: d.profit ?? 0,
      commission: d.commission ?? 0,
      swap: d.swap ?? 0,
      magic: d.magic ?? 0,
      comment: d.comment ?? '',
      time: ms(d.time),
      reason: dealReason(d.reason),
      stopLoss: d.stopLoss ?? null,
      takeProfit: d.takeProfit ?? null,
    });
    return deal;
  }

  private onDeal(d: MtDeal): void {
    const deal = this.recordDeal(d);
    if (!deal || !isExit(d) || !d.positionId) return;
    const wait = this.closeWaits.get(d.positionId);
    if (!wait) return;
    if (wait.volume !== undefined && Math.abs(deal.volume - wait.volume) > 1e-6) return;
    clearTimeout(wait.timer);
    this.closeWaits.delete(d.positionId);
    this.bookExit(d.positionId, deal, wait.volume, wait.waiters);
  }

  private toOrder(o: MtOrder): PendingOrder | null {
    const type = PENDING_FROM_MT[o.type];
    if (!type) return null;
    return {
      id: uid('ord'),
      ticket: Number(o.id) || 0,
      accountId: this.id,
      symbol: o.symbol,
      type,
      volume: o.currentVolume ?? o.volume,
      openPrice: o.openPrice,
      stopLimitPrice: o.stopLimitPrice ?? null,
      stopLoss: o.stopLoss || null,
      takeProfit: o.takeProfit || null,
      expiration: o.expirationType === 'ORDER_TIME_SPECIFIED' && o.expirationTime ? ms(o.expirationTime) : null,
      magic: o.magic ?? 0,
      comment: o.comment ?? '',
      time: ms(o.time),
      clientId: o.clientId ?? null,
    };
  }

  private upsertOrder(o: MtOrder): void {
    if (this.paper) return;
    const ticket = String(o.id);
    const next = this.toOrder(o);
    if (!next) return;
    const localId = this.orderByTicket.get(ticket);
    if (localId) next.id = localId;
    this.orderByTicket.set(ticket, next.id);
    this.orders.set(next.id, next);
    this.emit('orders', this.listOrders(), this);
  }

  private removeOrder(ticket: string): void {
    const localId = this.orderByTicket.get(ticket);
    if (!localId) return;
    this.orderByTicket.delete(ticket);
    this.orders.delete(localId);
    this.emit('orders', this.listOrders(), this);
    this.emit('changed', this);
  }

  /** Positions and orders replaced wholesale, as on every (re)synchronisation. */
  private replacePositions(list: MtPosition[]): void {
    if (this.paper) return;
    const seen = new Set(list.map((p) => String(p.id)));
    for (const ticket of [...this.byTicket.keys()]) {
      // Closed while the stream was down: its followers still need to close.
      if (!seen.has(ticket)) this.removePosition(ticket);
    }
    for (const p of list) this.upsertPosition(p, false);
  }

  private replaceOrders(list: MtOrder[]): void {
    if (this.paper) return;
    const seen = new Set(list.map((o) => String(o.id)));
    for (const ticket of [...this.orderByTicket.keys()]) if (!seen.has(ticket)) this.removeOrder(ticket);
    for (const o of list) this.upsertOrder(o);
  }

  /** Every callback MetaApi's websocket client makes on a synchronisation listener. */
  private createListener(): Record<string, (...args: never[]) => unknown> {
    const noop = async (): Promise<void> => undefined;
    const split = (instanceIndex: string): string[] => String(instanceIndex ?? '').split(':');
    return {
      getRegion: (instanceIndex: string) => split(instanceIndex)[0],
      getInstanceNumber: (instanceIndex: string) => Number(split(instanceIndex)[1] ?? 0),
      getHostName: (instanceIndex: string) => split(instanceIndex)[2],
      onConnected: noop,
      onHealthStatus: noop,
      onDisconnected: async () => {
        if (!this.synced) return;
        this.connected = false;
        this.connectionError = 'MetaApi connection lost — reconnecting';
        this.emit('changed', this);
      },
      onBrokerConnectionStatusChanged: async (_i: string, connected: boolean) => {
        // Sent with every status heartbeat; only a change is news.
        if (!this.synced || this.connected === connected) return;
        this.connected = connected;
        this.connectionError = connected ? null : `${this.config.broker} is not answering MetaApi`;
        this.emit('changed', this);
      },
      onSynchronizationStarted: noop,
      onAccountInformationUpdated: async (_i: string, info: MtAccountInformation) => this.applyInformation(info),
      onPositionsReplaced: async (_i: string, positions: MtPosition[]) => this.replacePositions(positions),
      onPositionsSynchronized: async () => {
        if (!this.synced) return;
        // Back after a gap: the book is whole again.
        this.connected = true;
        this.connectionError = null;
        this.emit('synced', this);
        this.emit('changed', this);
      },
      onPositionsUpdated: noop,
      onPositionUpdated: async (_i: string, position: MtPosition) => this.upsertPosition(position, this.synced),
      onPositionRemoved: async (_i: string, positionId: string) => {
        if (!this.paper) this.removePosition(String(positionId));
      },
      onPendingOrdersReplaced: async (_i: string, orders: MtOrder[]) => this.replaceOrders(orders),
      onPendingOrdersUpdated: noop,
      onPendingOrderUpdated: async (_i: string, order: MtOrder) => this.upsertOrder(order),
      onPendingOrderCompleted: async (_i: string, orderId: string) => {
        if (!this.paper) this.removeOrder(String(orderId));
      },
      onPendingOrdersSynchronized: noop,
      onHistoryOrderAdded: noop,
      onHistoryOrdersSynchronized: noop,
      onDealAdded: async (_i: string, deal: MtDeal) => {
        if (!this.paper) this.onDeal(deal);
      },
      onDealsSynchronized: noop,
      onSymbolSpecificationUpdated: async (_i: string, spec: MtSpecification) => {
        if (spec.symbol === this.symbol) this.applySpecification(spec);
      },
      onSymbolSpecificationRemoved: noop,
      onSymbolSpecificationsUpdated: async (_i: string, specs: MtSpecification[]) => {
        const own = specs.find((s) => s.symbol === this.symbol);
        if (own) this.applySpecification(own);
      },
      onSymbolPriceUpdated: async (_i: string, price: MtPrice) => this.applyPrice(price),
      onSymbolPricesUpdated: async (
        _i: string,
        _prices: MtPrice[],
        equity?: number,
        margin?: number,
        freeMargin?: number,
        marginLevel?: number,
      ) => {
        if (!this.info || this.paper) return;
        if (equity !== undefined) this.info.equity = equity;
        if (margin !== undefined) this.info.margin = margin;
        if (freeMargin !== undefined) this.info.freeMargin = freeMargin;
        if (marginLevel !== undefined) this.info.marginLevel = marginLevel;
      },
      onCandlesUpdated: noop,
      onTicksUpdated: noop,
      onBooksUpdated: noop,
      onSubscriptionDowngraded: async (_i: string, symbol: string) => {
        this.log('warn', `${this.config.name}: MetaApi slowed the ${symbol} quote stream for this account's plan`);
      },
      onStreamClosed: noop,
      onUnsubscribeRegion: noop,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Orders                                                              */
  /* ------------------------------------------------------------------ */

  private liveConnection(): MtConnection | string {
    if (!this.connection || !this.synced) return this.connectionError ?? `${this.config.name} is not connected yet`;
    if (!this.connected) return this.connectionError ?? `${this.config.name} has lost its broker connection`;
    return this.connection;
  }

  /** A money stop is converted by the broker at the fill, so it is exact to the cent. */
  private stopArg(level: number | null | undefined, money: number | null | undefined): MtStop {
    if (level !== undefined && level !== null && level > 0) return level;
    if (money) return { value: money, units: 'RELATIVE_CURRENCY' };
    return undefined;
  }

  private waitForPosition(ticket: string, timeoutMs: number): Promise<Position | null> {
    const known = this.byTicket.get(ticket);
    if (known) return Promise.resolve(this.positions.get(known) ?? null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const list = (this.positionWaiters.get(ticket) ?? []).filter((w) => w !== done);
        if (list.length) this.positionWaiters.set(ticket, list);
        else this.positionWaiters.delete(ticket);
        resolve(null);
      }, timeoutMs);
      const done = (p: Position): void => {
        clearTimeout(timer);
        resolve(p);
      };
      this.positionWaiters.set(ticket, [...(this.positionWaiters.get(ticket) ?? []), done]);
    });
  }

  override open(req: OpenRequest): OpenResult {
    if (this.paper) return super.open(req);
    return { ok: false, error: 'MetaApi accounts place orders through submit()' };
  }

  override async submit(req: OpenRequest): Promise<OpenResult> {
    if (this.paper) return super.submit(req);
    const connection = this.liveConnection();
    if (typeof connection === 'string') return { ok: false, error: connection, code: 'TRADE_RETCODE_CONNECTION' };

    const spec = this.spec(req.symbol);
    const volume = roundLot(spec, req.volume);
    if (volume < spec.minLot) {
      return { ok: false, error: `volume below the broker's minimum of ${spec.minLot}`, code: 'TRADE_RETCODE_INVALID_VOLUME' };
    }
    const clientId = req.clientId ?? newClientId();
    // MetaApi allows 26 characters for comment and client id together.
    const comment = (req.comment ?? '').slice(0, Math.max(0, 26 - clientId.length));
    const options: MtTradeOptions = { clientId };
    if (comment) options.comment = comment;
    if (req.magic !== undefined) options.magic = req.magic;
    if (req.slippagePoints !== undefined) options.slippage = req.slippagePoints;
    const sent: OpenRequest = { ...req, volume, clientId };
    this.inflight.set(clientId, sent);

    try {
      const sl = this.stopArg(req.stopLoss, req.stopLossUsd);
      const tp = this.stopArg(req.takeProfit, req.takeProfitUsd);
      const response =
        req.side === 'buy'
          ? await connection.createMarketBuyOrder(req.symbol, volume, sl, tp, options)
          : await connection.createMarketSellOrder(req.symbol, volume, sl, tp, options);
      const ticket = String(response.positionId ?? response.orderId ?? '');
      // MetaTrader answers with the fill; the stream carries its price and levels.
      const position =
        (await this.waitForPosition(ticket, this.opts.fillWaitMs ?? 1500)) ?? this.placeholder(sent, ticket, clientId);
      return { ok: true, position };
    } catch (err) {
      const { error, code } = describeTradeError(err);
      return { ok: false, error, code };
    } finally {
      this.inflight.delete(clientId);
    }
  }

  /** The fill as far as it is known, when the stream has not reported it yet. */
  private placeholder(req: OpenRequest, ticket: string, clientId: string): Position {
    const tick = this.lastTick;
    const spec = this.spec(req.symbol);
    const price = tick ? (req.side === 'buy' ? tick.ask : tick.bid) : 0;
    const position: Position = {
      id: uid('pos'),
      ticket: Number(ticket) || 0,
      accountId: this.id,
      symbol: req.symbol,
      side: req.side,
      volume: req.volume,
      openPrice: roundPrice(spec, price),
      openTime: tick?.time ?? Date.now(),
      stopLoss: req.stopLoss ?? null,
      takeProfit: req.takeProfit ?? null,
      stopLossUsd: req.stopLossUsd ?? null,
      takeProfitUsd: req.takeProfitUsd ?? null,
      currentPrice: price,
      profit: 0,
      swap: 0,
      commission: 0,
      origin: req.origin,
      basketIndex: req.basketIndex ?? 0,
      recoveryLayer: req.recoveryLayer ?? 0,
      comment: req.comment ?? '',
      magic: req.magic ?? 0,
      sourceId: req.sourceId ?? null,
      clientId,
    };
    if (ticket) this.byTicket.set(ticket, position.id);
    this.positions.set(position.id, position);
    this.emit('opened', position, this);
    this.emit('changed', this);
    return position;
  }

  override async submitClose(id: string, reason: CloseReason, volume?: number): Promise<ClosedTrade | null> {
    if (this.paper) return super.submitClose(id, reason, volume);
    const position = this.positions.get(id);
    if (!position) return null;
    const connection = this.liveConnection();
    if (typeof connection === 'string') {
      this.log('error', `Close of #${position.ticket} not sent: ${connection}`);
      return null;
    }
    const ticket = String(position.ticket);
    const partial = volume !== undefined && volume > 0 && volume < position.volume - 1e-9;
    const closeVolume = partial ? roundLot(this.spec(position.symbol), volume) : undefined;
    this.closeReasons.set(ticket, reason);

    // Resolved when the exit is booked, whichever arrives first: the broker's
    // answer or its stream reporting the position gone.
    const booked = new Promise<ClosedTrade | null>((resolve) => {
      this.pendingCloseResolvers.set(ticket, [...(this.pendingCloseResolvers.get(ticket) ?? []), resolve]);
    });

    try {
      if (closeVolume !== undefined) await connection.closePositionPartially(ticket, closeVolume, {});
      else await connection.closePosition(ticket, {});
    } catch (err) {
      const { error } = describeTradeError(err);
      this.closeReasons.delete(ticket);
      this.flushCloseResolvers(ticket, null);
      if (!/POSITION_CLOSED|not found/i.test(error)) this.log('error', `Close of #${ticket} rejected: ${error}`);
      return null;
    }

    if (this.byTicket.has(ticket) && !this.closeWaits.has(ticket)) {
      // Closed at the broker but not yet reported: give the stream a moment to
      // bring the exit deal, then book it from the last valuation if it has not.
      setTimeout(() => {
        if (this.byTicket.has(ticket) && !this.closeWaits.has(ticket) && this.pendingCloseResolvers.has(ticket)) {
          this.bookExit(ticket, null, closeVolume, []);
        }
      }, 3000);
    }
    return booked;
  }

  private readonly pendingCloseResolvers = new Map<string, ((trade: ClosedTrade | null) => void)[]>();

  private flushCloseResolvers(ticket: string, trade: ClosedTrade | null): void {
    for (const resolve of this.pendingCloseResolvers.get(ticket) ?? []) resolve(trade);
    this.pendingCloseResolvers.delete(ticket);
  }

  override requestCloseAll(reason: CloseReason, filter?: (p: Position) => boolean): number {
    if (this.paper) return super.requestCloseAll(reason, filter);
    const targets = this.listPositions().filter((p) => (filter ? filter(p) : true));
    for (const p of targets) void this.submitClose(p.id, reason);
    return targets.length;
  }

  override closeAll(reason: CloseReason, filter?: (p: Position) => boolean): ClosedTrade[] {
    if (this.paper) return super.closeAll(reason, filter);
    this.requestCloseAll(reason, filter);
    return [];
  }

  override async submitModify(id: string, stopLoss: number | null, takeProfit: number | null): Promise<ActionResult> {
    if (this.paper) return super.submitModify(id, stopLoss, takeProfit);
    const position = this.positions.get(id);
    if (!position) return { ok: false, error: 'position not found' };
    const connection = this.liveConnection();
    if (typeof connection === 'string') return { ok: false, error: connection };
    try {
      await connection.modifyPosition(String(position.ticket), stopLoss ?? undefined, takeProfit ?? undefined);
    } catch (err) {
      return { ok: false, error: describeTradeError(err).error };
    }
    if (position.stopLoss !== stopLoss || position.takeProfit !== takeProfit) {
      position.stopLoss = stopLoss;
      position.takeProfit = takeProfit;
      this.emit('modified', position, this);
      this.emit('changed', this);
    }
    return { ok: true };
  }

  override modify(id: string, stopLoss: number | null, takeProfit: number | null): boolean {
    if (this.paper) return super.modify(id, stopLoss, takeProfit);
    if (!this.positions.has(id)) return false;
    void this.submitModify(id, stopLoss, takeProfit);
    return true;
  }

  override async submitPending(req: PendingRequest): Promise<PendingResult> {
    if (this.paper) return super.submitPending(req);
    const connection = this.liveConnection();
    if (typeof connection === 'string') return { ok: false, error: connection };
    const spec = this.spec(req.symbol);
    const volume = roundLot(spec, req.volume);
    const clientId = req.clientId ?? newClientId();
    const options: MtTradeOptions = { clientId };
    const comment = (req.comment ?? '').slice(0, Math.max(0, 26 - clientId.length));
    if (comment) options.comment = comment;
    if (req.magic !== undefined) options.magic = req.magic;
    if (req.expiration) options.expiration = { type: 'ORDER_TIME_SPECIFIED', time: new Date(req.expiration) };
    const sl = req.stopLoss ?? undefined;
    const tp = req.takeProfit ?? undefined;
    const price = roundPrice(spec, req.openPrice);
    try {
      let response: MtTradeResponse;
      switch (req.type) {
        case 'buy-limit':
          response = await connection.createLimitBuyOrder(req.symbol, volume, price, sl, tp, options);
          break;
        case 'sell-limit':
          response = await connection.createLimitSellOrder(req.symbol, volume, price, sl, tp, options);
          break;
        case 'buy-stop':
          response = await connection.createStopBuyOrder(req.symbol, volume, price, sl, tp, options);
          break;
        case 'sell-stop':
          response = await connection.createStopSellOrder(req.symbol, volume, price, sl, tp, options);
          break;
        case 'buy-stop-limit':
          response = await connection.createStopLimitBuyOrder(req.symbol, volume, price, req.stopLimitPrice ?? price, sl, tp, options);
          break;
        case 'sell-stop-limit':
          response = await connection.createStopLimitSellOrder(req.symbol, volume, price, req.stopLimitPrice ?? price, sl, tp, options);
          break;
      }
      const ticket = String(response.orderId ?? '');
      const localId = this.orderByTicket.get(ticket);
      const existing = localId ? this.orders.get(localId) : undefined;
      if (existing) return { ok: true, order: existing };
      const order: PendingOrder = {
        id: uid('ord'),
        ticket: Number(ticket) || 0,
        accountId: this.id,
        symbol: req.symbol,
        type: req.type,
        volume,
        openPrice: price,
        stopLimitPrice: req.stopLimitPrice ?? null,
        stopLoss: req.stopLoss ?? null,
        takeProfit: req.takeProfit ?? null,
        expiration: req.expiration ?? null,
        magic: req.magic ?? 0,
        comment: req.comment ?? '',
        time: this.lastTick?.time ?? Date.now(),
        clientId,
      };
      if (ticket) this.orderByTicket.set(ticket, order.id);
      this.orders.set(order.id, order);
      this.emit('orders', this.listOrders(), this);
      return { ok: true, order };
    } catch (err) {
      return { ok: false, error: describeTradeError(err).error };
    }
  }

  override async cancelPending(id: string): Promise<ActionResult> {
    if (this.paper) return super.cancelPending(id);
    const order = this.orders.get(id);
    if (!order) return { ok: false, error: 'order not found' };
    const connection = this.liveConnection();
    if (typeof connection === 'string') return { ok: false, error: connection };
    try {
      await connection.cancelOrder(String(order.ticket));
    } catch (err) {
      return { ok: false, error: describeTradeError(err).error };
    }
    this.removeOrder(String(order.ticket));
    return { ok: true };
  }

  override async modifyPending(
    id: string,
    openPrice: number,
    stopLoss: number | null,
    takeProfit: number | null,
    expiration?: number | null,
  ): Promise<ActionResult> {
    if (this.paper) return super.modifyPending(id, openPrice, stopLoss, takeProfit, expiration);
    const order = this.orders.get(id);
    if (!order) return { ok: false, error: 'order not found' };
    const connection = this.liveConnection();
    if (typeof connection === 'string') return { ok: false, error: connection };
    try {
      await connection.modifyOrder(String(order.ticket), openPrice, stopLoss ?? undefined, takeProfit ?? undefined);
    } catch (err) {
      return { ok: false, error: describeTradeError(err).error };
    }
    order.openPrice = openPrice;
    order.stopLoss = stopLoss;
    order.takeProfit = takeProfit;
    this.emit('orders', this.listOrders(), this);
    return { ok: true };
  }
}

/* ------------------------------------------------------------------------ */
/* The MetaApi account list, provisioning, and wiring into a runtime         */
/* ------------------------------------------------------------------------ */

export interface MetaApiAccountSummary {
  id: string;
  name: string;
  login: string;
  server: string;
  platform: 'mt4' | 'mt5';
  state: string;
  connectionStatus: string;
  region: string | null;
  quoteIntervalSec: number | null;
}

export interface ProvisionInput {
  name: string;
  login: string;
  password: string;
  server: string;
  platform: 'mt4' | 'mt5';
}

function summarise(account: MtAccount): MetaApiAccountSummary {
  return {
    id: account.id,
    name: account.name,
    login: String(account.login ?? ''),
    server: account.server,
    platform: account.version === 4 ? 'mt4' : 'mt5',
    state: account.state,
    connectionStatus: account.connectionStatus,
    region: account.region ?? null,
    quoteIntervalSec: account.quoteStreamingIntervalInSeconds ?? null,
  };
}

/** A MetaApi session opened with the user's token. */
export class MetaApiGateway {
  private readonly handles = new Map<string, MtAccount>();

  constructor(readonly client: MetaApiClient) {}

  async listAccounts(): Promise<MetaApiAccountSummary[]> {
    const accounts = await this.client.metatraderAccountApi.getAccountsWithInfiniteScrollPagination({ limit: 1000 });
    for (const account of accounts) this.handles.set(account.id, account);
    return accounts.map(summarise);
  }

  /**
   * Adds a MetaTrader login to the MetaApi account, with tick-by-tick quotes.
   * MetaApi checks the password against the broker before it answers.
   */
  async provision(input: ProvisionInput): Promise<MetaApiAccountSummary> {
    const account = await this.client.metatraderAccountApi.createAccount({
      name: input.name || `${input.login} ${input.server}`,
      login: input.login,
      password: input.password,
      server: input.server,
      platform: input.platform,
      magic: 0,
      quoteStreamingIntervalInSeconds: 0,
      reliability: 'regular',
    } as never);
    this.handles.set(account.id, account);
    return summarise(account);
  }

  async handle(id: string): Promise<MtAccount> {
    const cached = this.handles.get(id);
    if (cached) return cached;
    const account = await this.client.metatraderAccountApi.getAccount(id);
    this.handles.set(id, account);
    return account;
  }

  factory(options: Omit<MetaApiAccountOptions, 'handle'>): AccountFactory {
    return (config) => {
      const id = config.metaApiId;
      if (!id) throw new Error('A MetaApi account needs its MetaApi id');
      return new MetaApiAccount(config, { ...options, handle: () => this.handle(id) });
    };
  }

  /** Expert history from the broker itself, through the account's MetaApi server. */
  history(): HistoryProvider {
    return {
      loadBars: (account, symbol, timeframe, count) => {
        if (account instanceof MetaApiAccount) return account.loadBars(symbol, timeframe, count);
        return Promise.reject(new Error(`${account.config.name} has no broker history`));
      },
    };
  }

  close(): void {
    this.client.close();
  }
}

export interface MetaApiSelection {
  masterId: string;
  followerIds: string[];
  /** The master's gold symbol; found automatically when omitted. */
  symbol?: string;
  /** Simulated fills against the broker's quotes instead of real orders. */
  paper: boolean;
  followerCopy?: Partial<CopySettings>;
}

export interface MetaApiLink {
  master: MetaApiAccount;
  followers: MetaApiAccount[];
  detach(): void;
}

/**
 * Puts a MetaApi master and its followers into a runtime: the master's
 * quotes drive the feed, the chart opens on its broker's bars, an uploaded
 * EA reads the broker's history, and every follower connects in parallel.
 * Resolves once the master is synchronised; followers report their own state.
 */
export async function attachMetaApi(runtime: Runtime, gateway: MetaApiGateway, selection: MetaApiSelection): Promise<MetaApiLink> {
  const summaries = new Map((await gateway.listAccounts()).map((s) => [s.id, s]));
  const log = (level: 'info' | 'warn' | 'error', message: string, accountId: string) =>
    runtime.journal.write(level, accountId, message);
  runtime.accounts.registerProvider('metaapi', gateway.factory({ paper: selection.paper, log }));
  runtime.expert.setHistoryProvider(gateway.history());

  const describe = (id: string) => {
    const summary = summaries.get(id);
    if (!summary) throw new Error(`MetaApi account ${id} is not on this token`);
    return summary;
  };

  const masterSummary = describe(selection.masterId);
  const master = runtime.accounts.add({
    name: masterSummary.name,
    provider: 'metaapi',
    metaApiId: masterSummary.id,
    login: masterSummary.login,
    server: masterSummary.server,
    broker: masterSummary.server,
    role: 'master',
    symbol: selection.symbol?.trim() || undefined,
    initialBalance: 0,
  }) as MetaApiAccount;

  try {
    await master.ready();
  } catch (err) {
    runtime.accounts.remove(master.id);
    throw err;
  }

  runtime.feed.setSpec(master.spec());
  runtime.bot.updateConfig({ symbol: master.symbol });
  const quote = (tick: Tick) => runtime.feed.pushTick(tick);
  master.on('quote', quote);

  const candles = await master.loadCandles(240).catch((err: unknown) => {
    runtime.journal.write('warn', master.id, `Chart history unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return [] as Candle[];
  });
  if (candles.length > 0) {
    runtime.feed.seedCandles(candles);
    runtime.bot.prime(candles);
  }
  const first = master.quote();
  if (first) runtime.feed.pushTick(first);

  const followers = selection.followerIds
    .filter((id) => id !== selection.masterId)
    .map((id) => {
      const summary = describe(id);
      return runtime.accounts.add({
        name: summary.name,
        provider: 'metaapi',
        metaApiId: summary.id,
        login: summary.login,
        server: summary.server,
        broker: summary.server,
        role: 'slave',
        initialBalance: 0,
        copy: { ...DEFAULT_COPY_SETTINGS, ...selection.followerCopy, enabled: true, masterId: master.id },
      }) as MetaApiAccount;
    });

  return {
    master,
    followers,
    detach: () => {
      master.off('quote', quote);
      for (const account of [master, ...followers]) account.disconnect();
    },
  };
}

/**
 * Links another account of the same MetaApi token as a follower of the
 * link's master. It connects on its own streaming connection and copies from
 * the next order on.
 */
export async function addMetaApiFollower(
  runtime: Runtime,
  gateway: MetaApiGateway,
  link: MetaApiLink,
  metaApiId: string,
  copy: Partial<CopySettings> = {},
): Promise<MetaApiAccount> {
  const summary = (await gateway.listAccounts()).find((s) => s.id === metaApiId);
  if (!summary) throw new Error('That account is not on this MetaApi token.');
  if (metaApiId === link.master.metaApiId) throw new Error(`${summary.name} is the master.`);
  if (runtime.accounts.list().some((a) => a.config.metaApiId === metaApiId)) throw new Error(`${summary.name} is already linked.`);
  const account = runtime.accounts.add({
    name: summary.name,
    provider: 'metaapi',
    metaApiId,
    login: summary.login,
    server: summary.server,
    broker: summary.server,
    role: 'slave',
    initialBalance: 0,
    copy: { ...DEFAULT_COPY_SETTINGS, sizing: 'multiplier', multiplier: 1, ...copy, enabled: true, masterId: link.master.id },
  }) as MetaApiAccount;
  link.followers.push(account);
  return account;
}
