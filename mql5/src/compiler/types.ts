/**
 * Static types, as the code generator sees them.
 *
 * MQL5's arithmetic depends on types JavaScript does not have: 7 / 2 is 3 for
 * integers and 3.5 for doubles, an int wraps at 2^31, and assigning 2.9 to an
 * int stores 2. The generator tracks the type of every expression so it can
 * emit exactly those rules, and nothing extra where a value is already right.
 */

export type Prim =
  | 'void' | 'bool' | 'char' | 'uchar' | 'short' | 'ushort' | 'int' | 'uint' | 'long' | 'ulong'
  | 'float' | 'double' | 'string' | 'datetime' | 'color';

export type Type =
  | { k: 'prim'; n: Prim }
  | { k: 'enum'; n: string }
  | { k: 'obj'; n: string; ptr: boolean }
  | { k: 'arr'; of: Type; dims: number }
  | { k: 'null' }
  | { k: 'any' };

export const T = {
  void: { k: 'prim', n: 'void' } as Type,
  bool: { k: 'prim', n: 'bool' } as Type,
  int: { k: 'prim', n: 'int' } as Type,
  uint: { k: 'prim', n: 'uint' } as Type,
  long: { k: 'prim', n: 'long' } as Type,
  ulong: { k: 'prim', n: 'ulong' } as Type,
  double: { k: 'prim', n: 'double' } as Type,
  string: { k: 'prim', n: 'string' } as Type,
  datetime: { k: 'prim', n: 'datetime' } as Type,
  color: { k: 'prim', n: 'color' } as Type,
  ushort: { k: 'prim', n: 'ushort' } as Type,
  null: { k: 'null' } as Type,
  any: { k: 'any' } as Type,
};

export function prim(n: Prim): Type {
  return { k: 'prim', n };
}

const INTEGRAL = new Set<Prim>(['bool', 'char', 'uchar', 'short', 'ushort', 'int', 'uint', 'long', 'ulong', 'datetime', 'color']);

export function isPrim(t: Type, n?: Prim): boolean {
  return t.k === 'prim' && (n === undefined || t.n === n);
}

export function isString(t: Type): boolean {
  return t.k === 'prim' && t.n === 'string';
}

export function isFloat(t: Type): boolean {
  return t.k === 'prim' && (t.n === 'double' || t.n === 'float');
}

export function isIntegral(t: Type): boolean {
  return t.k === 'enum' || (t.k === 'prim' && INTEGRAL.has(t.n));
}

export function isNumeric(t: Type): boolean {
  return isIntegral(t) || isFloat(t);
}

export function is64(t: Type): boolean {
  return t.k === 'prim' && (t.n === 'long' || t.n === 'ulong' || t.n === 'datetime');
}

export function isObj(t: Type): t is { k: 'obj'; n: string; ptr: boolean } {
  return t.k === 'obj';
}

export function isArr(t: Type): t is { k: 'arr'; of: Type; dims: number } {
  return t.k === 'arr';
}

/** Width rank used both for promotion and for overload scoring. */
export function rank(t: Type): number {
  if (t.k === 'enum') return 3;
  if (t.k !== 'prim') return -1;
  switch (t.n) {
    case 'bool':
      return 0;
    case 'char':
    case 'uchar':
      return 1;
    case 'short':
    case 'ushort':
      return 2;
    case 'int':
    case 'uint':
    case 'color':
      return 3;
    case 'long':
    case 'ulong':
    case 'datetime':
      return 4;
    case 'float':
      return 5;
    case 'double':
      return 6;
    default:
      return -1;
  }
}

export function sameType(a: Type, b: Type): boolean {
  if (a.k !== b.k) return false;
  switch (a.k) {
    case 'prim':
      return a.n === (b as typeof a).n;
    case 'enum':
      return a.n === (b as typeof a).n;
    case 'obj':
      return a.n === (b as typeof a).n;
    case 'arr':
      return sameType(a.of, (b as typeof a).of) && a.dims === (b as typeof a).dims;
    default:
      return true;
  }
}

export function typeName(t: Type): string {
  switch (t.k) {
    case 'prim':
      return t.n;
    case 'enum':
      return t.n;
    case 'obj':
      return t.ptr ? `${t.n}*` : t.n;
    case 'arr':
      return `${typeName(t.of)}${'[]'.repeat(t.dims)}`;
    case 'null':
      return 'NULL';
    default:
      return 'any';
  }
}

/** The tag runtime formatting uses to turn a value of this type into text. */
export function strTag(t: Type): string {
  if (t.k === 'prim') {
    switch (t.n) {
      case 'double':
      case 'float':
      case 'datetime':
      case 'bool':
      case 'color':
      case 'string':
        return t.n;
    }
  }
  return 'int';
}

/** Result type of arithmetic between two numeric operands. */
export function promote(a: Type, b: Type): Type {
  if (isFloat(a) || isFloat(b)) return T.double;
  if (isPrim(a, 'datetime') || isPrim(b, 'datetime')) return T.datetime;
  if (is64(a) || is64(b)) return isPrim(a, 'ulong') || isPrim(b, 'ulong') ? T.ulong : T.long;
  if (isPrim(a, 'uint') || isPrim(b, 'uint')) return T.uint;
  return T.int;
}

/** Default value of a scalar, as JavaScript source. */
export function scalarDefault(t: Type): string {
  if (t.k === 'prim') {
    if (t.n === 'string') return '""';
    if (t.n === 'bool') return 'false';
    return '0';
  }
  if (t.k === 'enum') return '0';
  return 'null';
}

/**
 * JavaScript for converting `code` of type `from` into type `to`, under
 * MQL5's implicit conversion rules. Returns `code` untouched when nothing
 * needs to change.
 */
export function convertCode(code: string, from: Type, to: Type): string {
  if (to.k === 'any' || from.k === 'any') return code;
  if (to.k === 'prim' && to.n === 'void') return code;
  if (from.k === 'null') {
    if (to.k === 'prim') return to.n === 'string' ? '""' : to.n === 'bool' ? 'false' : '0';
    if (to.k === 'enum') return '0';
    return 'null';
  }
  if (sameType(from, to)) return code;

  if (to.k === 'enum') {
    if (from.k === 'enum') return code;
    if (isFloat(from)) return `((${code})|0)`;
    if (isPrim(from, 'bool')) return `(+(${code}))`;
    if (isString(from)) return `$.toInt($.s2l(${code}))`;
    return code;
  }

  if (to.k !== 'prim') return code;

  switch (to.n) {
    case 'string':
      return `$.str(${code},${JSON.stringify(strTag(from))})`;
    case 'bool':
      if (isString(from)) return `((${code})!=="")`;
      return `!!(${code})`;
    case 'double':
      if (isString(from)) return `$.s2d(${code})`;
      if (isPrim(from, 'bool')) return `(+(${code}))`;
      return code;
    case 'float':
      if (isString(from)) return `Math.fround($.s2d(${code}))`;
      return `Math.fround(${code})`;
    case 'int':
      if (isString(from)) return `($.s2l(${code})|0)`;
      if (isPrim(from, 'bool')) return `(+(${code}))`;
      if (from.k === 'enum' || (from.k === 'prim' && ['char', 'uchar', 'short', 'ushort'].includes(from.n))) return code;
      return `((${code})|0)`;
    case 'uint':
      if (isString(from)) return `($.s2l(${code})>>>0)`;
      if (from.k === 'prim' && ['bool', 'uchar', 'ushort'].includes(from.n)) return `(+(${code}))`;
      return `((${code})>>>0)`;
    case 'color':
      if (isString(from)) return `$.s2l(${code})`;
      if (isFloat(from)) return `((${code})|0)`;
      if (isPrim(from, 'bool')) return `(+(${code}))`;
      return code;
    case 'short':
      if (isString(from)) return `$.toShort($.s2l(${code}))`;
      if (from.k === 'prim' && ['char', 'uchar', 'bool'].includes(from.n)) return `(+(${code}))`;
      return `$.toShort(${code})`;
    case 'ushort':
      if (isString(from)) return `$.toUshort($.s2l(${code}))`;
      if (from.k === 'prim' && ['uchar', 'bool'].includes(from.n)) return `(+(${code}))`;
      return `$.toUshort(${code})`;
    case 'char':
      if (isString(from)) return `$.toChar($.s2l(${code}))`;
      if (isPrim(from, 'bool')) return `(+(${code}))`;
      return `$.toChar(${code})`;
    case 'uchar':
      if (isString(from)) return `$.toUchar($.s2l(${code}))`;
      if (isPrim(from, 'bool')) return `(+(${code}))`;
      return `$.toUchar(${code})`;
    case 'long':
    case 'ulong':
    case 'datetime':
      if (isString(from)) return to.n === 'datetime' ? `$.s2time(${code})` : `$.s2l(${code})`;
      if (isFloat(from)) return `$.toLong(${code})`;
      if (isPrim(from, 'bool')) return `(+(${code}))`;
      return code;
    default:
      return code;
  }
}
