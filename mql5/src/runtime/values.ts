/**
 * Runtime representation of MQL5 values.
 *
 * Numbers are JavaScript numbers (MQL5 integers up to 2^53 fit exactly, which
 * covers tickets, magic numbers and datetimes), strings are strings, and
 * structs and classes are instances of generated classes. Arrays need their
 * own type because MQL5 arrays carry state JavaScript arrays do not: a series
 * flag that reverses indexing, fixed versus dynamic size, and bounds checking
 * that ends the program rather than returning undefined.
 */

/** A runtime error MQL5 treats as fatal: the EA is stopped, as MetaTrader would stop it. */
export class MqlRuntimeError extends Error {
  constructor(
    message: string,
    readonly file = '',
    readonly line = 0,
  ) {
    super(message);
    this.name = 'MqlRuntimeError';
  }
}

export class MqlArray<T = unknown> {
  /** Backing store, always in chronological (non-series) order. */
  a: T[];
  series = false;
  /** Sizes of the dimensions after the first, for multi-dimensional arrays. */
  readonly inner: number[];
  readonly stride: number;

  constructor(
    readonly make: () => T,
    readonly dynamic: boolean,
    size = 0,
    inner: number[] = [],
  ) {
    this.inner = inner;
    this.stride = inner.reduce((product, n) => product * n, 1);
    this.a = [];
    if (size > 0) this.resize(size);
  }

  /** Elements along the first dimension. */
  get rows(): number {
    return this.stride === 1 ? this.a.length : Math.floor(this.a.length / this.stride);
  }

  size(): number {
    return this.a.length;
  }

  resize(rows: number, _reserve = 0): number {
    if (!Number.isFinite(rows) || rows < 0) return -1;
    const target = Math.floor(rows) * this.stride;
    const current = this.a.length;
    if (target < current) {
      this.a.length = target;
    } else {
      for (let i = current; i < target; i += 1) this.a.push(this.make());
    }
    return this.rows;
  }

  private fail(index: number): never {
    throw new MqlRuntimeError(`array out of range (index ${index}, size ${this.rows})`);
  }

  private at(i: number): number {
    const n = this.a.length;
    if (i < 0 || i >= n || i !== Math.floor(i)) this.fail(i);
    return this.series ? n - 1 - i : i;
  }

  get(i: number): T {
    return this.a[this.at(i)]!;
  }

  set(i: number, value: T): T {
    this.a[this.at(i)] = value;
    return value;
  }

  private offset(indices: number[]): number {
    const rows = this.rows;
    const first = indices[0]!;
    if (first < 0 || first >= rows) this.fail(first);
    let offset = (this.series ? rows - 1 - first : first) * this.stride;
    let span = this.stride;
    for (let d = 0; d < this.inner.length; d += 1) {
      const size = this.inner[d]!;
      const index = indices[d + 1] ?? 0;
      if (index < 0 || index >= size) throw new MqlRuntimeError(`array out of range (index ${index}, size ${size})`);
      span /= size;
      offset += index * span;
    }
    return offset;
  }

  getN(...indices: number[]): T {
    return this.a[this.offset(indices)]!;
  }

  setN(value: T, ...indices: number[]): T {
    this.a[this.offset(indices)] = value;
    return value;
  }

  /** Series-order values as a plain array (index 0 is the newest when series). */
  toArray(): T[] {
    return this.series ? [...this.a].reverse() : [...this.a];
  }

  clone(): MqlArray<T> {
    const copy = new MqlArray<T>(this.make, this.dynamic, 0, this.inner);
    copy.a = this.a.map((value) => cloneValue(value));
    copy.series = this.series;
    return copy;
  }
}

/** Anything with the generated struct protocol. */
export interface MqlObject {
  $clone(): MqlObject;
  $assign(other: MqlObject): MqlObject;
}

function isObject(value: unknown): value is MqlObject {
  return typeof value === 'object' && value !== null && typeof (value as MqlObject).$clone === 'function';
}

export function cloneValue<T>(value: T): T {
  if (value instanceof MqlArray) return value.clone() as T;
  if (isObject(value)) return value.$clone() as T;
  return value;
}

/** A reference to a scalar l-value, passed for `double &x` parameters. */
export interface Ref<T = unknown> {
  v: T;
}

/* ------------------------------------------------------------------ */
/* Conversions                                                         */
/* ------------------------------------------------------------------ */

export function toInt(v: number | boolean): number {
  return (v as number) | 0;
}

export function toUint(v: number | boolean): number {
  return (v as number) >>> 0;
}

export function toShort(v: number | boolean): number {
  return ((v as number) << 16) >> 16;
}

export function toUshort(v: number | boolean): number {
  return (v as number) & 0xffff;
}

export function toChar(v: number | boolean): number {
  return ((v as number) << 24) >> 24;
}

export function toUchar(v: number | boolean): number {
  return (v as number) & 0xff;
}

export function toLong(v: number | boolean): number {
  const n = Math.trunc(v as number);
  return Number.isFinite(n) ? n : 0;
}

export function toDouble(v: number | boolean): number {
  return +v;
}

export function toFloat(v: number | boolean): number {
  return Math.fround(+v);
}

export function strToDouble(s: string): number {
  const match = String(s).trim().match(/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/);
  return match ? Number(match[0]) : 0;
}

export function strToLong(s: string): number {
  const text = String(s).trim();
  if (/^[+-]?0x[0-9a-f]+/i.test(text)) return parseInt(text, 16);
  const match = text.match(/^[+-]?\d+/);
  return match ? Number(match[0]) : 0;
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** TimeToString with MQL5's flags: TIME_DATE=1, TIME_MINUTES=2, TIME_SECONDS=4. */
export function formatTime(seconds: number, flags = 1 | 2): string {
  const d = new Date(Math.trunc(seconds) * 1000);
  const date = `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`;
  const parts: string[] = [];
  if (flags & 1) parts.push(date);
  if (flags & 4) parts.push(`${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`);
  else if (flags & 2) parts.push(`${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`);
  return parts.join(' ');
}

/** The way MQL5 turns a double into text when nothing says how: shortest exact form. */
export function formatDouble(v: number): string {
  if (Number.isNaN(v)) return '-nan(ind)';
  if (v === Infinity) return 'inf';
  if (v === -Infinity) return '-inf';
  if (Number.isInteger(v) && Math.abs(v) < 1e16) return `${v}.0`;
  const text = String(Number(v.toPrecision(16)));
  return text.includes('e') ? v.toExponential(16).replace(/\.?0+e/, 'e') : text;
}

export function formatColor(v: number): string {
  if (v === -1 || v === 0xffffffff) return 'clrNONE';
  const r = v & 0xff;
  const g = (v >> 8) & 0xff;
  const b = (v >> 16) & 0xff;
  return `${r},${g},${b}`;
}

/** Value → string for concatenation and Print, according to its static type. */
export function toStr(value: unknown, tag: string): string {
  switch (tag) {
    case 'double':
    case 'float':
      return formatDouble(value as number);
    case 'datetime':
      return formatTime(value as number, 1 | 4);
    case 'bool':
      return value ? 'true' : 'false';
    case 'color':
      return formatColor(value as number);
    case 'string':
      return value as string;
    default:
      if (value === null || value === undefined) return '';
      return String(value);
  }
}

function formatInteger(value: number, spec: string, flags: string, width: number, precision: number | null): string {
  let n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) n = 0;
  let body: string;
  switch (spec) {
    case 'x':
      body = (n < 0 ? n >>> 0 : n).toString(16);
      break;
    case 'X':
      body = (n < 0 ? n >>> 0 : n).toString(16).toUpperCase();
      break;
    case 'o':
      body = (n < 0 ? n >>> 0 : n).toString(8);
      break;
    case 'u':
      body = String(n < 0 ? n >>> 0 : n);
      break;
    case 'c':
      return String.fromCharCode(n);
    default:
      body = String(Math.abs(n));
  }
  if (precision !== null) body = body.padStart(precision, '0');
  const sign = spec === 'd' || spec === 'i' ? (n < 0 ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '') : '';
  if (flags.includes('#') && (spec === 'x' || spec === 'X') && n !== 0) body = `0${spec}${body}`;
  return pad2(sign, body, flags, width);
}

function pad2(sign: string, body: string, flags: string, width: number): string {
  const text = sign + body;
  if (text.length >= width) return text;
  if (flags.includes('-')) return text.padEnd(width, ' ');
  if (flags.includes('0')) return sign + body.padStart(width - sign.length, '0');
  return text.padStart(width, ' ');
}

/**
 * printf-style formatting as MQL5's PrintFormat / StringFormat do it,
 * including the `I64` length prefix and `*` widths.
 */
export function formatPrintf(format: string, args: unknown[]): string {
  let argIndex = 0;
  const nextArg = (): unknown => args[argIndex++];
  return String(format).replace(
    /%([-+ 0#]*)(\*|\d+)?(?:\.(\*|\d+))?(I64|I32|hh|h|ll|l|L|q|j|z|t)?([diouxXeEfFgGsc%])/g,
    (_all, flags: string, widthText: string | undefined, precisionText: string | undefined, _len, spec: string) => {
      if (spec === '%') return '%';
      const width = widthText === '*' ? Number(nextArg()) : widthText ? Number(widthText) : 0;
      const precision = precisionText === '*' ? Number(nextArg()) : precisionText !== undefined ? Number(precisionText) : null;
      const value = nextArg();
      switch (spec) {
        case 'd':
        case 'i':
        case 'u':
        case 'x':
        case 'X':
        case 'o':
        case 'c':
          return formatInteger(Number(value), spec, flags, width, precision);
        case 'f':
        case 'F': {
          const n = Number(value);
          const body = Math.abs(n).toFixed(precision ?? 6);
          const sign = n < 0 || Object.is(n, -0) ? (Number(body) === 0 ? '' : '-') : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '';
          return pad2(sign, body, flags, width);
        }
        case 'e':
        case 'E': {
          const n = Number(value);
          let body = Math.abs(n).toExponential(precision ?? 6);
          body = body.replace(/e([+-])(\d)$/, 'e$10$2');
          if (spec === 'E') body = body.toUpperCase();
          const sign = n < 0 ? '-' : flags.includes('+') ? '+' : '';
          return pad2(sign, body, flags, width);
        }
        case 'g':
        case 'G': {
          const n = Number(value);
          const p = precision === null ? 6 : Math.max(1, precision);
          let body = Math.abs(n).toPrecision(p);
          if (!flags.includes('#') && body.includes('.') && !body.includes('e')) body = body.replace(/\.?0+$/, '');
          if (spec === 'G') body = body.toUpperCase();
          const sign = n < 0 ? '-' : flags.includes('+') ? '+' : '';
          return pad2(sign, body, flags, width);
        }
        case 's': {
          let text = typeof value === 'number' ? (Number.isInteger(value) ? String(value) : formatDouble(value)) : typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value ?? '');
          if (precision !== null) text = text.slice(0, precision);
          return flags.includes('-') ? text.padEnd(width, ' ') : text.padStart(width, ' ');
        }
        default:
          return '';
      }
    },
  );
}

/** DoubleToString(value, digits): fixed notation, or scientific for negative digits. */
export function doubleToString(value: number, digits = 8): string {
  if (!Number.isFinite(value)) return formatDouble(value);
  if (digits < 0) return value.toExponential(Math.min(16, -digits)).replace(/e([+-])(\d)$/, 'e$10$2');
  return value.toFixed(Math.min(16, Math.max(0, Math.trunc(digits))));
}

/**
 * NormalizeDouble rounds half away from zero at the given precision, and
 * corrects binary noise first so 1.005 rounds the way it reads.
 */
export function normalizeDouble(value: number, digits: number): number {
  if (!Number.isFinite(value)) return value;
  const d = Math.min(8, Math.max(0, Math.trunc(digits)));
  const sign = value < 0 ? -1 : 1;
  const text = String(Math.abs(value));
  // Shifting through the decimal text rounds 1.005 to 1.01 as written, where
  // multiplying by 100 would see 100.49999999999999 and round down.
  if (!text.includes('e')) {
    const rounded = Math.round(Number(`${text}e${d}`));
    return sign * Number(`${rounded}e-${d}`);
  }
  const factor = 10 ** d;
  return (sign * Math.round(Math.abs(value) * factor)) / factor;
}
