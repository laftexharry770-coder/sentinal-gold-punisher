/**
 * MQL5 lexer.
 *
 * Produces the token stream the preprocessor and parser work on. Two things
 * are kept that a C lexer would throw away, because MetaTrader itself uses
 * them:
 *
 * - The trailing `// comment` on a line. MT5 shows it as the display name of
 *   an `input` and as the label of an enum member in the Inputs dialog, so the
 *   generated settings form needs it to read the way the EA's author wrote it.
 * - Preprocessor lines, as whole `directive` tokens, so `#property`,
 *   `#include` and `#define` can be handled before parsing.
 */

export type TokenKind = 'ident' | 'number' | 'string' | 'char' | 'op' | 'directive' | 'eof';

export interface Token {
  kind: TokenKind;
  /** Source text for identifiers and operators; the decoded value for strings. */
  text: string;
  /** Numeric value for numbers, chars, datetime (seconds) and color literals. */
  value?: number;
  /** True for a number written with a decimal point or exponent. */
  float?: boolean;
  /** 'datetime' or 'color' for D'…' and C'…' literals. */
  literal?: 'datetime' | 'color';
  line: number;
  col: number;
  file: string;
  /** Tokens produced by a macro expansion remember the macro that made them. */
  macro?: string;
}

export class MqlSyntaxError extends Error {
  constructor(
    message: string,
    readonly file: string,
    readonly line: number,
    readonly col: number,
  ) {
    super(`${file}(${line},${col}): ${message}`);
    this.name = 'MqlSyntaxError';
  }
}

export interface LexResult {
  tokens: Token[];
  /** Trailing line comments, keyed by line number. */
  comments: Map<number, string>;
}

const OPERATORS = [
  '<<=', '>>=', '...',
  '::', '->', '++', '--', '&&', '||', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>',
  '+', '-', '*', '/', '%', '=', '<', '>', '!', '~', '&', '|', '^', '?', ':', ';', ',', '.', '(', ')', '[', ']', '{', '}', '#', '@',
];

const ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  '0': '\0',
  '\\': '\\',
  '"': '"',
  "'": "'",
  a: '\x07',
  b: '\b',
  f: '\f',
  v: '\v',
  '?': '?',
};

function isIdentStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c > '\x7f';
}

function isIdentPart(c: string): boolean {
  return isIdentStart(c) || (c >= '0' && c <= '9');
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

/**
 * Parses the body of a D'…' literal. MQL5 accepts `yyyy.mm.dd [hh:mi[:ss]]`,
 * `dd.mm.yyyy`, and a bare `hh:mi[:ss]` meaning that time today.
 */
export function parseDatetimeLiteral(body: string, now = Date.now()): number | null {
  const text = body.trim();
  let m = text.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:[ T]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (m) {
    return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) / 1000;
  }
  m = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (m) {
    return Date.UTC(+m[3]!, +m[2]! - 1, +m[1]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) / 1000;
  }
  m = text.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (m) {
    const day = Math.floor(now / 86_400_000) * 86_400;
    return day + +m[1]! * 3600 + +m[2]! * 60 + +(m[3] ?? 0);
  }
  if (text === '') return 0;
  return null;
}

/** Parses the body of a C'…' literal: `r,g,b` in decimal or hex. MQL5 colors are 0x00BBGGRR. */
export function parseColorLiteral(body: string): number | null {
  const parts = body.split(',').map((p) => p.trim());
  if (parts.length !== 3) return null;
  const values = parts.map((p) => (/^0x/i.test(p) ? parseInt(p, 16) : parseInt(p, 10)));
  if (values.some((v) => !Number.isFinite(v) || v < 0 || v > 255)) return null;
  const [r, g, b] = values as [number, number, number];
  return (b << 16) | (g << 8) | r;
}

export function lex(source: string, file = 'program.mq5'): LexResult {
  const tokens: Token[] = [];
  const comments = new Map<number, string>();
  let i = 0;
  let line = 1;
  let lineStart = 0;
  /** Whether anything other than whitespace has appeared on the current line. */
  let codeOnLine = false;
  const n = source.length;

  const fail = (message: string): never => {
    throw new MqlSyntaxError(message, file, line, i - lineStart + 1);
  };

  const push = (token: Omit<Token, 'file'>): void => {
    tokens.push({ ...token, file });
    codeOnLine = true;
  };

  while (i < n) {
    const c = source[i]!;

    if (c === '\n') {
      i += 1;
      line += 1;
      lineStart = i;
      codeOnLine = false;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === '﻿') {
      i += 1;
      continue;
    }

    // Comments.
    if (c === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      const text = source.slice(i + 2, end === -1 ? n : end).trim();
      if (codeOnLine && !comments.has(line)) comments.set(line, text);
      i = end === -1 ? n : end;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) fail('unterminated block comment');
      for (let k = i; k < end; k += 1) {
        if (source[k] === '\n') {
          line += 1;
          lineStart = k + 1;
        }
      }
      i = end + 2;
      continue;
    }

    const col = i - lineStart + 1;

    // Preprocessor directive: '#' as the first thing on a line runs to the end
    // of the logical line (backslash-newline continues it).
    if (c === '#' && !codeOnLine) {
      const startLine = line;
      let j = i + 1;
      let text = '';
      while (j < n) {
        const ch = source[j]!;
        if (ch === '\\' && (source[j + 1] === '\n' || (source[j + 1] === '\r' && source[j + 2] === '\n'))) {
          j += source[j + 1] === '\r' ? 3 : 2;
          line += 1;
          lineStart = j;
          text += ' ';
          continue;
        }
        if (ch === '\n') break;
        // A line comment ends the directive's meaningful text.
        if (ch === '/' && source[j + 1] === '/') {
          while (j < n && source[j] !== '\n') j += 1;
          break;
        }
        if (ch === '/' && source[j + 1] === '*') {
          const end = source.indexOf('*/', j + 2);
          if (end === -1) fail('unterminated block comment');
          for (let k = j; k < end; k += 1) {
            if (source[k] === '\n') {
              line += 1;
              lineStart = k + 1;
            }
          }
          j = end + 2;
          text += ' ';
          continue;
        }
        text += ch;
        j += 1;
      }
      tokens.push({ kind: 'directive', text: text.trim(), line: startLine, col, file });
      i = j;
      continue;
    }

    // Datetime and color literals: D'…' and C'…'.
    if ((c === 'D' || c === 'C') && source[i + 1] === "'") {
      const end = source.indexOf("'", i + 2);
      if (end === -1) fail(`unterminated ${c}'' literal`);
      const body = source.slice(i + 2, end);
      if (c === 'D') {
        const value = parseDatetimeLiteral(body);
        if (value === null) fail(`invalid datetime literal D'${body}'`);
        push({ kind: 'number', text: `D'${body}'`, value: value as number, literal: 'datetime', line, col });
      } else {
        const value = parseColorLiteral(body);
        if (value === null) fail(`invalid color literal C'${body}'`);
        push({ kind: 'number', text: `C'${body}'`, value: value as number, literal: 'color', line, col });
      }
      i = end + 1;
      continue;
    }

    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(source[j]!)) j += 1;
      push({ kind: 'ident', text: source.slice(i, j), line, col });
      i = j;
      continue;
    }

    if (isDigit(c) || (c === '.' && isDigit(source[i + 1] ?? ''))) {
      let j = i;
      let float = false;
      if (c === '0' && (source[i + 1] === 'x' || source[i + 1] === 'X')) {
        j = i + 2;
        while (j < n && /[0-9a-fA-F]/.test(source[j]!)) j += 1;
        const text = source.slice(i, j);
        push({ kind: 'number', text, value: parseInt(text.slice(2), 16), float: false, line, col });
        // MQL5 tolerates integer suffixes; skip them.
        while (j < n && /[uUlL]/.test(source[j]!)) j += 1;
        i = j;
        continue;
      }
      while (j < n && isDigit(source[j]!)) j += 1;
      if (source[j] === '.') {
        float = true;
        j += 1;
        while (j < n && isDigit(source[j]!)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        const save = j;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        if (isDigit(source[j] ?? '')) {
          float = true;
          while (j < n && isDigit(source[j]!)) j += 1;
        } else {
          j = save;
        }
      }
      const text = source.slice(i, j);
      push({ kind: 'number', text, value: Number(text), float, line, col });
      while (j < n && /[fFuUlL]/.test(source[j]!)) j += 1;
      i = j;
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      let value = '';
      while (j < n && source[j] !== '"') {
        const ch = source[j]!;
        if (ch === '\n') fail('newline inside a string literal');
        if (ch === '\\') {
          const next = source[j + 1] ?? '';
          if (next === 'x' || next === 'X') {
            const hex = source.slice(j + 2).match(/^[0-9a-fA-F]{1,4}/)?.[0] ?? '';
            value += String.fromCharCode(parseInt(hex || '0', 16));
            j += 2 + hex.length;
            continue;
          }
          if (next === 'u' || next === 'U') {
            const hex = source.slice(j + 2).match(/^[0-9a-fA-F]{1,4}/)?.[0] ?? '';
            value += String.fromCharCode(parseInt(hex || '0', 16));
            j += 2 + hex.length;
            continue;
          }
          if (next === '\n') {
            j += 2;
            line += 1;
            lineStart = j;
            continue;
          }
          value += ESCAPES[next] ?? next;
          j += 2;
          continue;
        }
        value += ch;
        j += 1;
      }
      if (j >= n) fail('unterminated string literal');
      push({ kind: 'string', text: value, line, col });
      i = j + 1;
      continue;
    }

    if (c === "'") {
      let j = i + 1;
      let ch = source[j] ?? '';
      let value: number;
      if (ch === '\\') {
        const next = source[j + 1] ?? '';
        if (next === 'x' || next === 'X' || next === 'u' || next === 'U') {
          const hex = source.slice(j + 2).match(/^[0-9a-fA-F]{1,4}/)?.[0] ?? '';
          value = parseInt(hex || '0', 16);
          j += 2 + hex.length;
        } else {
          value = (ESCAPES[next] ?? next).charCodeAt(0);
          j += 2;
        }
      } else {
        value = ch.charCodeAt(0);
        j += 1;
      }
      ch = source[j] ?? '';
      if (ch !== "'") fail('unterminated character literal');
      push({ kind: 'char', text: source.slice(i, j + 1), value, line, col });
      i = j + 1;
      continue;
    }

    const op = OPERATORS.find((candidate) => source.startsWith(candidate, i));
    if (op) {
      push({ kind: 'op', text: op, line, col });
      i += op.length;
      continue;
    }

    fail(`unexpected character '${c}'`);
  }

  tokens.push({ kind: 'eof', text: '', line, col: i - lineStart + 1, file });
  return { tokens, comments };
}
