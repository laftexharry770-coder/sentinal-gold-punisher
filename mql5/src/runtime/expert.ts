import { BUILTIN_ENUMS } from '../compiler/builtins.js';
import type { CompiledProgram } from '../compiler/index.js';
import type { ExpertHost, TradeRequest, TradeResult } from './host.js';
import { Natives, type RuntimeState } from './natives.js';
import {
  MqlArray,
  MqlRuntimeError,
  strToDouble,
  strToLong,
  toChar,
  toInt,
  toLong,
  toShort,
  toStr,
  toUchar,
  toUshort,
} from './values.js';

/**
 * A compiled expert, attached to a host — the web equivalent of dragging an
 * EA onto a chart.
 *
 * Events are processed one at a time in the order MetaTrader delivers them,
 * and a new tick that arrives while OnTick is still running is merged into a
 * single pending tick rather than queued, exactly as the terminal does. A
 * runtime error stops the expert with the line it happened on, the way
 * MetaTrader removes an EA after a critical error.
 */

export type ExpertStatus = 'idle' | 'running' | 'stopped' | 'failed';

export interface ExpertEvents {
  status?(status: ExpertStatus, detail: string | null): void;
}

type Handler = ((...args: unknown[]) => unknown) | null;

interface ProgramExports {
  init(inputs: Record<string, unknown>): void;
  deinitGlobals(): void;
  handlers: Record<string, Handler>;
  classes: Record<string, new () => Record<string, unknown> & { $c$v(): unknown; $reset(): unknown }>;
}

/** Base of every generated struct and class. */
class Obj {
  $c$v(): this {
    return this;
  }
  $assign(_other: unknown): this {
    return this;
  }
  $d(): void {
    /* no destructor */
  }
}

const BUILTIN_TABLES: Record<string, Record<number, string>> = Object.fromEntries(
  Object.entries(BUILTIN_ENUMS).map(([name, members]) => [name, Object.fromEntries(members.map(([m, v]) => [v, m]))]),
);

const INTEGER_TYPES = new Set(['int', 'uint', 'long', 'ulong', 'short', 'ushort', 'char', 'uchar', 'color']);

/** Turns a value from the settings form into the input's declared type. */
function coerceInput(value: unknown, typeName: string): unknown {
  if (typeName === 'bool') {
    if (typeof value === 'string') return value.toLowerCase() === 'true' || value === '1';
    return Boolean(value);
  }
  if (typeName === 'string') return value === null || value === undefined ? '' : String(value);
  if (typeName === 'double' || typeName === 'float') return typeof value === 'string' ? strToDouble(value) : Number(value) || 0;
  if (typeName === 'datetime') {
    if (typeof value === 'string' && /\D/.test(value)) {
      const m = value.match(/^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})(?:[ T]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
      if (m) return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) / 1000;
    }
    return Math.trunc(Number(value) || 0);
  }
  if (INTEGER_TYPES.has(typeName) || typeName.startsWith('ENUM_') || /^[A-Z]/.test(typeName) || typeName.startsWith('E')) {
    const n = typeof value === 'string' ? strToLong(value) : Math.trunc(Number(value) || 0);
    return typeName === 'int' ? n | 0 : n;
  }
  return value;
}

function bigint(v: number): bigint {
  return BigInt.asIntN(64, BigInt(Math.trunc(v)));
}

function fromBig(v: bigint): number {
  return Number(BigInt.asIntN(64, v));
}

interface TradeEvent {
  request: TradeRequest;
  result: TradeResult;
}

export class Expert {
  status: ExpertStatus = 'idle';
  error: string | null = null;
  private readonly natives: Natives;
  private readonly exports: ProgramExports;
  private readonly state: RuntimeState;
  private readonly ctx: Record<string, unknown>;
  private busy = false;
  private tickPending = false;
  private timerPending = false;
  private tradePending = false;
  private readonly transactions: TradeEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private idleWaiters: (() => void)[] = [];
  /** Duration of the last OnTick, milliseconds. */
  lastTickMs = 0;
  ticksProcessed = 0;

  constructor(
    readonly program: CompiledProgram,
    private readonly host: ExpertHost,
    private readonly events: ExpertEvents = {},
    private readonly opsLimit = 50_000_000,
  ) {
    const self = this;
    this.state = {
      lastError: 0,
      stopFlag: false,
      uninitReason: 0,
      expertName: program.name,
      startedAt: Date.now(),
      setTimer: (ms) => this.setTimer(ms),
      killTimer: () => this.killTimer(),
      tradeCompleted: (request, result) => this.onTradeCompleted(request, result),
      requestStop: () => {
        void this.stop(0);
      },
    };

    const ctx: Record<string, unknown> = {
      MqlArray,
      MqlRuntimeError,
      Obj,
      B: BUILTIN_TABLES,
      ops: 0,
      opsLimit,
      ln: 0,
      str: toStr,
      s2d: strToDouble,
      s2l: strToLong,
      s2time: (s: string) => this.natives.StringToTime(s),
      toInt,
      toShort,
      toUshort,
      toChar,
      toUchar,
      toLong,
      idiv(a: number, b: number): number {
        if (b === 0) throw new MqlRuntimeError('zero divide');
        return (a / b) | 0;
      },
      ldiv(a: number, b: number): number {
        if (b === 0) throw new MqlRuntimeError('zero divide');
        return Math.trunc(a / b);
      },
      imod(a: number, b: number): number {
        if (b === 0) throw new MqlRuntimeError('zero divide');
        return a % b;
      },
      land: (a: number, b: number) => fromBig(bigint(a) & bigint(b)),
      lor: (a: number, b: number) => fromBig(bigint(a) | bigint(b)),
      lxor: (a: number, b: number) => fromBig(bigint(a) ^ bigint(b)),
      lshl: (a: number, b: number) => fromBig(bigint(a) << BigInt(b)),
      lshr: (a: number, b: number) => fromBig(bigint(a) >> BigInt(b)),
      lnot: (a: number) => fromBig(~bigint(a)),
      del(p: { $dead?: boolean; $d(): void } | null): void {
        if (p && !p.$dead) {
          p.$d();
          p.$dead = true;
        }
      },
      dynCast(p: unknown, C: new () => unknown): unknown {
        if (p === null || p === undefined) return null;
        if (p instanceof C) return p;
        throw new MqlRuntimeError('incorrect casting of pointers');
      },
      checkPtr(p: { $dead?: boolean; $dyn?: boolean } | null): number {
        if (p === null || p === undefined || p.$dead) return 0;
        return p.$dyn ? 1 : 2;
      },
      enumStr(table: Record<number, string> | undefined, v: number): string {
        return table?.[v] ?? String(v);
      },
      arrInit(arr: MqlArray, values: unknown[]): MqlArray {
        if (arr.dynamic) arr.resize(values.length);
        for (let i = 0; i < values.length && i < arr.a.length; i += 1) arr.a[i] = values[i];
        return arr;
      },
      zeroArray(arr: MqlArray): void {
        for (let i = 0; i < arr.a.length; i += 1) arr.a[i] = arr.make();
      },
      input(inputs: Record<string, unknown>, name: string, typeName: string, fallback: () => unknown): unknown {
        if (inputs && Object.prototype.hasOwnProperty.call(inputs, name) && inputs[name] !== undefined) {
          return coerceInput(inputs[name], typeName);
        }
        return fallback();
      },
      dynCall(obj: Record<string, unknown> | null, name: string, args: unknown[]): unknown {
        if (!obj) throw new MqlRuntimeError('invalid pointer access');
        let proto = Object.getPrototypeOf(obj);
        while (proto) {
          for (const key of Object.getOwnPropertyNames(proto)) {
            if (key.startsWith(`m$${name}$`) && typeof obj[key] === 'function' && (obj[key] as (...a: unknown[]) => unknown).length === args.length) {
              return (obj[key] as (...a: unknown[]) => unknown).apply(obj, args);
            }
          }
          proto = Object.getPrototypeOf(proto);
        }
        throw new MqlRuntimeError(`method ${name} not found`);
      },
      tooLong(): never {
        throw new MqlRuntimeError('the EA kept running without returning (an endless loop?)');
      },
      get _Symbol() {
        return self.host.symbol;
      },
      get _Point() {
        return self.host.spec(self.host.symbol)?.point ?? 0;
      },
      get _Digits() {
        return self.host.spec(self.host.symbol)?.digits ?? 0;
      },
      get _Period() {
        return self.host.timeframe;
      },
      get _LastError() {
        return self.state.lastError;
      },
      set _LastError(v: number) {
        self.state.lastError = v;
      },
      get _StopFlag() {
        return self.state.stopFlag;
      },
      get _UninitReason() {
        return self.state.uninitReason;
      },
      get _RandomSeed() {
        return 0;
      },
    };
    this.ctx = ctx;

    // Natives build predefined structs through the program's own classes.
    let exportsRef: ProgramExports | null = null;
    this.natives = new Natives(host, this.state, (name) => {
      const C = exportsRef!.classes[name];
      if (!C) throw new MqlRuntimeError(`struct ${name} is not available`);
      return new C().$c$v() as Record<string, unknown> & { $reset(): unknown };
    });

    const natives = new Proxy(this.natives, {
      get(target, prop) {
        const value = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });

    // eslint-disable-next-line no-new-func
    const factory = new Function('$', 'N', program.js) as (ctx: unknown, natives: unknown) => ProgramExports;
    this.exports = factory(ctx, natives);
    exportsRef = this.exports;
  }

  private setStatus(status: ExpertStatus, detail: string | null = null): void {
    this.status = status;
    this.events.status?.(status, detail);
  }

  private describe(err: unknown, handler: string): string {
    const line = Number(this.ctx.ln) || 0;
    const where = line > 0 ? ` at line ${line}` : '';
    if (err instanceof MqlRuntimeError) return `critical error in ${handler}${where}: ${err.message}`;
    if (err instanceof TypeError && /null|undefined/.test(err.message)) {
      return `critical error in ${handler}${where}: invalid pointer access`;
    }
    return `critical error in ${handler}${where}: ${err instanceof Error ? err.message : String(err)}`;
  }

  /** Runs one handler. Returns false when the expert had to be stopped. */
  private async invoke(name: string, args: unknown[] = []): Promise<unknown> {
    const fn = this.exports.handlers[name];
    if (!fn) return undefined;
    this.ctx.ops = 0;
    try {
      const result = await fn(...args);
      this.natives.flushObjects();
      return result;
    } catch (err) {
      const message = this.describe(err, name);
      this.error = message;
      this.host.log('error', `${this.program.name}: ${message}. The expert was removed.`);
      // A critical error ends the program outright: MetaTrader does not call OnDeinit.
      await this.shutdown(1, false);
      this.setStatus('failed', message);
      throw err;
    }
  }

  /** Initialises globals with the given inputs and calls OnInit. */
  async start(inputs: Record<string, unknown> = {}): Promise<boolean> {
    if (this.status === 'running') return true;
    this.state.stopFlag = false;
    this.error = null;
    try {
      this.ctx.ops = 0;
      this.exports.init(inputs);
    } catch (err) {
      const message = this.describe(err, 'initialisation');
      this.error = message;
      this.setStatus('failed', message);
      this.host.log('error', `${this.program.name}: ${message}`);
      return false;
    }
    this.setStatus('running');
    this.busy = true;
    try {
      const code = await this.invoke('OnInit');
      if (typeof code === 'number' && code !== 0) {
        const reasons = ['succeeded', 'failed', 'rejected its input parameters', 'is not suitable for this agent'];
        const message = `OnInit ${reasons[code] ?? `returned ${code}`} (INIT code ${code})`;
        this.error = message;
        this.host.log('error', `${this.program.name}: ${message}. The expert was not started.`);
        // REASON_INITFAILED, as the terminal reports it.
        await this.shutdown(8, true);
        this.setStatus('failed', message);
        return false;
      }
    } catch {
      return false;
    } finally {
      this.busy = false;
    }
    this.host.log('info', `${this.program.name} started on ${this.host.symbol}`);
    void this.drain();
    return true;
  }

  /** NewTick: coalesced while a previous tick is still being processed. */
  tick(): void {
    if (this.status !== 'running') return;
    this.tickPending = true;
    void this.drain();
  }

  private onTradeCompleted(request: TradeRequest, result: TradeResult): void {
    if (this.status !== 'running') return;
    if (this.exports.handlers.OnTradeTransaction) this.transactions.push({ request, result });
    if (this.exports.handlers.OnTrade) this.tradePending = true;
    void this.drain();
  }

  /** Tells the expert the account changed outside its own requests (fills, stops, manual trades). */
  notifyTrade(): void {
    if (this.status !== 'running' || !this.exports.handlers.OnTrade) return;
    this.tradePending = true;
    void this.drain();
  }

  private setTimer(ms: number): void {
    this.killTimer();
    this.timer = setInterval(() => {
      if (this.status !== 'running') return;
      this.timerPending = true;
      void this.drain();
    }, ms);
  }

  private killTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private transaction(event: TradeEvent): unknown[] {
    const make = (name: string) => {
      const C = this.exports.classes[name]!;
      return new C().$c$v() as Record<string, unknown>;
    };
    const trans = make('MqlTradeTransaction');
    trans.type = 10; // TRADE_TRANSACTION_REQUEST
    trans.symbol = event.request.symbol;
    trans.order = event.result.order;
    trans.deal = event.result.deal;
    trans.order_type = event.request.type;
    trans.price = event.result.price;
    trans.volume = event.result.volume;
    trans.position = event.request.position;
    trans.price_sl = event.request.sl;
    trans.price_tp = event.request.tp;
    const request = make('MqlTradeRequest');
    Object.assign(request, {
      action: event.request.action,
      magic: event.request.magic,
      order: event.request.order,
      symbol: event.request.symbol,
      volume: event.request.volume,
      price: event.request.price,
      stoplimit: event.request.stoplimit,
      sl: event.request.sl,
      tp: event.request.tp,
      deviation: event.request.deviation,
      type: event.request.type,
      type_filling: event.request.typeFilling,
      type_time: event.request.typeTime,
      expiration: event.request.expiration,
      comment: event.request.comment,
      position: event.request.position,
      position_by: event.request.positionBy,
    });
    const result = make('MqlTradeResult');
    Object.assign(result, {
      retcode: event.result.retcode,
      deal: event.result.deal,
      order: event.result.order,
      volume: event.result.volume,
      price: event.result.price,
      bid: event.result.bid,
      ask: event.result.ask,
      comment: event.result.comment,
      request_id: event.result.requestId,
      retcode_external: event.result.retcodeExternal,
    });
    return [trans, request, result];
  }

  /** Processes pending events one at a time: trade events, then timer, then the latest tick. */
  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.status === 'running') {
        const trans = this.transactions.shift();
        if (trans) {
          await this.invoke('OnTradeTransaction', this.transaction(trans));
          continue;
        }
        if (this.tradePending) {
          this.tradePending = false;
          await this.invoke('OnTrade');
          continue;
        }
        if (this.timerPending) {
          this.timerPending = false;
          await this.invoke('OnTimer');
          continue;
        }
        if (this.tickPending) {
          this.tickPending = false;
          const perf = (globalThis as { performance?: { now(): number } }).performance;
          const t0 = perf ? perf.now() : Date.now();
          await this.invoke('OnTick');
          this.lastTickMs = (perf ? perf.now() : Date.now()) - t0;
          this.ticksProcessed += 1;
          continue;
        }
        break;
      }
    } catch {
      /* invoke() already stopped the expert and reported why */
    } finally {
      this.busy = false;
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  /** Resolves once no event is being processed. */
  idle(): Promise<void> {
    if (!this.busy) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private async shutdown(reason: number, callDeinit: boolean): Promise<void> {
    this.state.stopFlag = true;
    this.state.uninitReason = reason;
    this.killTimer();
    this.tickPending = false;
    this.timerPending = false;
    this.tradePending = false;
    this.transactions.length = 0;
    if (callDeinit && this.exports.handlers.OnDeinit) {
      try {
        this.ctx.ops = 0;
        await this.exports.handlers.OnDeinit(reason);
        this.natives.flushObjects();
      } catch (err) {
        this.host.log('error', `${this.program.name}: ${this.describe(err, 'OnDeinit')}`);
      }
    }
    try {
      this.exports.deinitGlobals();
    } catch {
      /* destructors that fail on the way out change nothing */
    }
  }

  /** Detaches the expert: OnDeinit with the given reason (REASON_REMOVE by default). */
  async stop(reason = 1): Promise<void> {
    if (this.status !== 'running') return;
    this.setStatus('stopped');
    await this.idle();
    await this.shutdown(reason, true);
    this.host.log('info', `${this.program.name} removed`);
  }
}
