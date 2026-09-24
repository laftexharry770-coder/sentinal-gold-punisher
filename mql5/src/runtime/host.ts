import type { MarketData } from './series.js';

/**
 * What an expert needs from the world outside it.
 *
 * The runtime knows MQL5; the host knows the broker. The engine implements
 * this once over its accounts, so the same expert runs against a live
 * MetaApi account, a simulated one, or a test double without change. All
 * times are broker server time in seconds, the clock MQL5 programs see.
 */

export interface HostSymbolSpec {
  name: string;
  description: string;
  digits: number;
  point: number;
  tickSize: number;
  /** Money value of one tick for one lot, account currency. */
  tickValue: number;
  tickValueProfit: number;
  tickValueLoss: number;
  contractSize: number;
  volumeMin: number;
  volumeMax: number;
  volumeStep: number;
  volumeLimit: number;
  /** Minimum stop distance, points. */
  stopsLevel: number;
  freezeLevel: number;
  /** ENUM_SYMBOL_TRADE_MODE */
  tradeMode: number;
  /** SYMBOL_FILLING_* flags. */
  fillingFlags: number;
  /** ENUM_SYMBOL_TRADE_EXECUTION */
  executionMode: number;
  /** ENUM_SYMBOL_CALC_MODE */
  calcMode: number;
  /** SYMBOL_ORDER_* flags. */
  orderMode: number;
  swapLong: number;
  swapShort: number;
  marginInitial: number;
  marginMaintenance: number;
  currencyBase: string;
  currencyProfit: string;
  currencyMargin: string;
  path: string;
}

export interface HostQuote {
  bid: number;
  ask: number;
  last: number;
  /** Server time of the quote, seconds and milliseconds. */
  time: number;
  timeMsc: number;
  volume: number;
}

export interface HostAccount {
  login: number;
  name: string;
  server: string;
  company: string;
  currency: string;
  balance: number;
  credit: number;
  equity: number;
  profit: number;
  margin: number;
  freeMargin: number;
  marginLevel: number;
  leverage: number;
  /** ENUM_ACCOUNT_TRADE_MODE: 0 demo, 1 contest, 2 real. */
  tradeMode: number;
  /** ENUM_ACCOUNT_MARGIN_MODE: 0 netting, 1 exchange, 2 hedging. */
  marginMode: number;
  marginSoCall: number;
  marginSoSo: number;
  /** ENUM_ACCOUNT_STOPOUT_MODE */
  marginSoMode: number;
  limitOrders: number;
  currencyDigits: number;
}

export interface HostPosition {
  ticket: number;
  identifier: number;
  symbol: string;
  /** ENUM_POSITION_TYPE */
  type: number;
  volume: number;
  priceOpen: number;
  priceCurrent: number;
  sl: number;
  tp: number;
  profit: number;
  swap: number;
  commission: number;
  magic: number;
  comment: string;
  externalId: string;
  time: number;
  timeMsc: number;
  timeUpdate: number;
  /** ENUM_POSITION_REASON */
  reason: number;
}

export interface HostOrder {
  ticket: number;
  symbol: string;
  /** ENUM_ORDER_TYPE */
  type: number;
  /** ENUM_ORDER_STATE */
  state: number;
  volumeInitial: number;
  volumeCurrent: number;
  priceOpen: number;
  priceCurrent: number;
  priceStopLimit: number;
  sl: number;
  tp: number;
  timeSetup: number;
  timeSetupMsc: number;
  timeExpiration: number;
  timeDone: number;
  timeDoneMsc: number;
  typeFilling: number;
  typeTime: number;
  magic: number;
  comment: string;
  externalId: string;
  positionId: number;
  positionById: number;
  reason: number;
}

export interface HostDeal {
  ticket: number;
  order: number;
  time: number;
  timeMsc: number;
  /** ENUM_DEAL_TYPE */
  type: number;
  /** ENUM_DEAL_ENTRY */
  entry: number;
  magic: number;
  /** ENUM_DEAL_REASON */
  reason: number;
  positionId: number;
  volume: number;
  price: number;
  commission: number;
  swap: number;
  profit: number;
  fee: number;
  sl: number;
  tp: number;
  symbol: string;
  comment: string;
  externalId: string;
}

export interface TradeRequest {
  /** ENUM_TRADE_REQUEST_ACTIONS */
  action: number;
  magic: number;
  order: number;
  symbol: string;
  volume: number;
  price: number;
  stoplimit: number;
  sl: number;
  tp: number;
  deviation: number;
  /** ENUM_ORDER_TYPE */
  type: number;
  typeFilling: number;
  typeTime: number;
  expiration: number;
  comment: string;
  position: number;
  positionBy: number;
}

export interface TradeResult {
  retcode: number;
  deal: number;
  order: number;
  volume: number;
  price: number;
  bid: number;
  ask: number;
  comment: string;
  requestId: number;
  retcodeExternal: number;
}

export type LogLevel = 'info' | 'warn' | 'error' | 'alert' | 'trade';

export interface ChartObject {
  name: string;
  type: number;
  integer: Map<number, number>;
  double: Map<number, number>;
  string: Map<number, string>;
}

export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  keys(prefix: string): string[];
}

export interface ExpertHost {
  /** Market data store the host feeds; the runtime reads bars from it. */
  readonly market: MarketData;
  /** The chart the expert is attached to. */
  readonly symbol: string;
  readonly timeframe: number;
  /** Symbols available for trading. */
  symbols(): string[];
  spec(symbol: string): HostSymbolSpec | null;
  quote(symbol: string): HostQuote | null;
  /** Time of the last quote, server time (TimeCurrent). */
  serverTime(): number;
  /** Server time minus UTC, seconds. */
  serverOffset(): number;
  account(): HostAccount;
  connected(): boolean;
  /** Whether the expert may trade right now (AutoTrading). */
  tradeAllowed(): boolean;
  positions(): HostPosition[];
  orders(): HostOrder[];
  deals(from: number, to: number): HostDeal[];
  historyOrders(from: number, to: number): HostOrder[];
  /** Executes a trade request and resolves when the broker has answered. */
  orderSend(request: TradeRequest): Promise<TradeResult>;
  log(level: LogLevel, message: string): void;
  comment(text: string): void;
  /** Chart objects changed (labels are the usual way an EA shows its status). */
  objects?(objects: ChartObject[]): void;
  notify?(text: string): void;
  storage?: KeyValueStore;
}
