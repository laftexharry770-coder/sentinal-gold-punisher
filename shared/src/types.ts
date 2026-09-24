/**
 * Sentinal MT5 — shared domain model.
 * Consumed by both the execution server and the web terminal so that a single
 * definition of a position / account / bot config is used end to end.
 */

export type Side = 'buy' | 'sell';

export type BrokerProvider = 'sim' | 'metaapi';

export type AccountRole = 'master' | 'slave' | 'standalone';

export interface SymbolSpec {
  symbol: string;
  digits: number;
  tickSize: number;
  /** Units of the base asset in one standard lot (XAUUSD = 100 troy oz). */
  contractSize: number;
  minLot: number;
  maxLot: number;
  lotStep: number;
  /** Typical broker spread expressed in price units. */
  baseSpread: number;
  /** Round-turn commission charged per standard lot, account currency. */
  commissionPerLot: number;
  /* Broker details below are optional: the built-in XAUUSD default omits them. */
  /** Smallest price increment the broker quotes (often equal to tickSize). */
  point?: number;
  /** Money value of one tick for one lot, account currency. */
  tickValue?: number;
  /** Minimum distance of a stop from the price, in points. */
  stopsLevel?: number;
  freezeLevel?: number;
  /** SYMBOL_FILLING_* flags the broker accepts. */
  fillingFlags?: number;
  description?: string;
  /** Whether the broker allows trading it: 'full', 'long-only', 'short-only', 'close-only' or 'disabled'. */
  tradeMode?: 'full' | 'long-only' | 'short-only' | 'close-only' | 'disabled';
}

export interface Tick {
  symbol: string;
  bid: number;
  ask: number;
  time: number;
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Timeframe = 'M1' | 'M5' | 'M15' | 'H1';

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */

export interface CopySettings {
  enabled: boolean;
  /** Account id of the master this account mirrors. Null for masters. */
  masterId: string | null;
  sizing: 'multiplier' | 'fixed' | 'balance-ratio';
  multiplier: number;
  fixedLot: number;
  /** Mirror the master but in the opposite direction. */
  reverse: boolean;
  copyStopLoss: boolean;
  copyTakeProfit: boolean;
  copyCloses: boolean;
  minLot: number;
  maxLot: number;
  /** Max price deviation (in price units) tolerated when mirroring an entry. */
  maxSlippage: number;
  symbolWhitelist: string[];
}

export interface AccountConfig {
  id: string;
  name: string;
  provider: BrokerProvider;
  /** MetaApi's id for this trading account, when it is a live one. */
  metaApiId?: string;
  /** The broker's own name for the traded instrument (XAUUSD, XAUUSDm, GOLD…). */
  symbol?: string;
  login: string;
  server: string;
  broker: string;
  currency: string;
  leverage: number;
  role: AccountRole;
  /** Starting balance for simulated accounts. */
  initialBalance: number;
  copy: CopySettings;
}

export interface AccountState {
  id: string;
  name: string;
  provider: BrokerProvider;
  login: string;
  server: string;
  broker: string;
  currency: string;
  leverage: number;
  role: AccountRole;
  connected: boolean;
  connectionError: string | null;
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  marginLevel: number;
  /** Realised + floating profit since the account was linked. */
  totalProfit: number;
  openPositions: number;
  copy: CopySettings;
  /** The instrument this account trades, in the broker's own naming. */
  symbol: string;
  /** 'demo' or 'real', as the broker reports it; 'sim' for simulated accounts. */
  accountType: 'demo' | 'real' | 'contest' | 'sim';
  platform: 'mt5' | 'mt4' | 'sim';
  metaApiId: string | null;
  /** Round trip of the last order this account acknowledged, milliseconds. */
  lastLatencyMs: number | null;
  /** Average broker acknowledgement time over recent orders, milliseconds. */
  avgLatencyMs: number | null;
  /** Seconds between quotes MetaApi streams (0 = every tick). Null when unknown. */
  quoteIntervalSec: number | null;
  pendingOrders: number;
}

/* ------------------------------------------------------------------ */
/* Positions                                                           */
/* ------------------------------------------------------------------ */

/**
 * Who opened a position. 'external' is one the engine did not open itself —
 * a trade placed in MetaTrader, or by an EA running there.
 */
export type PositionOrigin = 'bot' | 'manual' | 'copy' | 'recovery' | 'external';

export interface Position {
  id: string;
  ticket: number;
  accountId: string;
  symbol: string;
  side: Side;
  volume: number;
  openPrice: number;
  openTime: number;
  /** Absolute price levels; null when the leg runs without a hard stop. */
  stopLoss: number | null;
  takeProfit: number | null;
  /** Money-based targets the levels were derived from. */
  stopLossUsd: number | null;
  takeProfitUsd: number | null;
  currentPrice: number;
  profit: number;
  swap: number;
  commission: number;
  origin: PositionOrigin;
  /** Slot index inside a multi-entry basket (0-based). */
  basketIndex: number;
  /** Recovery layer depth; 0 for a normal entry. */
  recoveryLayer: number;
  comment: string;
  magic: number;
  /** Position id on the master account when this leg was copied. */
  sourceId: string | null;
  /** Correlates an order with the dispatch that sent it to every account at once. */
  clientId: string | null;
}

export type PendingType = 'buy-limit' | 'sell-limit' | 'buy-stop' | 'sell-stop' | 'buy-stop-limit' | 'sell-stop-limit';

export interface PendingOrder {
  id: string;
  ticket: number;
  accountId: string;
  symbol: string;
  type: PendingType;
  volume: number;
  openPrice: number;
  stopLimitPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  /** Unix ms; null for good-till-cancelled. */
  expiration: number | null;
  magic: number;
  comment: string;
  time: number;
  clientId: string | null;
}

/** One deal in the account history, the unit MT5 reports trades in. */
export interface Deal {
  id: string;
  ticket: number;
  accountId: string;
  positionId: string;
  orderId: string;
  symbol: string;
  type: 'buy' | 'sell' | 'balance' | 'other';
  entry: 'in' | 'out' | 'inout' | 'out-by';
  volume: number;
  price: number;
  profit: number;
  commission: number;
  swap: number;
  magic: number;
  comment: string;
  /** Unix ms. */
  time: number;
  reason: 'client' | 'expert' | 'sl' | 'tp' | 'so' | 'other';
  stopLoss: number | null;
  takeProfit: number | null;
}

export type CloseReason =
  | 'tp'
  | 'sl'
  | 'manual'
  | 'basket-tp'
  | 'basket-sl'
  | 'copy'
  | 'bot-stop'
  | 'daily-limit'
  /** The broker closed it for lack of margin. */
  | 'stop-out';

export interface ClosedTrade {
  id: string;
  ticket: number;
  accountId: string;
  symbol: string;
  side: Side;
  volume: number;
  openPrice: number;
  closePrice: number;
  openTime: number;
  closeTime: number;
  profit: number;
  commission: number;
  swap: number;
  netProfit: number;
  reason: CloseReason;
  origin: PositionOrigin;
  recoveryLayer: number;
  comment: string;
}

/* ------------------------------------------------------------------ */
/* Bot configuration                                                   */
/* ------------------------------------------------------------------ */

export interface ZeroLossConfig {
  enabled: boolean;
  /** Recovery volume = deficit / (tp distance value) * this factor. */
  recoveryMultiplier: number;
  maxRecoveryLayers: number;
  /** A recovery only fires when projected net result clears this figure. */
  minNetProfitUsd: number;
  /** Above this accumulated deficit new normal entries are paused. */
  maxDeficitUsd: number;
  /** Hold recoveries until price action agrees with the recovery direction. */
  requireSignalAlignment: boolean;
  /** Cap on a single recovery leg volume. */
  maxRecoveryLot: number;
}

/** Where trading decisions come from. */
export type StrategySource =
  /** The engine's own signal models (adaptive scalp, momentum, mean reversion). */
  | 'builtin'
  /** An uploaded MQL5 expert advisor, compiled and running in the engine. */
  | 'mql5'
  /** An EA running in MetaTrader on the master account; the engine only copies it. */
  | 'mirror';

export interface DispatchConfig {
  /**
   * 'simultaneous' sends each order to the master and every follower at the
   * same instant. 'after-fill' waits for the master to fill first, then copies.
   */
  mode: 'simultaneous' | 'after-fill';
  /** Close a follower's fill when the master rejected the same order. */
  cancelOrphans: boolean;
}

export interface BotConfig {
  enabled: boolean;
  symbol: string;
  source: StrategySource;
  /** Chart timeframe an uploaded EA runs on, MQL5 code (1 = M1, 16385 = H1 …). */
  expertTimeframe: number;
  /** Values for the uploaded EA's inputs, by input name. */
  expertInputs: Record<string, string | number | boolean>;
  dispatch: DispatchConfig;
  /** Execution style — intrabar fires on tick, close waits for candle close. */
  execution: 'intrabar' | 'bar-close';
  strategy: 'adaptive-scalp' | 'momentum' | 'mean-reversion';
  /**
   * 'fixed' uses lotSize with the money stop/target below. 'risk-percent'
   * sizes every leg from live account equity so the same fraction is risked
   * whatever the balance.
   */
  sizing: 'fixed' | 'risk-percent';
  /** Share of equity risked per leg when sizing is 'risk-percent'. */
  riskPercent: number;
  /** Stop distance in symbol price units — what defines the risk per lot. */
  stopDistance: number;
  /** Target as a multiple of the stop. 0.5 keeps the shipped 2:1 stop:target. */
  rewardRatio: number;

  lotSize: number;
  stopLossUsd: number;
  takeProfitUsd: number;

  /* --- multi-position controls --- */
  /** Hard cap on simultaneously open bot positions per account. */
  maxConcurrentPositions: number;
  /** Cap per direction; allows e.g. 5 buys and 5 sells at once. */
  maxPositionsPerDirection: number;
  /** How many legs are opened together on a single qualified signal. */
  entriesPerSignal: number;
  /** Minimum gold-price distance between two stacked entries, same direction. */
  entrySpacingUsd: number;
  /** Allow buys and sells to be open at the same time. */
  allowHedging: boolean;
  /** Milliseconds to wait between two signal bursts. */
  signalCooldownMs: number;
  /** Minimum signal confidence (0-1) required before any leg is fired. */
  minSignalStrength: number;

  /* --- basket management --- */
  /** Close every open leg once the combined floating result clears this. */
  basketTakeProfitUsd: number | null;
  basketStopLossUsd: number | null;

  /* --- risk guards --- */
  maxSpread: number;
  maxDailyLossUsd: number | null;
  maxDailyTrades: number | null;

  zeroLoss: ZeroLossConfig;
}

export type RecoveryStatus = 'pending' | 'armed' | 'fired' | 'cancelled';

export interface RecoveryTask {
  id: string;
  accountId: string;
  symbol: string;
  /** Loss still to be recovered, account currency. */
  deficit: number;
  side: Side;
  layer: number;
  volume: number;
  projectedNet: number;
  status: RecoveryStatus;
  createdAt: number;
  /** Human readable reason the task has not fired yet. */
  holdReason: string;
  sourceTradeIds: string[];
}

/* ------------------------------------------------------------------ */
/* Signals, logs, stats                                                */
/* ------------------------------------------------------------------ */

export interface Signal {
  time: number;
  symbol: string;
  side: Side | null;
  strength: number;
  fast: number;
  slow: number;
  momentum: number;
  volatility: number;
  reason: string;
}

export type LogLevel = 'info' | 'success' | 'warn' | 'error' | 'trade' | 'copy';

export interface LogEntry {
  id: string;
  time: number;
  level: LogLevel;
  accountId: string | null;
  message: string;
}

export interface BotStats {
  running: boolean;
  startedAt: number | null;
  signalsEvaluated: number;
  tradesOpened: number;
  tradesClosed: number;
  wins: number;
  losses: number;
  grossProfit: number;
  grossLoss: number;
  netProfit: number;
  /** Sum of open deficits still waiting for a zero-loss recovery. */
  pendingDeficit: number;
  dailyTrades: number;
  dailyProfit: number;
  lastSignal: Signal | null;
  haltReason: string | null;
}

export interface PortfolioSnapshot {
  balance: number;
  equity: number;
  margin: number;
  freeMargin: number;
  floatingProfit: number;
  realisedProfit: number;
  openPositions: number;
  accounts: number;
}

/* ------------------------------------------------------------------ */
/* Wire protocol                                                       */
/* ------------------------------------------------------------------ */

/** The strategy the engine is running, as the terminal shows it. */
export interface StrategyInfo {
  source: StrategySource;
  /** EA or model name. */
  name: string;
  fileName: string | null;
  status: 'idle' | 'running' | 'stopped' | 'failed' | 'waiting';
  detail: string | null;
  /** Inputs of an uploaded EA, for the settings form. */
  inputs: StrategyInput[];
  diagnostics: { severity: 'error' | 'warning' | 'info'; message: string; file: string; line: number }[];
  /** SHA-256 of an uploaded .ex5, for mirror mode. */
  fingerprint: string | null;
  /** Text of the EA's Comment(). */
  comment: string;
  /** Text labels the EA draws, in screen order — its status panel. */
  panel: string[];
  lastTickMs: number | null;
  ticks: number;
  loadedAt: number | null;
}

export interface StrategyInput {
  name: string;
  label: string;
  group?: string;
  kind: 'bool' | 'int' | 'double' | 'string' | 'enum' | 'datetime' | 'color' | 'timeframe';
  typeName: string;
  defaultValue: number | string | boolean | null;
  options?: { value: number; name: string; label: string }[];
  static: boolean;
}

/** One order sent to several accounts at once, and how each answered. */
export interface DispatchReport {
  id: string;
  time: number;
  action: 'open' | 'close' | 'modify';
  symbol: string;
  side: Side | null;
  /** Time between sending to the first and the last account, milliseconds. */
  sendSpreadMs: number;
  legs: {
    accountId: string;
    role: 'master' | 'follower';
    ok: boolean;
    ackMs: number | null;
    error: string | null;
  }[];
}

export interface StateSnapshot {
  quote: Tick | null;
  candles: Candle[];
  accounts: AccountState[];
  positions: Position[];
  history: ClosedTrade[];
  logs: LogEntry[];
  recoveries: RecoveryTask[];
  bot: BotConfig;
  stats: BotStats;
  portfolio: PortfolioSnapshot;
  equityCurve: EquityPoint[];
  strategy: StrategyInfo;
  dispatches: DispatchReport[];
  orders: PendingOrder[];
}

export interface EquityPoint {
  time: number;
  equity: number;
  balance: number;
}

export type ServerMessage =
  | { type: 'snapshot'; payload: StateSnapshot }
  | { type: 'tick'; payload: Tick }
  | { type: 'candle'; payload: { candle: Candle; closed: boolean } }
  | { type: 'accounts'; payload: AccountState[] }
  | { type: 'positions'; payload: Position[] }
  | { type: 'history'; payload: ClosedTrade[] }
  | { type: 'log'; payload: LogEntry }
  | { type: 'recoveries'; payload: RecoveryTask[] }
  | { type: 'bot'; payload: { config: BotConfig; stats: BotStats } }
  | { type: 'portfolio'; payload: PortfolioSnapshot }
  | { type: 'equity'; payload: EquityPoint }
  | { type: 'strategy'; payload: StrategyInfo }
  | { type: 'dispatch'; payload: DispatchReport }
  | { type: 'orders'; payload: PendingOrder[] }
  | { type: 'error'; payload: { message: string } };

export interface ManualOrderRequest {
  accountId: string;
  symbol: string;
  side: Side;
  volume: number;
  /** Number of legs to fire at once — the manual multi-entry control. */
  legs?: number;
  stopLossUsd?: number | null;
  takeProfitUsd?: number | null;
  comment?: string;
}
