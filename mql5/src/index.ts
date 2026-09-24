export {
  compileMql5,
  nativeDeclarations,
  type CompileFailure,
  type CompileOptions,
  type CompileResult,
  type CompiledProgram,
  type Diagnostic,
  type HandlerInfo,
  type InputDescriptor,
  type InputOption,
  type SourceFile,
} from './compiler/index.js';
export { BUILTIN_ENUMS, TIMEFRAME_SECONDS, timeframeName } from './compiler/builtins.js';
export { Expert, type ExpertEvents, type ExpertStatus } from './runtime/expert.js';
export type {
  ChartObject,
  ExpertHost,
  HostAccount,
  HostDeal,
  HostOrder,
  HostPosition,
  HostQuote,
  HostSymbolSpec,
  KeyValueStore,
  LogLevel,
  TradeRequest,
  TradeResult,
} from './runtime/host.js';
export { BarSeries, MarketData, METAAPI_TIMEFRAMES, barStart, type Bar, type SeriesRequest } from './runtime/series.js';
export { IndicatorInstance, maOnArray, type IndicatorKind } from './runtime/indicators.js';
export { MqlArray, MqlRuntimeError, formatPrintf, formatDouble, normalizeDouble } from './runtime/values.js';
export { inspectEx5, type Ex5Info } from './ex5.js';

/** Order types, trade actions and return codes the host side needs by name. */
export const ORDER_TYPE = {
  BUY: 0,
  SELL: 1,
  BUY_LIMIT: 2,
  SELL_LIMIT: 3,
  BUY_STOP: 4,
  SELL_STOP: 5,
  BUY_STOP_LIMIT: 6,
  SELL_STOP_LIMIT: 7,
  CLOSE_BY: 8,
} as const;

export const TRADE_ACTION = { DEAL: 1, PENDING: 5, SLTP: 6, MODIFY: 7, REMOVE: 8, CLOSE_BY: 10 } as const;

export const RETCODE = {
  REQUOTE: 10004,
  REJECT: 10006,
  CANCEL: 10007,
  PLACED: 10008,
  DONE: 10009,
  DONE_PARTIAL: 10010,
  ERROR: 10011,
  TIMEOUT: 10012,
  INVALID: 10013,
  INVALID_VOLUME: 10014,
  INVALID_PRICE: 10015,
  INVALID_STOPS: 10016,
  TRADE_DISABLED: 10017,
  MARKET_CLOSED: 10018,
  NO_MONEY: 10019,
  PRICE_CHANGED: 10020,
  PRICE_OFF: 10021,
  INVALID_EXPIRATION: 10022,
  ORDER_CHANGED: 10023,
  TOO_MANY_REQUESTS: 10024,
  NO_CHANGES: 10025,
  CLIENT_DISABLES_AT: 10027,
  CONNECTION: 10031,
  INVALID_ORDER: 10035,
  POSITION_CLOSED: 10036,
  LIMIT_POSITIONS: 10040,
} as const;
