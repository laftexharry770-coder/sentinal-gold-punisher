/**
 * Sentinal MT5 — shared domain model.
 * Consumed by both the execution server and the web terminal so that a single
 * definition of a position / account / bot config is used end to end.
 */

export type Side = 'buy' | 'sell';

export type BrokerProvider = 'sim' | 'metaapi' | 'mt5';

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
  login: string;
  server: string;
  broker: string;
  currency: string;
  leverage: number;
  role: AccountRole;
  /** Starting balance for simulated accounts. */
  initialBalance: number;
  copy: CopySettings;
  /** MetaApi account token / id — never returned to the browser. */
  metaApiAccountId?: string;
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
}

/* ------------------------------------------------------------------ */
/* Positions                                                           */
/* ------------------------------------------------------------------ */

export type PositionOrigin = 'bot' | 'manual' | 'copy' | 'recovery';

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
}

export type CloseReason =
  | 'tp'
  | 'sl'
  | 'manual'
  | 'basket-tp'
  | 'basket-sl'
  | 'copy'
  | 'bot-stop'
  | 'daily-limit';

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

export interface BotConfig {
  enabled: boolean;
  symbol: string;
  /** Execution style — intrabar fires on tick, close waits for candle close. */
  execution: 'intrabar' | 'bar-close';
  strategy: 'adaptive-scalp' | 'momentum' | 'mean-reversion';
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
