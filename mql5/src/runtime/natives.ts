import { BUILTIN_ENUMS, COLOR_CONSTANTS, TIMEFRAME_SECONDS } from '../compiler/builtins.js';
import type { ChartObject, ExpertHost, HostDeal, HostOrder, HostPosition, TradeRequest, TradeResult } from './host.js';
import { IndicatorInstance, type IndicatorKind } from './indicators.js';
import { normaliseTimeframe, type BarSeries } from './series.js';
import {
  MqlArray,
  MqlRuntimeError,
  doubleToString,
  formatColor,
  formatPrintf,
  formatTime,
  normalizeDouble,
  strToDouble,
  strToLong,
  toStr,
  type Ref,
} from './values.js';

/**
 * MQL5's built-in functions, implemented over an {@link ExpertHost}.
 *
 * Each method is named after the implementation the compiler's native table
 * points at. Property identifiers arrive as the numbers the compiler assigned
 * them and are turned back into names once, here, so every lookup is a
 * readable switch.
 */

type Tagged = [value: unknown, tag: string];

/** Value → name for every built-in enumeration. */
function reverse(enumName: string): Map<number, string> {
  return new Map((BUILTIN_ENUMS[enumName] ?? []).map(([name, value]) => [value, name]));
}

const E = {
  symDbl: reverse('ENUM_SYMBOL_INFO_DOUBLE'),
  symInt: reverse('ENUM_SYMBOL_INFO_INTEGER'),
  symStr: reverse('ENUM_SYMBOL_INFO_STRING'),
  accDbl: reverse('ENUM_ACCOUNT_INFO_DOUBLE'),
  accInt: reverse('ENUM_ACCOUNT_INFO_INTEGER'),
  accStr: reverse('ENUM_ACCOUNT_INFO_STRING'),
  posDbl: reverse('ENUM_POSITION_PROPERTY_DOUBLE'),
  posInt: reverse('ENUM_POSITION_PROPERTY_INTEGER'),
  posStr: reverse('ENUM_POSITION_PROPERTY_STRING'),
  ordDbl: reverse('ENUM_ORDER_PROPERTY_DOUBLE'),
  ordInt: reverse('ENUM_ORDER_PROPERTY_INTEGER'),
  ordStr: reverse('ENUM_ORDER_PROPERTY_STRING'),
  dealDbl: reverse('ENUM_DEAL_PROPERTY_DOUBLE'),
  dealInt: reverse('ENUM_DEAL_PROPERTY_INTEGER'),
  dealStr: reverse('ENUM_DEAL_PROPERTY_STRING'),
  termInt: reverse('ENUM_TERMINAL_INFO_INTEGER'),
  termStr: reverse('ENUM_TERMINAL_INFO_STRING'),
  mqlInt: reverse('ENUM_MQL_INFO_INTEGER'),
  mqlStr: reverse('ENUM_MQL_INFO_STRING'),
  series: reverse('ENUM_SERIES_INFO_INTEGER'),
  objInt: reverse('ENUM_OBJECT_PROPERTY_INTEGER'),
};

const ERR = {
  INVALID_PARAMETER: 4003,
  INVALID_ARRAY: 4006,
  ARRAY_RESIZE: 4007,
  MARKET_UNKNOWN_SYMBOL: 4301,
  HISTORY_NOT_FOUND: 4401,
  GLOBALVARIABLE_NOT_FOUND: 4501,
  TRADE_POSITION_NOT_FOUND: 4753,
  TRADE_ORDER_NOT_FOUND: 4754,
  TRADE_DEAL_NOT_FOUND: 4755,
  TRADE_SEND_FAILED: 4756,
  INDICATOR_CANNOT_CREATE: 4802,
  INDICATOR_DATA_NOT_FOUND: 4806,
  INDICATOR_WRONG_HANDLE: 4807,
  SERIES_NOT_SYNCHRONIZED: 4401,
  FUNCTION_NOT_ALLOWED: 4014,
  OBJECT_NOT_FOUND: 4202,
  FILE_NOT_EXIST: 5019,
  FILE_CANNOT_OPEN: 5004,
};

const RC = {
  PLACED: 10008,
  DONE: 10009,
  DONE_PARTIAL: 10010,
  INVALID: 10013,
  INVALID_VOLUME: 10014,
  NO_MONEY: 10019,
  NO_CHANGES: 10025,
  CLIENT_DISABLES_AT: 10027,
  CONNECTION: 10031,
};

/** The pretend boot time the uptime counters run from: a day before this runtime loaded. */
const UPTIME_EPOCH = Date.now() - 86_400_000;

/** Struct constructors from the compiled program, for values natives return. */
export interface StructFactory {
  (name: string): Record<string, unknown> & { $reset(): unknown };
}

interface FileHandle {
  name: string;
  flags: number;
  delimiter: string;
  content: string;
  pos: number;
}

export interface RuntimeState {
  lastError: number;
  stopFlag: boolean;
  uninitReason: number;
  expertName: string;
  /** Called when a timer is set or cleared. */
  setTimer(ms: number): void;
  killTimer(): void;
  /** Called after a trade request completes, for OnTrade / OnTradeTransaction. */
  tradeCompleted(request: TradeRequest, result: TradeResult): void;
  /** ExpertRemove(). */
  requestStop(): void;
  startedAt: number;
}

export class Natives {
  private selectedPosition: HostPosition | null = null;
  private selectedOrder: HostOrder | null = null;
  private historyDeals: HostDeal[] = [];
  private historyOrders: HostOrder[] = [];
  private readonly indicators = new Map<number, IndicatorInstance>();
  private nextHandle = 10;
  private readonly objects = new Map<string, ChartObject>();
  private objectsDirty = false;
  private readonly files = new Map<number, FileHandle>();
  private nextFile = 1;
  private randState = 1;
  private requestId = 1;
  private readonly chartProps = new Map<number, number | string>();

  constructor(
    private readonly host: ExpertHost,
    private readonly state: RuntimeState,
    private readonly makeStruct: StructFactory,
  ) {}

  /* ================================================================== */
  /* Helpers                                                             */
  /* ================================================================== */

  private err(code: number): void {
    this.state.lastError = code;
  }

  private sym(name: unknown): string {
    const s = typeof name === 'string' ? name : '';
    return s === '' ? this.host.symbol : s;
  }

  private tf(tf: number): number {
    return normaliseTimeframe(Math.trunc(tf), this.host.timeframe);
  }

  private series(symbol: unknown, tf: number): BarSeries {
    return this.host.market.get(this.sym(symbol), this.tf(tf));
  }

  private text(args: Tagged[]): string {
    return args.map(([v, t]) => toStr(v, t)).join('');
  }

  private raw(args: Tagged[]): unknown[] {
    return args.map(([v]) => v);
  }

  /** Writes `values` (chronological) into an MQL array the way the Copy* functions do. */
  private fill<T>(arr: MqlArray<T>, values: T[]): number {
    if (arr.dynamic) {
      arr.a = values;
      return values.length;
    }
    if (arr.a.length < values.length) {
      this.err(ERR.ARRAY_RESIZE);
      // A static array takes what fits, newest last.
      const start = values.length - arr.a.length;
      for (let i = 0; i < arr.a.length; i += 1) arr.a[i] = values[start + i]!;
      return arr.a.length;
    }
    for (let i = 0; i < values.length; i += 1) arr.a[i] = values[i]!;
    return values.length;
  }

  /** Bar indices [from..to] chronological, for a start shift and count. */
  private rangeByShift(s: BarSeries, start: number, count: number): [number, number] | null {
    const n = s.length;
    if (n === 0 || count <= 0 || start < 0 || start >= n) return null;
    const newest = n - 1 - start;
    const oldest = Math.max(0, newest - count + 1);
    return [oldest, newest];
  }

  private rangeByTime(s: BarSeries, startTime: number, count: number): [number, number] | null {
    const n = s.length;
    let newest = -1;
    for (let i = n - 1; i >= 0; i -= 1) {
      if (s.time[i]! <= startTime) {
        newest = i;
        break;
      }
    }
    if (newest < 0 || count <= 0) return null;
    return [Math.max(0, newest - count + 1), newest];
  }

  private rangeByTimes(s: BarSeries, a: number, b: number): [number, number] | null {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    let oldest = -1;
    let newest = -1;
    for (let i = 0; i < s.length; i += 1) {
      const t = s.time[i]!;
      if (t >= lo && t <= hi) {
        if (oldest < 0) oldest = i;
        newest = i;
      }
    }
    return oldest < 0 ? null : [oldest, newest];
  }

  private copySeries<T>(symbol: unknown, tf: number, range: (s: BarSeries) => [number, number] | null, pick: (s: BarSeries, i: number) => T, arr: MqlArray<T>): number {
    const s = this.series(symbol, tf);
    if (!s.loaded) {
      this.err(ERR.SERIES_NOT_SYNCHRONIZED);
      return -1;
    }
    const r = range(s);
    if (!r) {
      this.err(ERR.HISTORY_NOT_FOUND);
      return -1;
    }
    const values: T[] = [];
    for (let i = r[0]; i <= r[1]; i += 1) values.push(pick(s, i));
    return this.fill(arr, values);
  }

  private spec(symbol: string) {
    return this.host.spec(symbol);
  }

  /* ================================================================== */
  /* Common                                                              */
  /* ================================================================== */

  Print(...args: Tagged[]): void {
    this.host.log('info', this.text(args));
  }

  PrintFormat(format: string, ...args: Tagged[]): void {
    this.host.log('info', formatPrintf(format, this.raw(args)));
  }

  StringFormat(format: string, ...args: Tagged[]): string {
    return formatPrintf(format, this.raw(args));
  }

  Comment(...args: Tagged[]): void {
    this.host.comment(this.text(args));
  }

  Alert(...args: Tagged[]): void {
    this.host.log('alert', this.text(args));
  }

  GetLastError(): number {
    return this.state.lastError;
  }

  ResetLastError(): void {
    this.state.lastError = 0;
  }

  SetUserError(code: number): void {
    this.state.lastError = 65536 + code;
  }

  IsStopped(): boolean {
    return this.state.stopFlag;
  }

  private clock(): number {
    return this.host.clockMs ? this.host.clockMs() : Date.now();
  }

  /**
   * Milliseconds of machine uptime, as MetaTrader reports it: a large number
   * that wraps every 49.7 days. EAs throttle with `GetTickCount() - last > n`
   * starting from last = 0, which only works when the count is already large
   * — so it is never reset to zero when the EA starts.
   */
  GetTickCount(): number {
    return (this.clock() - UPTIME_EPOCH) >>> 0;
  }

  GetTickCount64(): number {
    return this.clock() - UPTIME_EPOCH;
  }

  GetMicrosecondCount(): number {
    const perf = (globalThis as { performance?: { now(): number } }).performance;
    return Math.floor((perf ? perf.now() : Date.now()) * 1000);
  }

  async Sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }

  SendNotification(text: string): boolean {
    this.host.notify?.(text);
    this.host.log('alert', `Notification: ${text}`);
    return true;
  }

  SendMail(subject: string, text: string): boolean {
    this.host.log('info', `Mail (not sent from the web runtime): ${subject} — ${text}`);
    return false;
  }

  PlaySound(): boolean {
    return true;
  }

  MessageBox(text: string): number {
    this.host.log('alert', text);
    return 1;
  }

  DebugBreak(): void {
    /* no debugger here */
  }

  ExpertRemove(): void {
    this.state.requestStop();
  }

  /** Tester statistics exist only inside the Strategy Tester; live, they read as zero. */
  TesterStatistics(): number {
    return 0;
  }

  TesterWithdrawal(): boolean {
    return false;
  }

  TesterDeposit(): boolean {
    return false;
  }

  TesterStop(): void {
    /* no tester to stop */
  }

  TerminalClose(): boolean {
    this.state.requestStop();
    return true;
  }

  TerminalInfoInteger(id: number): number {
    switch (E.termInt.get(id)) {
      case 'TERMINAL_BUILD':
        return 4000;
      case 'TERMINAL_CONNECTED':
        return this.host.connected() ? 1 : 0;
      case 'TERMINAL_TRADE_ALLOWED':
        return this.host.tradeAllowed() ? 1 : 0;
      case 'TERMINAL_MAXBARS':
        return 100000;
      case 'TERMINAL_CODEPAGE':
        return 65001;
      case 'TERMINAL_CPU_CORES':
        return 4;
      case 'TERMINAL_X64':
        return 1;
      case 'TERMINAL_SCREEN_DPI':
        return 96;
      case 'TERMINAL_NOTIFICATIONS_ENABLED':
        return 1;
      default:
        return 0;
    }
  }

  TerminalInfoDouble(): number {
    return 0;
  }

  TerminalInfoString(id: number): string {
    switch (E.termStr.get(id)) {
      case 'TERMINAL_LANGUAGE':
        return 'English';
      case 'TERMINAL_COMPANY':
        return this.host.account().company;
      case 'TERMINAL_NAME':
        return 'Sentinal MT5 web runtime';
      default:
        return '';
    }
  }

  MQLInfoInteger(id: number): number {
    switch (E.mqlInt.get(id)) {
      case 'MQL_PROGRAM_TYPE':
        return 2;
      case 'MQL_TRADE_ALLOWED':
        return this.host.tradeAllowed() ? 1 : 0;
      case 'MQL_SIGNALS_ALLOWED':
        return 1;
      case 'MQL_LICENSE_TYPE':
        return 0;
      case 'MQL_MEMORY_LIMIT':
        return 4096;
      default:
        return 0;
    }
  }

  MQLInfoString(id: number): string {
    return E.mqlStr.get(id) === 'MQL_PROGRAM_NAME' ? this.state.expertName : `${this.state.expertName}.mq5`;
  }

  Symbol(): string {
    return this.host.symbol;
  }

  Period(): number {
    return this.host.timeframe;
  }

  Point(): number {
    return this.spec(this.host.symbol)?.point ?? 0;
  }

  Digits(): number {
    return this.spec(this.host.symbol)?.digits ?? 0;
  }

  EventSetTimer(seconds: number): boolean {
    if (seconds <= 0) return false;
    this.state.setTimer(seconds * 1000);
    return true;
  }

  EventSetMillisecondTimer(ms: number): boolean {
    if (ms <= 0) return false;
    this.state.setTimer(Math.max(10, ms));
    return true;
  }

  EventKillTimer(): void {
    this.state.killTimer();
  }

  EventChartCustom(): boolean {
    return false;
  }

  WebRequest(): number {
    this.host.log('warn', 'WebRequest is not available to EAs running in the web runtime.');
    this.err(ERR.FUNCTION_NOT_ALLOWED);
    return -1;
  }

  /* ================================================================== */
  /* Account                                                             */
  /* ================================================================== */

  AccountInfoDouble(id: number): number {
    const a = this.host.account();
    switch (E.accDbl.get(id)) {
      case 'ACCOUNT_BALANCE':
        return a.balance;
      case 'ACCOUNT_CREDIT':
        return a.credit;
      case 'ACCOUNT_PROFIT':
        return a.profit;
      case 'ACCOUNT_EQUITY':
        return a.equity;
      case 'ACCOUNT_MARGIN':
        return a.margin;
      case 'ACCOUNT_MARGIN_FREE':
        return a.freeMargin;
      case 'ACCOUNT_MARGIN_LEVEL':
        return a.marginLevel;
      case 'ACCOUNT_MARGIN_SO_CALL':
        return a.marginSoCall;
      case 'ACCOUNT_MARGIN_SO_SO':
        return a.marginSoSo;
      case 'ACCOUNT_ASSETS':
        return a.equity;
      default:
        return 0;
    }
  }

  AccountInfoInteger(id: number): number {
    const a = this.host.account();
    switch (E.accInt.get(id)) {
      case 'ACCOUNT_LOGIN':
        return a.login;
      case 'ACCOUNT_TRADE_MODE':
        return a.tradeMode;
      case 'ACCOUNT_LEVERAGE':
        return a.leverage;
      case 'ACCOUNT_LIMIT_ORDERS':
        return a.limitOrders;
      case 'ACCOUNT_MARGIN_SO_MODE':
        return a.marginSoMode;
      case 'ACCOUNT_TRADE_ALLOWED':
      case 'ACCOUNT_TRADE_EXPERT':
        return 1;
      case 'ACCOUNT_MARGIN_MODE':
        return a.marginMode;
      case 'ACCOUNT_CURRENCY_DIGITS':
        return a.currencyDigits;
      case 'ACCOUNT_HEDGE_ALLOWED':
        return a.marginMode === 2 ? 1 : 0;
      default:
        return 0;
    }
  }

  AccountInfoString(id: number): string {
    const a = this.host.account();
    switch (E.accStr.get(id)) {
      case 'ACCOUNT_NAME':
        return a.name;
      case 'ACCOUNT_SERVER':
        return a.server;
      case 'ACCOUNT_CURRENCY':
        return a.currency;
      case 'ACCOUNT_COMPANY':
        return a.company;
      default:
        return '';
    }
  }

  /* ================================================================== */
  /* Symbols                                                             */
  /* ================================================================== */

  SymbolInfoDouble(symbol: string, id: number): number {
    const name = this.sym(symbol);
    const spec = this.spec(name);
    if (!spec) {
      this.err(ERR.MARKET_UNKNOWN_SYMBOL);
      return 0;
    }
    const q = this.host.quote(name);
    const s = this.host.market.has(name, 16408) ? this.host.market.get(name, 16408) : null;
    const last = s && s.length > 0 ? s.length - 1 : -1;
    switch (E.symDbl.get(id)) {
      case 'SYMBOL_BID':
        return q?.bid ?? 0;
      case 'SYMBOL_ASK':
        return q?.ask ?? 0;
      case 'SYMBOL_LAST':
        return q?.last ?? q?.bid ?? 0;
      case 'SYMBOL_BIDHIGH':
      case 'SYMBOL_LASTHIGH':
        return last >= 0 ? s!.high[last]! : q?.bid ?? 0;
      case 'SYMBOL_BIDLOW':
      case 'SYMBOL_LASTLOW':
        return last >= 0 ? s!.low[last]! : q?.bid ?? 0;
      case 'SYMBOL_ASKHIGH':
        return last >= 0 ? s!.high[last]! + (q ? q.ask - q.bid : 0) : q?.ask ?? 0;
      case 'SYMBOL_ASKLOW':
        return last >= 0 ? s!.low[last]! + (q ? q.ask - q.bid : 0) : q?.ask ?? 0;
      case 'SYMBOL_POINT':
        return spec.point;
      case 'SYMBOL_TRADE_TICK_VALUE':
        return spec.tickValue;
      case 'SYMBOL_TRADE_TICK_VALUE_PROFIT':
        return spec.tickValueProfit;
      case 'SYMBOL_TRADE_TICK_VALUE_LOSS':
        return spec.tickValueLoss;
      case 'SYMBOL_TRADE_TICK_SIZE':
        return spec.tickSize;
      case 'SYMBOL_TRADE_CONTRACT_SIZE':
        return spec.contractSize;
      case 'SYMBOL_VOLUME_MIN':
        return spec.volumeMin;
      case 'SYMBOL_VOLUME_MAX':
        return spec.volumeMax;
      case 'SYMBOL_VOLUME_STEP':
        return spec.volumeStep;
      case 'SYMBOL_VOLUME_LIMIT':
        return spec.volumeLimit;
      case 'SYMBOL_SWAP_LONG':
        return spec.swapLong;
      case 'SYMBOL_SWAP_SHORT':
        return spec.swapShort;
      case 'SYMBOL_MARGIN_INITIAL':
        return spec.marginInitial;
      case 'SYMBOL_MARGIN_MAINTENANCE':
        return spec.marginMaintenance;
      case 'SYMBOL_SESSION_OPEN':
        return last >= 0 ? s!.open[last]! : 0;
      case 'SYMBOL_SESSION_CLOSE':
        return last > 0 ? s!.close[last - 1]! : 0;
      case 'SYMBOL_PRICE_CHANGE':
        return last > 0 ? ((s!.close[last]! - s!.close[last - 1]!) / s!.close[last - 1]!) * 100 : 0;
      default:
        return 0;
    }
  }

  SymbolInfoDoubleRef(symbol: string, id: number, out: Ref<number>): boolean {
    if (!this.spec(this.sym(symbol))) {
      this.err(ERR.MARKET_UNKNOWN_SYMBOL);
      return false;
    }
    out.v = this.SymbolInfoDouble(symbol, id);
    return true;
  }

  SymbolInfoInteger(symbol: string, id: number): number {
    const name = this.sym(symbol);
    const spec = this.spec(name);
    if (!spec) {
      this.err(ERR.MARKET_UNKNOWN_SYMBOL);
      return 0;
    }
    const q = this.host.quote(name);
    switch (E.symInt.get(id)) {
      case 'SYMBOL_SELECT':
      case 'SYMBOL_VISIBLE':
      case 'SYMBOL_EXIST':
        return 1;
      case 'SYMBOL_DIGITS':
        return spec.digits;
      case 'SYMBOL_SPREAD':
        return q && spec.point > 0 ? Math.round((q.ask - q.bid) / spec.point) : 0;
      case 'SYMBOL_SPREAD_FLOAT':
        return 1;
      case 'SYMBOL_TIME':
        return q?.time ?? 0;
      case 'SYMBOL_TIME_MSC':
        return q?.timeMsc ?? 0;
      case 'SYMBOL_VOLUME':
        return q?.volume ?? 0;
      case 'SYMBOL_TRADE_STOPS_LEVEL':
        return spec.stopsLevel;
      case 'SYMBOL_TRADE_FREEZE_LEVEL':
        return spec.freezeLevel;
      case 'SYMBOL_TRADE_MODE':
        return spec.tradeMode;
      case 'SYMBOL_TRADE_EXEMODE':
        return spec.executionMode;
      case 'SYMBOL_TRADE_CALC_MODE':
        return spec.calcMode;
      case 'SYMBOL_FILLING_MODE':
        return spec.fillingFlags;
      case 'SYMBOL_ORDER_MODE':
        return spec.orderMode;
      case 'SYMBOL_EXPIRATION_MODE':
        return 15;
      case 'SYMBOL_SWAP_ROLLOVER3DAYS':
        return 3;
      default:
        return 0;
    }
  }

  SymbolInfoIntegerRef(symbol: string, id: number, out: Ref<number>): boolean {
    if (!this.spec(this.sym(symbol))) {
      this.err(ERR.MARKET_UNKNOWN_SYMBOL);
      return false;
    }
    out.v = this.SymbolInfoInteger(symbol, id);
    return true;
  }

  SymbolInfoString(symbol: string, id: number): string {
    const name = this.sym(symbol);
    const spec = this.spec(name);
    if (!spec) {
      this.err(ERR.MARKET_UNKNOWN_SYMBOL);
      return '';
    }
    switch (E.symStr.get(id)) {
      case 'SYMBOL_CURRENCY_BASE':
        return spec.currencyBase;
      case 'SYMBOL_CURRENCY_PROFIT':
        return spec.currencyProfit;
      case 'SYMBOL_CURRENCY_MARGIN':
        return spec.currencyMargin;
      case 'SYMBOL_DESCRIPTION':
        return spec.description;
      case 'SYMBOL_PATH':
        return spec.path;
      case 'SYMBOL_NAME':
        return spec.name;
      default:
        return '';
    }
  }

  SymbolInfoStringRef(symbol: string, id: number, out: Ref<string>): boolean {
    if (!this.spec(this.sym(symbol))) return false;
    out.v = this.SymbolInfoString(symbol, id);
    return true;
  }

  SymbolInfoTick(symbol: string, tick: Record<string, unknown>): boolean {
    const q = this.host.quote(this.sym(symbol));
    if (!q) {
      this.err(ERR.MARKET_UNKNOWN_SYMBOL);
      return false;
    }
    tick.time = q.time;
    tick.bid = q.bid;
    tick.ask = q.ask;
    tick.last = q.last;
    tick.volume = q.volume;
    tick.time_msc = q.timeMsc;
    tick.flags = 6;
    tick.volume_real = q.volume;
    return true;
  }

  SymbolSelect(name: string): boolean {
    return this.spec(this.sym(name)) !== null;
  }

  SymbolExist(name: string, custom: Ref<boolean>): boolean {
    custom.v = false;
    return this.spec(name) !== null;
  }

  SymbolsTotal(): number {
    return this.host.symbols().length;
  }

  SymbolName(pos: number): string {
    return this.host.symbols()[pos] ?? '';
  }

  SymbolIsSynchronized(name: string): boolean {
    return this.host.market.has(this.sym(name), this.host.timeframe);
  }

  SymbolInfoSessionTrade(_name: string, _day: number, index: number, from: Ref<number>, to: Ref<number>): boolean {
    if (index > 0) return false;
    from.v = 0;
    to.v = 86400;
    return true;
  }

  SymbolInfoSessionQuote(name: string, day: number, index: number, from: Ref<number>, to: Ref<number>): boolean {
    return this.SymbolInfoSessionTrade(name, day, index, from, to);
  }

  SymbolInfoMarginRate(_name: string, _type: number, initial: Ref<number>, maintenance: Ref<number>): boolean {
    initial.v = 1;
    maintenance.v = 1;
    return true;
  }

  /* ================================================================== */
  /* Series                                                              */
  /* ================================================================== */

  SeriesInfoInteger(symbol: string, tf: number, prop: number): number {
    const s = this.series(symbol, tf);
    switch (E.series.get(prop)) {
      case 'SERIES_BARS_COUNT':
        return s.length;
      case 'SERIES_FIRSTDATE':
      case 'SERIES_SERVER_FIRSTDATE':
      case 'SERIES_TERMINAL_FIRSTDATE':
        return s.length ? s.time[0]! : 0;
      case 'SERIES_LASTBAR_DATE':
        return s.length ? s.time[s.length - 1]! : 0;
      case 'SERIES_SYNCHRONIZED':
        return s.loaded ? 1 : 0;
      default:
        return 0;
    }
  }

  SeriesInfoIntegerRef(symbol: string, tf: number, prop: number, out: Ref<number>): boolean {
    out.v = this.SeriesInfoInteger(symbol, tf, prop);
    return true;
  }

  Bars(symbol: string, tf: number): number {
    return this.series(symbol, tf).length;
  }

  BarsRange(symbol: string, tf: number, start: number, stop: number): number {
    const r = this.rangeByTimes(this.series(symbol, tf), start, stop);
    return r ? r[1] - r[0] + 1 : 0;
  }

  iBars(symbol: string, tf: number): number {
    return this.Bars(symbol, tf);
  }

  private at(symbol: string, tf: number, shift: number, field: 'time' | 'open' | 'high' | 'low' | 'close' | 'tickVolume' | 'spread' | 'realVolume'): number {
    const s = this.series(symbol, tf);
    const i = s.length - 1 - shift;
    if (i < 0 || i >= s.length) {
      this.err(ERR.HISTORY_NOT_FOUND);
      return 0;
    }
    return s[field][i]!;
  }

  iTime(symbol: string, tf: number, shift: number): number {
    return this.at(symbol, tf, shift, 'time');
  }

  iOpen(symbol: string, tf: number, shift: number): number {
    return this.at(symbol, tf, shift, 'open');
  }

  iHigh(symbol: string, tf: number, shift: number): number {
    return this.at(symbol, tf, shift, 'high');
  }

  iLow(symbol: string, tf: number, shift: number): number {
    return this.at(symbol, tf, shift, 'low');
  }

  iClose(symbol: string, tf: number, shift: number): number {
    return this.at(symbol, tf, shift, 'close');
  }

  iVolume(symbol: string, tf: number, shift: number): number {
    return this.at(symbol, tf, shift, 'tickVolume');
  }

  iTickVolume(symbol: string, tf: number, shift: number): number {
    return this.at(symbol, tf, shift, 'tickVolume');
  }

  iRealVolume(symbol: string, tf: number, shift: number): number {
    return this.at(symbol, tf, shift, 'realVolume');
  }

  iSpread(symbol: string, tf: number, shift: number): number {
    return this.at(symbol, tf, shift, 'spread');
  }

  iBarShift(symbol: string, tf: number, time: number, exact: boolean): number {
    const s = this.series(symbol, tf);
    for (let i = s.length - 1; i >= 0; i -= 1) {
      if (s.time[i]! <= time) {
        if (exact && s.time[i] !== time) {
          const seconds = TIMEFRAME_SECONDS[this.tf(tf)] ?? 60;
          if (time - s.time[i]! >= seconds) return -1;
        }
        return s.length - 1 - i;
      }
    }
    return -1;
  }

  private extreme(symbol: string, tf: number, mode: number, count: number, start: number, highest: boolean): number {
    const s = this.series(symbol, tf);
    const fields = ['open', 'low', 'high', 'close', 'tickVolume', 'realVolume', 'spread'] as const;
    const field = fields[mode] ?? 'close';
    const n = s.length;
    const total = count === -1 ? n - start : count;
    let best = -1;
    let bestValue = highest ? -Infinity : Infinity;
    for (let shift = start; shift < start + total && shift < n; shift += 1) {
      const v = s[field][n - 1 - shift]!;
      if (highest ? v > bestValue : v < bestValue) {
        bestValue = v;
        best = shift;
      }
    }
    return best;
  }

  iHighest(symbol: string, tf: number, mode: number, count: number, start: number): number {
    return this.extreme(symbol, tf, mode, count, start, true);
  }

  iLowest(symbol: string, tf: number, mode: number, count: number, start: number): number {
    return this.extreme(symbol, tf, mode, count, start, false);
  }

  private rate(s: BarSeries, i: number): Record<string, unknown> {
    const r = this.makeStruct('MqlRates');
    r.time = s.time[i];
    r.open = s.open[i];
    r.high = s.high[i];
    r.low = s.low[i];
    r.close = s.close[i];
    r.tick_volume = s.tickVolume[i];
    r.spread = s.spread[i];
    r.real_volume = s.realVolume[i];
    return r;
  }

  CopyRates(symbol: string, tf: number, start: number, count: number, arr: MqlArray): number {
    return this.copySeries(symbol, tf, (s) => this.rangeByShift(s, start, count), (s, i) => this.rate(s, i), arr);
  }

  CopyRatesFrom(symbol: string, tf: number, startTime: number, count: number, arr: MqlArray): number {
    return this.copySeries(symbol, tf, (s) => this.rangeByTime(s, startTime, count), (s, i) => this.rate(s, i), arr);
  }

  CopyRatesRange(symbol: string, tf: number, a: number, b: number, arr: MqlArray): number {
    return this.copySeries(symbol, tf, (s) => this.rangeByTimes(s, a, b), (s, i) => this.rate(s, i), arr);
  }

  private field(name: 'time' | 'open' | 'high' | 'low' | 'close' | 'tickVolume' | 'spread' | 'realVolume') {
    return (s: BarSeries, i: number): number => s[name][i]!;
  }

  CopyTime(symbol: string, tf: number, start: number, count: number, arr: MqlArray<number>): number {
    return this.copySeries(symbol, tf, (s) => this.rangeByShift(s, start, count), this.field('time'), arr);
  }

  CopyTimeFrom(symbol: string, tf: number, t: number, count: number, arr: MqlArray<number>): number {
    return this.copySeries(symbol, tf, (s) => this.rangeByTime(s, t, count), this.field('time'), arr);
  }

  CopyTimeRange(symbol: string, tf: number, a: number, b: number, arr: MqlArray<number>): number {
    return this.copySeries(symbol, tf, (s) => this.rangeByTimes(s, a, b), this.field('time'), arr);
  }

  CopyOpen(symbol: string, tf: number, start: number, count: number, arr: MqlArray<number>): number {
    return this.copySeries(symbol, tf, (s) => this.rangeByShift(s, start, count), this.field('open'), arr);
  }

  CopyOpenFrom(symbol: string, tf: number, t: number, count: number, arr: MqlArray<number>): number {
    return this.copySeries(symbol, tf, (s) => this.rangeByTime(s, t, count), this.field('open'), arr);
  }

  CopyOpenRange(symbol: string, tf: number, a: number, b: number, arr: MqlArray<number>): number {
    return this.copySeries(symbol, tf, (s) => this.rangeByTimes(s, a, b), this.field('open'), arr);
  }

  CopyHigh(symbol: string, tf: number, start: number, count: number, arr: MqlArray<number>): number {
    return this.copySeries(symbol, tf, (s) => this.rangeByShift(s, start, count), this.field('high'), arr);
  }

  CopyHighFrom(symbol: string, tf: number, t: number, count: number, arr: MqlArray<number>): number {
    return this.copySeries(symbol, tf, (s) => this.rangeByTime(s, t, count), this.field('high'), arr);
  }

  CopyHighRange(symbol: string, tf: number, a: number, b: number, arr: MqlArray<number>): number {
    return this.copySeries(symbol, tf, (s) => this.rangeByTimes(s, a, b), this.field('high'), arr);
  }

  CopyLow(symbol: string, tf: number, start: number, count: number, arr: MqlArray<number>): number {
    return this.copySeries(symbol, tf, (s) => this.rangeByShift(s, start, count), this.field('low'), arr);
  }

  CopyLowFrom(symbol: string, tf: number, t: number, count: number, arr: MqlArray<number>): number {
    return this.copySeries(symbol, tf, (s) => this.rangeByTime(s, t, count), this.field('low'), arr);
  }

  CopyLowRange(symbol: string, tf: number, a: number, b: number, arr: MqlArray<number>): number {
    return this.copySeries(symbol, tf, (s) => this.rangeByTimes(s, a, b), this.field('low'), arr);
  }

  CopyClose(symbol: string, tf: number, start: number, count: number, arr: MqlArray<number>): number {
    return this.copySeries(symbol, tf, (s) => this.rangeByShift(s, start, count), this.field('close'), arr);
  }

  CopyCloseFrom(symbol: string, tf: number, t: number, count: number, arr: MqlArray<number>): number {
    return this.copySeries(symbol, tf, (s) => this.rangeByTime(s, t, count), this.field('close'), arr);
  }

  CopyCloseRange(symbol: string, tf: number, a: number, b: number, arr: MqlArray<number>): number {
    return this.copySeries(symbol, tf, (s) => this.rangeByTimes(s, a, b), this.field('close'), arr);
  }

  CopyTickVolume(symbol: string, tf: number, start: number, count: number, arr: MqlArray<number>): number {
    return this.copySeries(symbol, tf, (s) => this.rangeByShift(s, start, count), this.field('tickVolume'), arr);
  }

  CopyTickVolumeFrom(symbol: string, tf: number, t: number, count: number, arr: MqlArray<number>): number {
    return this.copySeries(symbol, tf, (s) => this.rangeByTime(s, t, count), this.field('tickVolume'), arr);
  }

  CopyRealVolume(symbol: string, tf: number, start: number, count: number, arr: MqlArray<number>): number {
    return this.copySeries(symbol, tf, (s) => this.rangeByShift(s, start, count), this.field('realVolume'), arr);
  }

  CopySpread(symbol: string, tf: number, start: number, count: number, arr: MqlArray<number>): number {
    return this.copySeries(symbol, tf, (s) => this.rangeByShift(s, start, count), this.field('spread'), arr);
  }

  CopyTicks(symbol: string, arr: MqlArray): number {
    // Only the current tick is kept; tick-history EAs get what exists now.
    const q = this.host.quote(this.sym(symbol));
    if (!q) return -1;
    const t = this.makeStruct('MqlTick');
    this.SymbolInfoTick(symbol, t);
    return this.fill(arr, [t]);
  }

  CopyTicksRange(symbol: string, arr: MqlArray): number {
    return this.CopyTicks(symbol, arr);
  }

  /* ------------------------------------------------------------------ */
  /* Indicators                                                          */
  /* ------------------------------------------------------------------ */

  private createIndicator(kind: IndicatorKind, symbol: string, tf: number, params: number[]): number {
    const name = this.sym(symbol);
    if (!this.spec(name)) {
      this.err(ERR.MARKET_UNKNOWN_SYMBOL);
      return -1;
    }
    const timeframe = this.tf(tf);
    // Identical indicators share one handle, as in the terminal.
    for (const [handle, inst] of this.indicators) {
      const spec = inst.spec;
      if (spec.kind === kind && spec.symbol === name && spec.timeframe === timeframe && spec.params.join() === params.join()) return handle;
    }
    const handle = this.nextHandle++;
    this.indicators.set(handle, new IndicatorInstance({ kind, symbol: name, timeframe, params }, this.host.market.get(name, timeframe)));
    return handle;
  }

  iMA(symbol: string, tf: number, period: number, shift: number, method: number, applied: number): number {
    if (applied >= 10) return this.indicatorOnIndicator('iMA');
    return this.createIndicator('MA', symbol, tf, [period, shift, method, applied]);
  }

  private indicatorOnIndicator(name: string): number {
    this.host.log('error', `${name} applied to another indicator's handle is not supported by the web runtime.`);
    this.err(ERR.INDICATOR_CANNOT_CREATE);
    return -1;
  }

  iRSI(symbol: string, tf: number, period: number, applied: number): number {
    if (applied >= 10) return this.indicatorOnIndicator('iRSI');
    return this.createIndicator('RSI', symbol, tf, [period, applied]);
  }

  iATR(symbol: string, tf: number, period: number): number {
    return this.createIndicator('ATR', symbol, tf, [period]);
  }

  iADX(symbol: string, tf: number, period: number): number {
    return this.createIndicator('ADX', symbol, tf, [period]);
  }

  iADXWilder(symbol: string, tf: number, period: number): number {
    return this.createIndicator('ADXW', symbol, tf, [period]);
  }

  iBands(symbol: string, tf: number, period: number, shift: number, deviation: number, applied: number): number {
    return this.createIndicator('BANDS', symbol, tf, [period, shift, deviation, applied]);
  }

  iMACD(symbol: string, tf: number, fast: number, slow: number, signal: number, applied: number): number {
    return this.createIndicator('MACD', symbol, tf, [fast, slow, signal, applied]);
  }

  iOsMA(symbol: string, tf: number, fast: number, slow: number, signal: number, applied: number): number {
    return this.createIndicator('OSMA', symbol, tf, [fast, slow, signal, applied]);
  }

  iStochastic(symbol: string, tf: number, k: number, d: number, slowing: number, method: number, price: number): number {
    return this.createIndicator('STOCH', symbol, tf, [k, d, slowing, method, price]);
  }

  iCCI(symbol: string, tf: number, period: number, applied: number): number {
    return this.createIndicator('CCI', symbol, tf, [period, applied]);
  }

  iMomentum(symbol: string, tf: number, period: number, applied: number): number {
    return this.createIndicator('MOMENTUM', symbol, tf, [period, applied]);
  }

  iSAR(symbol: string, tf: number, step: number, maximum: number): number {
    return this.createIndicator('SAR', symbol, tf, [step, maximum]);
  }

  iWPR(symbol: string, tf: number, period: number): number {
    return this.createIndicator('WPR', symbol, tf, [period]);
  }

  iEnvelopes(symbol: string, tf: number, period: number, shift: number, method: number, applied: number, deviation: number): number {
    return this.createIndicator('ENVELOPES', symbol, tf, [period, shift, method, applied, deviation]);
  }

  iStdDev(symbol: string, tf: number, period: number, shift: number, method: number, applied: number): number {
    return this.createIndicator('STDDEV', symbol, tf, [period, shift, method, applied]);
  }

  iAO(symbol: string, tf: number): number {
    return this.createIndicator('AO', symbol, tf, []);
  }

  iAC(symbol: string, tf: number): number {
    return this.createIndicator('AC', symbol, tf, []);
  }

  iDEMA(symbol: string, tf: number, period: number, shift: number, applied: number): number {
    return this.createIndicator('DEMA', symbol, tf, [period, shift, applied]);
  }

  iTEMA(symbol: string, tf: number, period: number, shift: number, applied: number): number {
    return this.createIndicator('TEMA', symbol, tf, [period, shift, applied]);
  }

  iMFI(symbol: string, tf: number, period: number, volume: number): number {
    return this.createIndicator('MFI', symbol, tf, [period, volume]);
  }

  iOBV(symbol: string, tf: number, volume: number): number {
    return this.createIndicator('OBV', symbol, tf, [volume]);
  }

  iForce(symbol: string, tf: number, period: number, method: number, volume: number): number {
    return this.createIndicator('FORCE', symbol, tf, [period, method, volume]);
  }

  iDeMarker(symbol: string, tf: number, period: number): number {
    return this.createIndicator('DEMARKER', symbol, tf, [period]);
  }

  iBullsPower(symbol: string, tf: number, period: number): number {
    return this.createIndicator('BULLS', symbol, tf, [period]);
  }

  iBearsPower(symbol: string, tf: number, period: number): number {
    return this.createIndicator('BEARS', symbol, tf, [period]);
  }

  iIchimoku(symbol: string, tf: number, tenkan: number, kijun: number, senkou: number): number {
    return this.createIndicator('ICHIMOKU', symbol, tf, [tenkan, kijun, senkou]);
  }

  iAlligator(symbol: string, tf: number, jaw: number, jawShift: number, teeth: number, teethShift: number, lips: number, lipsShift: number, method: number, applied: number): number {
    return this.createIndicator('ALLIGATOR', symbol, tf, [jaw, jawShift, teeth, teethShift, lips, lipsShift, method, applied]);
  }

  iFractals(symbol: string, tf: number): number {
    return this.createIndicator('FRACTALS', symbol, tf, []);
  }

  iVolumes(symbol: string, tf: number, volume: number): number {
    return this.createIndicator('VOLUMES', symbol, tf, [volume]);
  }

  iCustom(_symbol: string, _tf: number, name: string): number {
    this.host.log(
      'error',
      `iCustom("${name}") needs the compiled indicator, which only MetaTrader can run. Rewrite the signal with the built-in indicators (iMA, iRSI, iATR, …) or run this EA in MT5 with mirror mode.`,
    );
    this.err(ERR.INDICATOR_CANNOT_CREATE);
    return -1;
  }

  IndicatorCreate(): number {
    this.host.log('error', 'IndicatorCreate is not supported by the web runtime; use the iMA/iRSI/… functions.');
    this.err(ERR.INDICATOR_CANNOT_CREATE);
    return -1;
  }

  private indicator(handle: number): IndicatorInstance | null {
    const inst = this.indicators.get(handle);
    if (!inst) {
      this.err(ERR.INDICATOR_WRONG_HANDLE);
      return null;
    }
    if (!inst.series.loaded) {
      this.err(ERR.INDICATOR_DATA_NOT_FOUND);
      return null;
    }
    inst.update();
    return inst;
  }

  private copyIndicator(handle: number, buffer: number, shifts: number[] | null, arr: MqlArray<number>): number {
    const inst = this.indicator(handle);
    if (!inst) return -1;
    if (buffer < 0 || buffer >= inst.visible) {
      this.err(ERR.INVALID_PARAMETER);
      return -1;
    }
    if (!shifts || shifts.length === 0) {
      this.err(ERR.INDICATOR_DATA_NOT_FOUND);
      return -1;
    }
    // Chronological: oldest first, like the terminal.
    const values = shifts.map((shift) => inst.valueAt(buffer, shift));
    return this.fill(arr, values);
  }

  CopyBuffer(handle: number, buffer: number, start: number, count: number, arr: MqlArray<number>): number {
    const inst = this.indicators.get(handle);
    if (!inst) {
      this.err(ERR.INDICATOR_WRONG_HANDLE);
      return -1;
    }
    const n = inst.series.length;
    if (count <= 0 || start < 0 || start >= n) {
      this.err(ERR.INDICATOR_DATA_NOT_FOUND);
      return -1;
    }
    const last = Math.min(n - 1, start + count - 1);
    const shifts: number[] = [];
    for (let s = last; s >= start; s -= 1) shifts.push(s);
    return this.copyIndicator(handle, buffer, shifts, arr);
  }

  CopyBufferFrom(handle: number, buffer: number, startTime: number, count: number, arr: MqlArray<number>): number {
    const inst = this.indicators.get(handle);
    if (!inst) return -1;
    const r = this.rangeByTime(inst.series, startTime, count);
    if (!r) return -1;
    const n = inst.series.length;
    const shifts: number[] = [];
    for (let i = r[0]; i <= r[1]; i += 1) shifts.push(n - 1 - i);
    return this.copyIndicator(handle, buffer, shifts, arr);
  }

  CopyBufferRange(handle: number, buffer: number, a: number, b: number, arr: MqlArray<number>): number {
    const inst = this.indicators.get(handle);
    if (!inst) return -1;
    const r = this.rangeByTimes(inst.series, a, b);
    if (!r) return -1;
    const n = inst.series.length;
    const shifts: number[] = [];
    for (let i = r[0]; i <= r[1]; i += 1) shifts.push(n - 1 - i);
    return this.copyIndicator(handle, buffer, shifts, arr);
  }

  BarsCalculated(handle: number): number {
    const inst = this.indicators.get(handle);
    if (!inst) return -1;
    if (!inst.series.loaded) return -1;
    return inst.update();
  }

  IndicatorRelease(handle: number): boolean {
    return this.indicators.delete(handle);
  }

  /* ================================================================== */
  /* Trading                                                             */
  /* ================================================================== */

  private toRequest(r: Record<string, unknown>): TradeRequest {
    return {
      action: Number(r.action) || 0,
      magic: Number(r.magic) || 0,
      order: Number(r.order) || 0,
      symbol: this.sym(r.symbol),
      volume: Number(r.volume) || 0,
      price: Number(r.price) || 0,
      stoplimit: Number(r.stoplimit) || 0,
      sl: Number(r.sl) || 0,
      tp: Number(r.tp) || 0,
      deviation: Number(r.deviation) || 0,
      type: Number(r.type) || 0,
      typeFilling: Number(r.type_filling) || 0,
      typeTime: Number(r.type_time) || 0,
      expiration: Number(r.expiration) || 0,
      comment: String(r.comment ?? ''),
      position: Number(r.position) || 0,
      positionBy: Number(r.position_by) || 0,
    };
  }

  private writeResult(out: Record<string, unknown>, res: TradeResult): void {
    out.retcode = res.retcode;
    out.deal = res.deal;
    out.order = res.order;
    out.volume = res.volume;
    out.price = res.price;
    out.bid = res.bid;
    out.ask = res.ask;
    out.comment = res.comment;
    out.request_id = res.requestId;
    out.retcode_external = res.retcodeExternal;
  }

  private failResult(retcode: number, comment: string): TradeResult {
    const q = this.host.quote(this.host.symbol);
    return { retcode, deal: 0, order: 0, volume: 0, price: 0, bid: q?.bid ?? 0, ask: q?.ask ?? 0, comment, requestId: 0, retcodeExternal: 0 };
  }

  /** Checks a request can go out at all, before anything is sent. */
  private precheck(req: TradeRequest): TradeResult | null {
    if (!this.host.connected()) return this.failResult(RC.CONNECTION, 'No connection with the trade server');
    if (!this.host.tradeAllowed()) return this.failResult(RC.CLIENT_DISABLES_AT, 'AutoTrading disabled by client');
    if (req.action === 1 || req.action === 5) {
      const spec = this.spec(req.symbol);
      if (!spec) return this.failResult(RC.INVALID, `unknown symbol ${req.symbol}`);
      if (req.volume < spec.volumeMin - 1e-9 || req.volume > spec.volumeMax + 1e-9) {
        return this.failResult(RC.INVALID_VOLUME, `Invalid volume ${req.volume} (min ${spec.volumeMin}, max ${spec.volumeMax})`);
      }
    }
    return null;
  }

  async OrderSend(request: Record<string, unknown>, result: Record<string, unknown>): Promise<boolean> {
    const req = this.toRequest(request);
    const early = this.precheck(req);
    let res: TradeResult;
    if (early) {
      res = early;
    } else {
      try {
        res = await this.host.orderSend(req);
      } catch (err) {
        res = this.failResult(10011, err instanceof Error ? err.message : String(err));
      }
    }
    res.requestId = this.requestId++;
    this.writeResult(result, res);
    this.state.tradeCompleted(req, res);
    const ok = res.retcode === RC.DONE || res.retcode === RC.PLACED || res.retcode === RC.DONE_PARTIAL || res.retcode === RC.NO_CHANGES;
    if (!ok) this.err(ERR.TRADE_SEND_FAILED);
    return ok;
  }

  OrderSendAsync(request: Record<string, unknown>, result: Record<string, unknown>): boolean {
    const req = this.toRequest(request);
    const early = this.precheck(req);
    const id = this.requestId++;
    if (early) {
      early.requestId = id;
      this.writeResult(result, early);
      this.err(ERR.TRADE_SEND_FAILED);
      return false;
    }
    // Sent without waiting: the answer arrives through OnTradeTransaction.
    void this.host
      .orderSend(req)
      .catch((err: unknown) => this.failResult(10011, err instanceof Error ? err.message : String(err)))
      .then((res) => {
        res.requestId = id;
        this.state.tradeCompleted(req, res);
      });
    const q = this.host.quote(req.symbol);
    this.writeResult(result, { retcode: RC.PLACED, deal: 0, order: 0, volume: req.volume, price: req.price, bid: q?.bid ?? 0, ask: q?.ask ?? 0, comment: 'Request sent', requestId: id, retcodeExternal: 0 });
    return true;
  }

  OrderCheck(request: Record<string, unknown>, result: Record<string, unknown>): boolean {
    const req = this.toRequest(request);
    const a = this.host.account();
    const early = this.precheck(req);
    let margin = 0;
    if (!early && (req.action === 1 || req.action === 5)) {
      const ref = { v: 0 };
      this.OrderCalcMargin(req.type, req.symbol, req.volume, req.price || this.host.quote(req.symbol)?.ask || 0, ref);
      margin = ref.v;
    }
    const free = a.freeMargin - margin;
    const retcode = early ? early.retcode : free < 0 ? RC.NO_MONEY : 0;
    result.retcode = retcode;
    result.balance = a.balance;
    result.equity = a.equity;
    result.profit = a.profit;
    result.margin = a.margin + margin;
    result.margin_free = free;
    result.margin_level = a.margin + margin > 0 ? (a.equity / (a.margin + margin)) * 100 : 0;
    result.comment = retcode === 0 ? 'Done' : early?.comment ?? 'Not enough money';
    return retcode === 0;
  }

  OrderCalcMargin(_type: number, symbol: string, volume: number, price: number, margin: Ref<number>): boolean {
    const spec = this.spec(this.sym(symbol));
    if (!spec) {
      this.err(ERR.MARKET_UNKNOWN_SYMBOL);
      return false;
    }
    const leverage = Math.max(1, this.host.account().leverage);
    const px = price > 0 ? price : this.host.quote(spec.name)?.ask ?? 0;
    margin.v = spec.marginInitial > 0 && spec.calcMode === 1 ? spec.marginInitial * volume : (spec.contractSize * volume * px) / leverage;
    return true;
  }

  OrderCalcProfit(type: number, symbol: string, volume: number, open: number, close: number, profit: Ref<number>): boolean {
    const spec = this.spec(this.sym(symbol));
    if (!spec || spec.tickSize <= 0) {
      this.err(ERR.MARKET_UNKNOWN_SYMBOL);
      return false;
    }
    const direction = type === 0 || type === 2 || type === 4 || type === 6 ? 1 : -1;
    const move = (close - open) * direction;
    profit.v = (move / spec.tickSize) * (move >= 0 ? spec.tickValueProfit : spec.tickValueLoss) * volume;
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Positions                                                           */
  /* ------------------------------------------------------------------ */

  PositionsTotal(): number {
    return this.host.positions().length;
  }

  PositionGetTicket(index: number): number {
    const p = this.host.positions()[index];
    if (!p) {
      this.selectedPosition = null;
      this.err(ERR.TRADE_POSITION_NOT_FOUND);
      return 0;
    }
    this.selectedPosition = { ...p };
    return p.ticket;
  }

  PositionGetSymbol(index: number): string {
    return this.PositionGetTicket(index) ? this.selectedPosition!.symbol : '';
  }

  PositionSelect(symbol: string): boolean {
    const name = this.sym(symbol);
    const matching = this.host.positions().filter((p) => p.symbol === name).sort((a, b) => a.ticket - b.ticket);
    const p = matching[0];
    this.selectedPosition = p ? { ...p } : null;
    if (!p) this.err(ERR.TRADE_POSITION_NOT_FOUND);
    return Boolean(p);
  }

  PositionSelectByTicket(ticket: number): boolean {
    const p = this.host.positions().find((x) => x.ticket === ticket);
    this.selectedPosition = p ? { ...p } : null;
    if (!p) this.err(ERR.TRADE_POSITION_NOT_FOUND);
    return Boolean(p);
  }

  PositionGetDouble(id: number): number {
    const p = this.selectedPosition;
    if (!p) {
      this.err(ERR.TRADE_POSITION_NOT_FOUND);
      return 0;
    }
    switch (E.posDbl.get(id)) {
      case 'POSITION_VOLUME':
        return p.volume;
      case 'POSITION_PRICE_OPEN':
        return p.priceOpen;
      case 'POSITION_SL':
        return p.sl;
      case 'POSITION_TP':
        return p.tp;
      case 'POSITION_PRICE_CURRENT':
        return p.priceCurrent;
      case 'POSITION_SWAP':
        return p.swap;
      case 'POSITION_PROFIT':
        return p.profit;
      case 'POSITION_COMMISSION':
        return p.commission;
      default:
        return 0;
    }
  }

  PositionGetDoubleRef(id: number, out: Ref<number>): boolean {
    if (!this.selectedPosition) return false;
    out.v = this.PositionGetDouble(id);
    return true;
  }

  PositionGetInteger(id: number): number {
    const p = this.selectedPosition;
    if (!p) {
      this.err(ERR.TRADE_POSITION_NOT_FOUND);
      return 0;
    }
    switch (E.posInt.get(id)) {
      case 'POSITION_TICKET':
        return p.ticket;
      case 'POSITION_TIME':
        return p.time;
      case 'POSITION_TIME_MSC':
        return p.timeMsc;
      case 'POSITION_TIME_UPDATE':
        return p.timeUpdate;
      case 'POSITION_TIME_UPDATE_MSC':
        return p.timeUpdate * 1000;
      case 'POSITION_TYPE':
        return p.type;
      case 'POSITION_MAGIC':
        return p.magic;
      case 'POSITION_IDENTIFIER':
        return p.identifier;
      case 'POSITION_REASON':
        return p.reason;
      default:
        return 0;
    }
  }

  PositionGetIntegerRef(id: number, out: Ref<number>): boolean {
    if (!this.selectedPosition) return false;
    out.v = this.PositionGetInteger(id);
    return true;
  }

  PositionGetString(id: number): string {
    const p = this.selectedPosition;
    if (!p) {
      this.err(ERR.TRADE_POSITION_NOT_FOUND);
      return '';
    }
    switch (E.posStr.get(id)) {
      case 'POSITION_SYMBOL':
        return p.symbol;
      case 'POSITION_COMMENT':
        return p.comment;
      case 'POSITION_EXTERNAL_ID':
        return p.externalId;
      default:
        return '';
    }
  }

  PositionGetStringRef(id: number, out: Ref<string>): boolean {
    if (!this.selectedPosition) return false;
    out.v = this.PositionGetString(id);
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Pending orders                                                      */
  /* ------------------------------------------------------------------ */

  OrdersTotal(): number {
    return this.host.orders().length;
  }

  OrderGetTicket(index: number): number {
    const o = this.host.orders()[index];
    this.selectedOrder = o ? { ...o } : null;
    if (!o) this.err(ERR.TRADE_ORDER_NOT_FOUND);
    return o?.ticket ?? 0;
  }

  OrderSelect(ticket: number): boolean {
    const o = this.host.orders().find((x) => x.ticket === ticket);
    this.selectedOrder = o ? { ...o } : null;
    if (!o) this.err(ERR.TRADE_ORDER_NOT_FOUND);
    return Boolean(o);
  }

  private orderDouble(o: HostOrder | null | undefined, id: number): number {
    if (!o) return 0;
    switch (E.ordDbl.get(id)) {
      case 'ORDER_VOLUME_INITIAL':
        return o.volumeInitial;
      case 'ORDER_VOLUME_CURRENT':
        return o.volumeCurrent;
      case 'ORDER_PRICE_OPEN':
        return o.priceOpen;
      case 'ORDER_SL':
        return o.sl;
      case 'ORDER_TP':
        return o.tp;
      case 'ORDER_PRICE_CURRENT':
        return o.priceCurrent;
      case 'ORDER_PRICE_STOPLIMIT':
        return o.priceStopLimit;
      default:
        return 0;
    }
  }

  private orderInteger(o: HostOrder | null | undefined, id: number): number {
    if (!o) return 0;
    switch (E.ordInt.get(id)) {
      case 'ORDER_TICKET':
        return o.ticket;
      case 'ORDER_TIME_SETUP':
        return o.timeSetup;
      case 'ORDER_TYPE':
        return o.type;
      case 'ORDER_STATE':
        return o.state;
      case 'ORDER_TIME_EXPIRATION':
        return o.timeExpiration;
      case 'ORDER_TIME_DONE':
        return o.timeDone;
      case 'ORDER_TIME_SETUP_MSC':
        return o.timeSetupMsc;
      case 'ORDER_TIME_DONE_MSC':
        return o.timeDoneMsc;
      case 'ORDER_TYPE_FILLING':
        return o.typeFilling;
      case 'ORDER_TYPE_TIME':
        return o.typeTime;
      case 'ORDER_MAGIC':
        return o.magic;
      case 'ORDER_REASON':
        return o.reason;
      case 'ORDER_POSITION_ID':
        return o.positionId;
      case 'ORDER_POSITION_BY_ID':
        return o.positionById;
      default:
        return 0;
    }
  }

  private orderString(o: HostOrder | null | undefined, id: number): string {
    if (!o) return '';
    switch (E.ordStr.get(id)) {
      case 'ORDER_SYMBOL':
        return o.symbol;
      case 'ORDER_COMMENT':
        return o.comment;
      case 'ORDER_EXTERNAL_ID':
        return o.externalId;
      default:
        return '';
    }
  }

  OrderGetDouble(id: number): number {
    return this.orderDouble(this.selectedOrder, id);
  }

  OrderGetDoubleRef(id: number, out: Ref<number>): boolean {
    if (!this.selectedOrder) return false;
    out.v = this.OrderGetDouble(id);
    return true;
  }

  OrderGetInteger(id: number): number {
    return this.orderInteger(this.selectedOrder, id);
  }

  OrderGetIntegerRef(id: number, out: Ref<number>): boolean {
    if (!this.selectedOrder) return false;
    out.v = this.OrderGetInteger(id);
    return true;
  }

  OrderGetString(id: number): string {
    return this.orderString(this.selectedOrder, id);
  }

  OrderGetStringRef(id: number, out: Ref<string>): boolean {
    if (!this.selectedOrder) return false;
    out.v = this.OrderGetString(id);
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* History                                                             */
  /* ------------------------------------------------------------------ */

  HistorySelect(from: number, to: number): boolean {
    this.historyDeals = this.host.deals(from, to).sort((a, b) => a.time - b.time || a.ticket - b.ticket);
    this.historyOrders = this.host.historyOrders(from, to).sort((a, b) => a.timeSetup - b.timeSetup || a.ticket - b.ticket);
    return true;
  }

  HistorySelectByPosition(positionId: number): boolean {
    this.historyDeals = this.host.deals(0, Number.MAX_SAFE_INTEGER).filter((d) => d.positionId === positionId);
    this.historyOrders = this.host.historyOrders(0, Number.MAX_SAFE_INTEGER).filter((o) => o.positionId === positionId);
    return true;
  }

  HistoryDealsTotal(): number {
    return this.historyDeals.length;
  }

  HistoryDealGetTicket(index: number): number {
    const d = this.historyDeals[index];
    if (!d) this.err(ERR.TRADE_DEAL_NOT_FOUND);
    return d?.ticket ?? 0;
  }

  HistoryDealSelect(ticket: number): boolean {
    let d = this.historyDeals.find((x) => x.ticket === ticket);
    if (!d) {
      d = this.host.deals(0, Number.MAX_SAFE_INTEGER).find((x) => x.ticket === ticket);
      if (d) this.historyDeals = [d];
    }
    if (!d) this.err(ERR.TRADE_DEAL_NOT_FOUND);
    return Boolean(d);
  }

  private deal(ticket: number): HostDeal | undefined {
    const d = this.historyDeals.find((x) => x.ticket === ticket);
    if (!d) this.err(ERR.TRADE_DEAL_NOT_FOUND);
    return d;
  }

  HistoryDealGetDouble(ticket: number, id: number): number {
    const d = this.deal(ticket);
    if (!d) return 0;
    switch (E.dealDbl.get(id)) {
      case 'DEAL_VOLUME':
        return d.volume;
      case 'DEAL_PRICE':
        return d.price;
      case 'DEAL_COMMISSION':
        return d.commission;
      case 'DEAL_SWAP':
        return d.swap;
      case 'DEAL_PROFIT':
        return d.profit;
      case 'DEAL_FEE':
        return d.fee;
      case 'DEAL_SL':
        return d.sl;
      case 'DEAL_TP':
        return d.tp;
      default:
        return 0;
    }
  }

  HistoryDealGetDoubleRef(ticket: number, id: number, out: Ref<number>): boolean {
    if (!this.deal(ticket)) return false;
    out.v = this.HistoryDealGetDouble(ticket, id);
    return true;
  }

  HistoryDealGetInteger(ticket: number, id: number): number {
    const d = this.deal(ticket);
    if (!d) return 0;
    switch (E.dealInt.get(id)) {
      case 'DEAL_TICKET':
        return d.ticket;
      case 'DEAL_ORDER':
        return d.order;
      case 'DEAL_TIME':
        return d.time;
      case 'DEAL_TIME_MSC':
        return d.timeMsc;
      case 'DEAL_TYPE':
        return d.type;
      case 'DEAL_ENTRY':
        return d.entry;
      case 'DEAL_MAGIC':
        return d.magic;
      case 'DEAL_REASON':
        return d.reason;
      case 'DEAL_POSITION_ID':
        return d.positionId;
      default:
        return 0;
    }
  }

  HistoryDealGetIntegerRef(ticket: number, id: number, out: Ref<number>): boolean {
    if (!this.deal(ticket)) return false;
    out.v = this.HistoryDealGetInteger(ticket, id);
    return true;
  }

  HistoryDealGetString(ticket: number, id: number): string {
    const d = this.deal(ticket);
    if (!d) return '';
    switch (E.dealStr.get(id)) {
      case 'DEAL_SYMBOL':
        return d.symbol;
      case 'DEAL_COMMENT':
        return d.comment;
      case 'DEAL_EXTERNAL_ID':
        return d.externalId;
      default:
        return '';
    }
  }

  HistoryDealGetStringRef(ticket: number, id: number, out: Ref<string>): boolean {
    if (!this.deal(ticket)) return false;
    out.v = this.HistoryDealGetString(ticket, id);
    return true;
  }

  HistoryOrdersTotal(): number {
    return this.historyOrders.length;
  }

  HistoryOrderGetTicket(index: number): number {
    return this.historyOrders[index]?.ticket ?? 0;
  }

  HistoryOrderSelect(ticket: number): boolean {
    let o = this.historyOrders.find((x) => x.ticket === ticket);
    if (!o) {
      o = this.host.historyOrders(0, Number.MAX_SAFE_INTEGER).find((x) => x.ticket === ticket);
      if (o) this.historyOrders = [o];
    }
    return Boolean(o);
  }

  private historyOrder(ticket: number): HostOrder | undefined {
    return this.historyOrders.find((x) => x.ticket === ticket);
  }

  HistoryOrderGetDouble(ticket: number, id: number): number {
    return this.orderDouble(this.historyOrder(ticket), id);
  }

  HistoryOrderGetDoubleRef(ticket: number, id: number, out: Ref<number>): boolean {
    const o = this.historyOrder(ticket);
    if (!o) return false;
    out.v = this.orderDouble(o, id);
    return true;
  }

  HistoryOrderGetInteger(ticket: number, id: number): number {
    return this.orderInteger(this.historyOrder(ticket), id);
  }

  HistoryOrderGetIntegerRef(ticket: number, id: number, out: Ref<number>): boolean {
    const o = this.historyOrder(ticket);
    if (!o) return false;
    out.v = this.orderInteger(o, id);
    return true;
  }

  HistoryOrderGetString(ticket: number, id: number): string {
    return this.orderString(this.historyOrder(ticket), id);
  }

  HistoryOrderGetStringRef(ticket: number, id: number, out: Ref<string>): boolean {
    const o = this.historyOrder(ticket);
    if (!o) return false;
    out.v = this.orderString(o, id);
    return true;
  }

  /* ================================================================== */
  /* Time                                                                */
  /* ================================================================== */

  private toStruct(t: number, dt: Record<string, unknown>): void {
    const d = new Date(Math.trunc(t) * 1000);
    dt.year = d.getUTCFullYear();
    dt.mon = d.getUTCMonth() + 1;
    dt.day = d.getUTCDate();
    dt.hour = d.getUTCHours();
    dt.min = d.getUTCMinutes();
    dt.sec = d.getUTCSeconds();
    dt.day_of_week = d.getUTCDay();
    dt.day_of_year = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000);
  }

  TimeCurrent(): number {
    return this.host.serverTime();
  }

  TimeCurrentStruct(dt: Record<string, unknown>): number {
    const t = this.TimeCurrent();
    this.toStruct(t, dt);
    return t;
  }

  TimeTradeServer(): number {
    return Math.floor(Date.now() / 1000) + this.host.serverOffset();
  }

  TimeTradeServerStruct(dt: Record<string, unknown>): number {
    const t = this.TimeTradeServer();
    this.toStruct(t, dt);
    return t;
  }

  TimeLocal(): number {
    return Math.floor(Date.now() / 1000) - new Date().getTimezoneOffset() * 60;
  }

  TimeLocalStruct(dt: Record<string, unknown>): number {
    const t = this.TimeLocal();
    this.toStruct(t, dt);
    return t;
  }

  TimeGMT(): number {
    return Math.floor(Date.now() / 1000);
  }

  TimeGMTStruct(dt: Record<string, unknown>): number {
    const t = this.TimeGMT();
    this.toStruct(t, dt);
    return t;
  }

  TimeGMTOffset(): number {
    return new Date().getTimezoneOffset() * 60;
  }

  TimeDaylightSavings(): number {
    return 0;
  }

  TimeToStruct(t: number, dt: Record<string, unknown>): boolean {
    this.toStruct(t, dt);
    return true;
  }

  StructToTime(dt: Record<string, unknown>): number {
    return Math.floor(
      Date.UTC(Number(dt.year) || 1970, (Number(dt.mon) || 1) - 1, Number(dt.day) || 1, Number(dt.hour) || 0, Number(dt.min) || 0, Number(dt.sec) || 0) / 1000,
    );
  }

  TimeToString(t: number, mode: number): string {
    return formatTime(t, mode);
  }

  StringToTime(value: string): number {
    const text = String(value).trim();
    const m = text.match(/^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})(?:[ T]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
    if (m) return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) / 1000;
    const hm = text.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
    if (hm) {
      const today = Math.floor(this.TimeCurrent() / 86400) * 86400;
      return today + +hm[1]! * 3600 + +hm[2]! * 60 + +(hm[3] ?? 0);
    }
    return 0;
  }

  /* ================================================================== */
  /* Conversion and strings                                              */
  /* ================================================================== */

  DoubleToString(value: number, digits: number): string {
    return doubleToString(value, digits);
  }

  IntegerToString(n: number, len: number, fill: number): string {
    const text = String(Math.trunc(n));
    return len > text.length ? text.padStart(len, String.fromCharCode(fill || 32)) : text;
  }

  StringToDouble(value: string): number {
    return strToDouble(value);
  }

  StringToInteger(value: string): number {
    return strToLong(value);
  }

  NormalizeDouble(value: number, digits: number): number {
    return normalizeDouble(value, digits);
  }

  CharToString(c: number): string {
    return String.fromCharCode(c & 0xff);
  }

  ShortToString(c: number): string {
    return String.fromCharCode(c & 0xffff);
  }

  ColorToString(c: number, useName: boolean): string {
    if (useName) {
      const named = COLOR_CONSTANTS.find(([, value]) => value === c);
      if (named) return named[0];
    }
    return formatColor(c);
  }

  StringToColor(text: string): number {
    const t = String(text).trim();
    const named = COLOR_CONSTANTS.find(([name]) => name.toLowerCase() === t.toLowerCase() || name.slice(3).toLowerCase() === t.toLowerCase());
    if (named) return named[1];
    const parts = t.split(',').map((p) => parseInt(p, 10));
    if (parts.length === 3 && parts.every((p) => Number.isFinite(p))) return (parts[2]! << 16) | (parts[1]! << 8) | parts[0]!;
    return 0;
  }

  StringToCharArray(text: string, arr: MqlArray<number>, start: number, count: number): number {
    const codes = [...String(text)].map((c) => c.charCodeAt(0) & 0xff);
    codes.push(0);
    const take = count < 0 ? codes.length : Math.min(count, codes.length);
    if (arr.dynamic && arr.a.length < start + take) arr.resize(start + take);
    for (let i = 0; i < take && start + i < arr.a.length; i += 1) arr.a[start + i] = codes[i]!;
    return take;
  }

  CharArrayToString(arr: MqlArray<number>, start: number, count: number): string {
    const end = count < 0 ? arr.a.length : Math.min(arr.a.length, start + count);
    let out = '';
    for (let i = start; i < end; i += 1) {
      const c = arr.a[i]!;
      if (c === 0) break;
      out += String.fromCharCode(c);
    }
    return out;
  }

  StringToShortArray(text: string, arr: MqlArray<number>, start: number, count: number): number {
    const codes = [...String(text)].map((c) => c.charCodeAt(0));
    codes.push(0);
    const take = count < 0 ? codes.length : Math.min(count, codes.length);
    if (arr.dynamic && arr.a.length < start + take) arr.resize(start + take);
    for (let i = 0; i < take && start + i < arr.a.length; i += 1) arr.a[start + i] = codes[i]!;
    return take;
  }

  ShortArrayToString(arr: MqlArray<number>, start: number, count: number): string {
    return this.CharArrayToString(arr, start, count);
  }

  StringLen(s: string): number {
    return String(s ?? '').length;
  }

  StringFind(s: string, match: string, start: number): number {
    return String(s).indexOf(String(match), Math.max(0, start));
  }

  StringSubstr(s: string, start: number, length: number): string {
    const text = String(s);
    if (start < 0 || start >= text.length) return '';
    return length < 0 ? text.slice(start) : text.substr(start, length);
  }

  StringReplace(str: Ref<string>, find: string, replacement: string): number {
    if (!find) return -1;
    const parts = String(str.v).split(find);
    str.v = parts.join(replacement);
    return parts.length - 1;
  }

  StringTrimLeft(str: Ref<string>): number {
    const before = String(str.v);
    str.v = before.replace(/^[\s]+/, '');
    return before.length - str.v.length;
  }

  StringTrimRight(str: Ref<string>): number {
    const before = String(str.v);
    str.v = before.replace(/[\s]+$/, '');
    return before.length - str.v.length;
  }

  StringToUpper(str: Ref<string>): boolean {
    str.v = String(str.v).toUpperCase();
    return true;
  }

  StringToLower(str: Ref<string>): boolean {
    str.v = String(str.v).toLowerCase();
    return true;
  }

  StringSplit(s: string, separator: number, result: MqlArray<string>): number {
    const parts = String(s).split(String.fromCharCode(separator));
    if (String(s) === '') {
      result.a = [];
      return 0;
    }
    result.a = parts;
    return parts.length;
  }

  StringCompare(a: string, b: string, caseSensitive: boolean): number {
    const x = caseSensitive ? String(a) : String(a).toLowerCase();
    const y = caseSensitive ? String(b) : String(b).toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }

  StringAdd(str: Ref<string>, add: string): boolean {
    str.v = String(str.v) + String(add);
    return true;
  }

  StringConcatenate(str: Ref<string>, ...args: Tagged[]): number {
    str.v = this.text(args);
    return str.v.length;
  }

  StringGetCharacter(s: string, pos: number): number {
    const text = String(s);
    return pos >= 0 && pos < text.length ? text.charCodeAt(pos) : 0;
  }

  StringSetCharacter(str: Ref<string>, pos: number, c: number): boolean {
    const text = String(str.v);
    if (pos < 0 || pos > text.length) return false;
    str.v = pos === text.length ? text + String.fromCharCode(c) : text.slice(0, pos) + String.fromCharCode(c) + text.slice(pos + 1);
    return true;
  }

  StringInit(str: Ref<string>, len: number, c: number): boolean {
    str.v = c ? String.fromCharCode(c).repeat(Math.max(0, len)) : '';
    return true;
  }

  StringFill(str: Ref<string>, c: number): number {
    str.v = String.fromCharCode(c).repeat(String(str.v).length);
    return str.v.length;
  }

  StringBufferLen(s: string): number {
    return String(s).length;
  }

  StringReserve(): boolean {
    return true;
  }

  /* ================================================================== */
  /* Math                                                                */
  /* ================================================================== */

  MathAbs(v: number): number {
    return Math.abs(v);
  }

  MathArccos(v: number): number {
    return Math.acos(v);
  }

  MathArcsin(v: number): number {
    return Math.asin(v);
  }

  MathArctan(v: number): number {
    return Math.atan(v);
  }

  MathArctan2(y: number, x: number): number {
    return Math.atan2(y, x);
  }

  MathCeil(v: number): number {
    return Math.ceil(v);
  }

  MathCos(v: number): number {
    return Math.cos(v);
  }

  MathCosh(v: number): number {
    return Math.cosh(v);
  }

  MathExp(v: number): number {
    return Math.exp(v);
  }

  MathExpm1(v: number): number {
    return Math.expm1(v);
  }

  MathFloor(v: number): number {
    return Math.floor(v);
  }

  MathLog(v: number): number {
    return Math.log(v);
  }

  MathLog10(v: number): number {
    return Math.log10(v);
  }

  MathLog1p(v: number): number {
    return Math.log1p(v);
  }

  MathMax(a: number, b: number): number {
    return a > b ? a : b;
  }

  MathMin(a: number, b: number): number {
    return a < b ? a : b;
  }

  MathMod(a: number, b: number): number {
    return a % b;
  }

  MathPow(a: number, b: number): number {
    return Math.pow(a, b);
  }

  MathRound(v: number): number {
    // MQL5 rounds half away from zero; Math.round rounds half up.
    return v < 0 ? -Math.round(-v) : Math.round(v);
  }

  MathSin(v: number): number {
    return Math.sin(v);
  }

  MathSinh(v: number): number {
    return Math.sinh(v);
  }

  MathSqrt(v: number): number {
    return Math.sqrt(v);
  }

  MathTan(v: number): number {
    return Math.tan(v);
  }

  MathTanh(v: number): number {
    return Math.tanh(v);
  }

  MathRand(): number {
    // The MSVC C runtime's generator, which is what MQL5's rand() is.
    this.randState = (Math.imul(this.randState, 214013) + 2531011) >>> 0;
    return (this.randState >>> 16) & 0x7fff;
  }

  MathSrand(seed: number): void {
    this.randState = seed >>> 0;
  }

  MathIsValidNumber(v: number): boolean {
    return Number.isFinite(v);
  }

  /* ================================================================== */
  /* Arrays                                                              */
  /* ================================================================== */

  ArrayResize(arr: MqlArray, size: number, reserve: number): number {
    if (!arr.dynamic) {
      this.err(ERR.INVALID_ARRAY);
      return -1;
    }
    return arr.resize(size, reserve);
  }

  ArraySize(arr: MqlArray): number {
    return arr.size();
  }

  ArrayRange(arr: MqlArray, dim: number): number {
    return dim === 0 ? arr.rows : arr.inner[dim - 1] ?? 0;
  }

  ArraySetAsSeries(arr: MqlArray, flag: boolean): boolean {
    if (arr.inner.length > 0) return false;
    arr.series = Boolean(flag);
    return true;
  }

  ArrayGetAsSeries(arr: MqlArray): boolean {
    return arr.series;
  }

  ArrayIsSeries(arr: MqlArray): boolean {
    return arr.series;
  }

  ArrayIsDynamic(arr: MqlArray): boolean {
    return arr.dynamic;
  }

  ArrayInitialize(arr: MqlArray, value: unknown): number {
    for (let i = 0; i < arr.a.length; i += 1) arr.a[i] = value;
    return arr.a.length;
  }

  ArrayFill(arr: MqlArray, start: number, count: number, value: unknown): void {
    for (let i = start; i < start + count; i += 1) {
      if (i >= arr.a.length) {
        if (!arr.dynamic) break;
        arr.resize(i + 1);
      }
      arr.a[arr.series ? arr.a.length - 1 - i : i] = value;
    }
  }

  ArrayCopy(dst: MqlArray, src: MqlArray, dstStart: number, srcStart: number, count: number): number {
    const available = src.a.length - srcStart;
    const n = count < 0 ? available : Math.min(count, available);
    if (n <= 0) return 0;
    if (dst.a.length < dstStart + n) {
      if (dst.dynamic) dst.resize(Math.ceil((dstStart + n) / dst.stride));
      else return -1;
    }
    const srcValues = src.series ? [...src.a].reverse() : src.a;
    const copied = srcValues.slice(srcStart, srcStart + n).map((v) => (typeof v === 'object' && v !== null && '$clone' in v ? (v as { $clone(): unknown }).$clone() : v));
    if (dst.series) {
      const len = dst.a.length;
      for (let i = 0; i < n; i += 1) dst.a[len - 1 - (dstStart + i)] = copied[i];
    } else {
      for (let i = 0; i < n; i += 1) dst.a[dstStart + i] = copied[i];
    }
    return n;
  }

  ArrayFree(arr: MqlArray): void {
    if (arr.dynamic) arr.a = [];
  }

  private logicalValues(arr: MqlArray): unknown[] {
    return arr.series ? [...arr.a].reverse() : arr.a;
  }

  ArrayMaximum(arr: MqlArray, start: number, count: number): number {
    const values = this.logicalValues(arr) as number[];
    const end = count < 0 ? values.length : Math.min(values.length, start + count);
    let best = -1;
    for (let i = start; i < end; i += 1) if (best < 0 || values[i]! > values[best]!) best = i;
    return best;
  }

  ArrayMinimum(arr: MqlArray, start: number, count: number): number {
    const values = this.logicalValues(arr) as number[];
    const end = count < 0 ? values.length : Math.min(values.length, start + count);
    let best = -1;
    for (let i = start; i < end; i += 1) if (best < 0 || values[i]! < values[best]!) best = i;
    return best;
  }

  ArraySort(arr: MqlArray): boolean {
    const cmp = (a: unknown, b: unknown): number => (typeof a === 'string' ? String(a).localeCompare(String(b)) : Number(a) - Number(b));
    arr.a.sort(cmp);
    if (arr.series) arr.a.reverse();
    return true;
  }

  ArrayBsearch(arr: MqlArray, value: unknown): number {
    const values = this.logicalValues(arr) as number[];
    let lo = 0;
    let hi = values.length - 1;
    let best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (values[mid] === value) return mid;
      if (values[mid]! < (value as number)) {
        lo = mid + 1;
        best = mid;
      } else hi = mid - 1;
    }
    return best;
  }

  ArrayReverse(arr: MqlArray, start: number, count: number): boolean {
    const values = this.logicalValues(arr);
    const end = count < 0 ? values.length : Math.min(values.length, start + count);
    const part = values.slice(start, end).reverse();
    const next = [...values.slice(0, start), ...part, ...values.slice(end)];
    arr.a = arr.series ? next.reverse() : next;
    return true;
  }

  ArrayInsert(dst: MqlArray, src: MqlArray, dstStart: number, srcStart: number, count: number): boolean {
    if (!dst.dynamic) return false;
    const values = this.logicalValues(src).slice(srcStart, count < 0 ? undefined : srcStart + count);
    const target = this.logicalValues(dst).slice();
    target.splice(dstStart, 0, ...values);
    dst.a = dst.series ? target.reverse() : target;
    return true;
  }

  ArrayRemove(arr: MqlArray, start: number, count: number): boolean {
    if (!arr.dynamic) return false;
    const values = this.logicalValues(arr).slice();
    values.splice(start, count < 0 ? values.length - start : count);
    arr.a = arr.series ? values.reverse() : values;
    return true;
  }

  ArraySwap(a: MqlArray, b: MqlArray): boolean {
    const tmp = a.a;
    a.a = b.a;
    b.a = tmp;
    return true;
  }

  ArrayCompare(a: MqlArray, b: MqlArray, s1: number, s2: number, count: number): number {
    const x = this.logicalValues(a);
    const y = this.logicalValues(b);
    const n = count < 0 ? Math.max(x.length - s1, y.length - s2) : count;
    for (let i = 0; i < n; i += 1) {
      const u = x[s1 + i];
      const v = y[s2 + i];
      if (u === undefined && v === undefined) return 0;
      if (u === undefined) return -1;
      if (v === undefined) return 1;
      if (u !== v) return (u as number) < (v as number) ? -1 : 1;
    }
    return 0;
  }

  ArrayPrint(arr: MqlArray, digits: number): void {
    const values = this.logicalValues(arr).map((v) => (typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(digits) : String(v)));
    this.host.log('info', values.join(' '));
  }

  /* ================================================================== */
  /* Chart objects                                                       */
  /* ================================================================== */

  private touchObjects(): void {
    this.objectsDirty = true;
  }

  /** Publishes chart objects to the host at most once per event. */
  flushObjects(): void {
    if (!this.objectsDirty) return;
    this.objectsDirty = false;
    this.host.objects?.([...this.objects.values()]);
  }

  ObjectCreate(_chart: number, name: string, type: number, _sub: number, time1: number, price1: number): boolean {
    if (this.objects.has(name)) return false;
    const obj: ChartObject = { name, type, integer: new Map(), double: new Map(), string: new Map() };
    obj.integer.set(10, time1);
    obj.double.set(0, price1);
    this.objects.set(name, obj);
    this.touchObjects();
    return true;
  }

  ObjectDelete(_chart: number, name: string): boolean {
    const ok = this.objects.delete(name);
    if (ok) this.touchObjects();
    return ok;
  }

  ObjectsDeleteAll(): number {
    const n = this.objects.size;
    this.objects.clear();
    this.touchObjects();
    return n;
  }

  ObjectsDeleteAllPrefix(_chart: number, prefix: string): number {
    let n = 0;
    for (const name of [...this.objects.keys()]) {
      if (name.startsWith(prefix)) {
        this.objects.delete(name);
        n += 1;
      }
    }
    if (n) this.touchObjects();
    return n;
  }

  ObjectFind(_chart: number, name: string): number {
    return this.objects.has(name) ? 0 : -1;
  }

  private object(name: string): ChartObject | null {
    const obj = this.objects.get(name);
    if (!obj) this.err(ERR.OBJECT_NOT_FOUND);
    return obj ?? null;
  }

  ObjectSetInteger(_chart: number, name: string, prop: number, value: number): boolean {
    const obj = this.object(name);
    if (!obj) return false;
    obj.integer.set(prop, value);
    this.touchObjects();
    return true;
  }

  ObjectSetIntegerMod(chart: number, name: string, prop: number, _mod: number, value: number): boolean {
    return this.ObjectSetInteger(chart, name, prop, value);
  }

  ObjectSetDouble(_chart: number, name: string, prop: number, value: number): boolean {
    const obj = this.object(name);
    if (!obj) return false;
    obj.double.set(prop, value);
    this.touchObjects();
    return true;
  }

  ObjectSetDoubleMod(chart: number, name: string, prop: number, _mod: number, value: number): boolean {
    return this.ObjectSetDouble(chart, name, prop, value);
  }

  ObjectSetString(_chart: number, name: string, prop: number, value: string): boolean {
    const obj = this.object(name);
    if (!obj) return false;
    obj.string.set(prop, value);
    this.touchObjects();
    return true;
  }

  ObjectSetStringMod(chart: number, name: string, prop: number, _mod: number, value: string): boolean {
    return this.ObjectSetString(chart, name, prop, value);
  }

  ObjectGetInteger(_chart: number, name: string, prop: number): number {
    const obj = this.object(name);
    if (!obj) return 0;
    if (E.objInt.get(prop) === 'OBJPROP_TYPE') return obj.type;
    return obj.integer.get(prop) ?? 0;
  }

  ObjectGetDouble(_chart: number, name: string, prop: number): number {
    return this.object(name)?.double.get(prop) ?? 0;
  }

  ObjectGetString(_chart: number, name: string, prop: number): string {
    const obj = this.object(name);
    if (!obj) return '';
    return prop === 0 ? obj.name : obj.string.get(prop) ?? '';
  }

  ObjectMove(_chart: number, name: string, _point: number, time: number, price: number): boolean {
    const obj = this.object(name);
    if (!obj) return false;
    obj.integer.set(10, time);
    obj.double.set(0, price);
    return true;
  }

  ObjectsTotal(): number {
    return this.objects.size;
  }

  ObjectName(_chart: number, pos: number): string {
    return [...this.objects.keys()][pos] ?? '';
  }

  ChartRedraw(): void {
    this.flushObjects();
  }

  ChartID(): number {
    return 1;
  }

  ChartSetInteger(_chart: number, prop: number, value: number): boolean {
    this.chartProps.set(prop, value);
    return true;
  }

  ChartSetIntegerSub(_chart: number, prop: number, _sub: number, value: number): boolean {
    this.chartProps.set(prop, value);
    return true;
  }

  ChartGetInteger(_chart: number, prop: number): number {
    return Number(this.chartProps.get(prop) ?? 0);
  }

  ChartSetDouble(): boolean {
    return true;
  }

  ChartGetDouble(): number {
    return 0;
  }

  ChartSetString(): boolean {
    return true;
  }

  ChartGetString(): string {
    return '';
  }

  ChartSymbol(): string {
    return this.host.symbol;
  }

  ChartPeriod(): number {
    return this.host.timeframe;
  }

  ChartSetSymbolPeriod(): boolean {
    return false;
  }

  ChartWindowFind(): number {
    return 0;
  }

  ChartIndicatorAdd(): boolean {
    return true;
  }

  /* ================================================================== */
  /* Global variables and files                                          */
  /* ================================================================== */

  private gvKey(name: string): string {
    return `gv:${name}`;
  }

  private readonly memoryStore = new Map<string, string>();

  private store() {
    const host = this.host.storage;
    if (host) return host;
    const mem = this.memoryStore;
    return {
      get: (k: string) => mem.get(k) ?? null,
      set: (k: string, v: string) => void mem.set(k, v),
      remove: (k: string) => void mem.delete(k),
      keys: (prefix: string) => [...mem.keys()].filter((k) => k.startsWith(prefix)),
    };
  }

  private gvRead(name: string): { value: number; time: number } | null {
    const raw = this.store().get(this.gvKey(name));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as { value: number; time: number };
    } catch {
      return null;
    }
  }

  GlobalVariableSet(name: string, value: number): number {
    const time = this.TimeCurrent();
    this.store().set(this.gvKey(name), JSON.stringify({ value, time }));
    return time;
  }

  GlobalVariableGet(name: string): number {
    const gv = this.gvRead(name);
    if (!gv) this.err(ERR.GLOBALVARIABLE_NOT_FOUND);
    return gv?.value ?? 0;
  }

  GlobalVariableGetRef(name: string, out: Ref<number>): boolean {
    const gv = this.gvRead(name);
    if (!gv) return false;
    out.v = gv.value;
    return true;
  }

  GlobalVariableCheck(name: string): boolean {
    return this.gvRead(name) !== null;
  }

  GlobalVariableDel(name: string): boolean {
    const exists = this.gvRead(name) !== null;
    this.store().remove(this.gvKey(name));
    return exists;
  }

  GlobalVariableTime(name: string): number {
    return this.gvRead(name)?.time ?? 0;
  }

  GlobalVariablesDeleteAll(prefix: string): number {
    const keys = this.store().keys(this.gvKey(prefix ?? ''));
    for (const k of keys) this.store().remove(k);
    return keys.length;
  }

  GlobalVariablesTotal(): number {
    return this.store().keys('gv:').length;
  }

  GlobalVariableName(index: number): string {
    return (this.store().keys('gv:')[index] ?? '').slice(3);
  }

  GlobalVariableTemp(name: string): boolean {
    if (!this.gvRead(name)) this.GlobalVariableSet(name, 0);
    return true;
  }

  GlobalVariableSetOnCondition(name: string, value: number, check: number): boolean {
    const gv = this.gvRead(name);
    if (!gv || gv.value !== check) return false;
    this.GlobalVariableSet(name, value);
    return true;
  }

  GlobalVariablesFlush(): void {
    /* writes are immediate */
  }

  private fileKey(name: string): string {
    return `file:${name.replace(/\\/g, '/')}`;
  }

  FileOpen(name: string, flags: number, delimiter: number): number {
    const key = this.fileKey(name);
    const existing = this.store().get(key);
    const write = (flags & 2) !== 0;
    const read = (flags & 1) !== 0;
    if (read && !write && existing === null) {
      this.err(ERR.FILE_NOT_EXIST);
      return -1;
    }
    const handle = this.nextFile++;
    this.files.set(handle, {
      name: key,
      flags,
      delimiter: String.fromCharCode(delimiter || 9),
      content: write && !read ? '' : existing ?? '',
      pos: 0,
    });
    return handle;
  }

  private file(handle: number): FileHandle | null {
    const f = this.files.get(handle);
    if (!f) this.err(ERR.FILE_CANNOT_OPEN);
    return f ?? null;
  }

  FileClose(handle: number): void {
    const f = this.files.get(handle);
    if (f && (f.flags & 2) !== 0) this.store().set(f.name, f.content);
    this.files.delete(handle);
  }

  FileFlush(handle: number): void {
    const f = this.files.get(handle);
    if (f && (f.flags & 2) !== 0) this.store().set(f.name, f.content);
  }

  FileWrite(handle: number, ...args: Tagged[]): number {
    const f = this.file(handle);
    if (!f) return 0;
    const csv = (f.flags & 8) !== 0;
    const line = args.map(([v, t]) => toStr(v, t)).join(csv ? f.delimiter : '') + '\r\n';
    f.content = f.content.slice(0, f.pos) + line;
    f.pos = f.content.length;
    return line.length;
  }

  FileWriteString(handle: number, text: string, length: number): number {
    const f = this.file(handle);
    if (!f) return 0;
    const chunk = length >= 0 ? String(text).slice(0, length) : String(text);
    f.content = f.content.slice(0, f.pos) + chunk;
    f.pos = f.content.length;
    return chunk.length;
  }

  FileReadString(handle: number, length: number): string {
    const f = this.file(handle);
    if (!f) return '';
    if (length > 0) {
      const out = f.content.substr(f.pos, length);
      f.pos += out.length;
      return out;
    }
    const csv = (f.flags & 8) !== 0;
    let end = f.pos;
    while (end < f.content.length) {
      const ch = f.content[end]!;
      if (ch === '\n' || ch === '\r' || (csv && ch === f.delimiter)) break;
      end += 1;
    }
    const out = f.content.slice(f.pos, end);
    f.pos = end;
    if (f.content[f.pos] === '\r') f.pos += 1;
    if (f.content[f.pos] === '\n' || (csv && f.content[f.pos] === f.delimiter)) f.pos += 1;
    return out;
  }

  FileReadNumber(handle: number): number {
    return strToDouble(this.FileReadString(handle, -1));
  }

  FileReadBool(handle: number): boolean {
    const v = this.FileReadString(handle, -1).trim().toLowerCase();
    return v === 'true' || (v !== '' && v !== 'false' && v !== '0');
  }

  FileReadDatetime(handle: number): number {
    return this.StringToTime(this.FileReadString(handle, -1));
  }

  FileIsEnding(handle: number): boolean {
    const f = this.file(handle);
    return !f || f.pos >= f.content.length;
  }

  FileIsLineEnding(handle: number): boolean {
    const f = this.file(handle);
    if (!f) return true;
    const ch = f.content[f.pos - 1];
    return ch === '\n' || f.pos >= f.content.length;
  }

  FileIsExist(name: string): boolean {
    return this.store().get(this.fileKey(name)) !== null;
  }

  FileDelete(name: string): boolean {
    const exists = this.FileIsExist(name);
    this.store().remove(this.fileKey(name));
    return exists;
  }

  FileSize(handle: number): number {
    return this.file(handle)?.content.length ?? 0;
  }

  FileTell(handle: number): number {
    return this.file(handle)?.pos ?? 0;
  }

  FileSeek(handle: number, offset: number, origin: number): boolean {
    const f = this.file(handle);
    if (!f) return false;
    const base = origin === 0 ? 0 : origin === 1 ? f.pos : f.content.length;
    f.pos = Math.max(0, Math.min(f.content.length, base + offset));
    return true;
  }

  /** Values the chart's comment and panel show, for the dashboard. */
  indicatorCount(): number {
    return this.indicators.size;
  }
}
