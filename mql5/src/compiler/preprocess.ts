import { lex, MqlSyntaxError, type Token } from './lexer.js';

/**
 * MQL5 preprocessor.
 *
 * Works on tokens rather than text, so macro expansion cannot split a string
 * or glue two identifiers together by accident. Handles what EAs actually use:
 * `#include` (the built-in standard library plus any .mqh files uploaded with
 * the EA), object-like and function-like `#define`, `#undef`,
 * `#ifdef`/`#ifndef`/`#else`/`#endif`, and `#property`. `#import` is refused
 * with a reason, because it loads a DLL or a compiled .ex5 that cannot run
 * outside MetaTrader.
 */

export interface SourceFile {
  name: string;
  source: string;
}

export interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  message: string;
  file: string;
  line: number;
}

export interface PreprocessResult {
  tokens: Token[];
  properties: Map<string, string[]>;
  /** Trailing comments by file, then by line. */
  comments: Map<string, Map<number, string>>;
  diagnostics: Diagnostic[];
  /** Standard-library headers pulled in, normalised (e.g. `trade/trade.mqh`). */
  includes: string[];
}

interface Macro {
  params: string[] | null;
  variadic: boolean;
  body: Token[];
}

export interface PreprocessOptions {
  /** Headers bundled with the compiler, keyed by normalised path. */
  stdlib: Map<string, string>;
  /** Extra files uploaded alongside the program (its own .mqh headers). */
  files?: SourceFile[];
  /** Sources processed ahead of the entry file, as if included first. */
  preludes?: SourceFile[];
  build?: number;
}

export function normaliseIncludePath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/^(mql5\/)?include\//i, '').toLowerCase();
}

function baseName(path: string): string {
  const parts = normaliseIncludePath(path).split('/');
  return parts[parts.length - 1] ?? path;
}

export function preprocess(entry: SourceFile, options: PreprocessOptions): PreprocessResult {
  const macros = new Map<string, Macro>();
  const properties = new Map<string, string[]>();
  const comments = new Map<string, Map<number, string>>();
  const diagnostics: Diagnostic[] = [];
  const includes: string[] = [];
  const included = new Set<string>();
  const output: Token[] = [];

  const userFiles = new Map<string, SourceFile>();
  for (const file of options.files ?? []) {
    userFiles.set(normaliseIncludePath(file.name), file);
    // Uploaded headers are usually referenced by bare name, whatever folder
    // they lived in on the author's machine.
    if (!userFiles.has(baseName(file.name))) userFiles.set(baseName(file.name), file);
  }

  const define = (name: string, value = '1'): void => {
    macros.set(name, {
      params: null,
      variadic: false,
      body: [{ kind: 'number', text: value, value: Number(value), float: false, line: 0, col: 0, file: '<builtin>' }],
    });
  };
  define('__MQL5__');
  define('__MQL__');
  define('__MQLBUILD__', String(options.build ?? 4000));
  define('__MQL5_BUILD__', String(options.build ?? 4000));

  const warn = (token: Token, message: string): void => {
    diagnostics.push({ severity: 'warning', message, file: token.file, line: token.line });
  };
  const fail = (token: Token, message: string): never => {
    throw new MqlSyntaxError(message, token.file, token.line, token.col);
  };

  const processFile = (file: SourceFile, depth: number): void => {
    if (depth > 32) throw new MqlSyntaxError('#include nesting is too deep', file.name, 1, 1);
    const { tokens, comments: fileComments } = lex(file.source, file.name);
    comments.set(file.name, fileComments);

    // Conditional-compilation stack: each frame records whether its branch is live.
    const conditions: { active: boolean; parentActive: boolean; seenElse: boolean }[] = [];
    const live = (): boolean => conditions.every((frame) => frame.active);

    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]!;
      if (token.kind === 'eof') break;

      if (token.kind === 'directive') {
        const match = token.text.match(/^(\w+)\s*([\s\S]*)$/);
        const name = match?.[1] ?? '';
        const rest = (match?.[2] ?? '').trim();

        if (name === 'ifdef' || name === 'ifndef') {
          const defined = macros.has(rest.split(/\s+/)[0] ?? '');
          const parentActive = live();
          conditions.push({ active: name === 'ifdef' ? defined : !defined, parentActive, seenElse: false });
          continue;
        }
        if (name === 'else') {
          const frame = conditions[conditions.length - 1];
          if (!frame || frame.seenElse) fail(token, '#else without #ifdef');
          frame!.active = !frame!.active;
          frame!.seenElse = true;
          continue;
        }
        if (name === 'endif') {
          if (!conditions.pop()) fail(token, '#endif without #ifdef');
          continue;
        }
        if (!live()) continue;

        switch (name) {
          case 'property': {
            const prop = rest.match(/^(\w+)\s*([\s\S]*)$/);
            if (prop) {
              const key = prop[1]!;
              let value = (prop[2] ?? '').trim();
              const quoted = value.match(/^"((?:[^"\\]|\\.)*)"/);
              if (quoted) value = quoted[1]!.replace(/\\"/g, '"');
              const list = properties.get(key) ?? [];
              list.push(value);
              properties.set(key, list);
            }
            break;
          }
          case 'include': {
            const target = rest.match(/^[<"]([^>"]+)[>"]/)?.[1];
            if (!target) fail(token, 'malformed #include');
            const key = normaliseIncludePath(target!);
            if (included.has(key)) break;
            const user = userFiles.get(key) ?? userFiles.get(baseName(target!));
            const std = options.stdlib.get(key);
            // A header the author supplied wins over a same-named library one,
            // as it would in MetaEditor where the local folder is searched first
            // for quoted includes.
            if (user && (rest.startsWith('"') || !std)) {
              included.add(key);
              processFile(user, depth + 1);
            } else if (std !== undefined) {
              included.add(key);
              includes.push(key);
              processFile({ name: `<${key}>`, source: std }, depth + 1);
            } else {
              diagnostics.push({
                severity: 'error',
                message:
                  `#include ${rest} was not found. Upload that .mqh file together with the EA` +
                  (rest.startsWith('<') ? ', or remove the include if nothing from it is used.' : '.'),
                file: token.file,
                line: token.line,
              });
            }
            break;
          }
          case 'define': {
            const def = rest.match(/^(\w+)(\(([^)]*)\))?\s*([\s\S]*)$/);
            if (!def) fail(token, 'malformed #define');
            const macroName = def![1]!;
            // A function-like macro has its '(' immediately after the name.
            const functionLike = def![2] !== undefined && rest.charAt(macroName.length) === '(';
            const bodyText = functionLike ? def![4]! : rest.slice(macroName.length);
            const params = functionLike
              ? def![3]!.split(',').map((p) => p.trim()).filter((p) => p.length > 0)
              : null;
            const variadic = params?.[params.length - 1] === '...' || false;
            if (variadic) params!.pop();
            const bodyTokens = bodyText.trim()
              ? lex(bodyText, token.file).tokens.filter((t) => t.kind !== 'eof').map((t) => ({ ...t, line: token.line }))
              : [];
            macros.set(macroName, { params, variadic, body: bodyTokens });
            break;
          }
          case 'undef':
            macros.delete(rest.split(/\s+/)[0] ?? '');
            break;
          case 'import':
            if (rest.length > 0) {
              diagnostics.push({
                severity: 'error',
                message:
                  `#import ${rest} loads ${/\.dll/i.test(rest) ? 'a Windows DLL' : 'a compiled library'}, which only ` +
                  'MetaTrader itself can run. Remove the import, or run this EA inside MT5 and use mirror mode.',
                file: token.file,
                line: token.line,
              });
              // Skip the import block's declarations up to the closing #import.
              let j = i + 1;
              while (j < tokens.length && !(tokens[j]!.kind === 'directive' && /^import\s*$/.test(tokens[j]!.text))) j += 1;
              i = j;
            }
            break;
          case 'resource':
            warn(token, `#resource ${rest} is ignored — embedded files are not available in the web runtime.`);
            break;
          case 'pragma':
          case 'line':
          case 'error':
          case 'warning':
            break;
          default:
            warn(token, `#${name} is not supported and was ignored.`);
        }
        continue;
      }

      if (!live()) continue;

      if (token.kind === 'ident') {
        i = expandInto(tokens, i, output, new Set());
        continue;
      }
      output.push(token);
    }

    if (conditions.length > 0) {
      throw new MqlSyntaxError('#ifdef without matching #endif', file.name, tokens[tokens.length - 1]!.line, 1);
    }
  };

  /**
   * Expands the identifier at `index` into `out`, following macros. Returns the
   * index of the last token consumed.
   */
  const expandInto = (tokens: Token[], index: number, out: Token[], active: Set<string>): number => {
    const token = tokens[index]!;
    if (token.kind !== 'ident') {
      out.push(token);
      return index;
    }

    if (token.text === '__LINE__') {
      out.push({ ...token, kind: 'number', text: String(token.line), value: token.line, float: false });
      return index;
    }
    if (token.text === '__FILE__' || token.text === '__PATH__') {
      out.push({ ...token, kind: 'string', text: token.file.replace(/^<|>$/g, '') });
      return index;
    }
    if (token.text === '__DATE__' || token.text === '__DATETIME__') {
      out.push({ ...token, kind: 'number', text: token.text, value: Math.floor(Date.now() / 1000), literal: 'datetime' });
      return index;
    }

    const macro = macros.get(token.text);
    if (!macro || active.has(token.text)) {
      out.push(token);
      return index;
    }

    let consumed = index;
    let body = macro.body;

    if (macro.params) {
      const open = tokens[index + 1];
      if (!open || open.kind !== 'op' || open.text !== '(') {
        // A function-like macro name without arguments is just a name.
        out.push(token);
        return index;
      }
      const args: Token[][] = [[]];
      let depth = 0;
      let j = index + 2;
      for (; j < tokens.length; j += 1) {
        const t = tokens[j]!;
        if (t.kind === 'eof') fail(token, `unterminated call to macro ${token.text}`);
        if (t.kind === 'op' && (t.text === '(' || t.text === '[' || t.text === '{')) depth += 1;
        if (t.kind === 'op' && (t.text === ')' || t.text === ']' || t.text === '}')) {
          if (depth === 0 && t.text === ')') break;
          depth -= 1;
        }
        if (t.kind === 'op' && t.text === ',' && depth === 0 && !(macro.variadic && args.length > macro.params.length)) {
          args.push([]);
          continue;
        }
        args[args.length - 1]!.push(t);
      }
      consumed = j;
      if (args.length === 1 && args[0]!.length === 0 && macro.params.length === 0) args.length = 0;

      const substituted: Token[] = [];
      for (let k = 0; k < body.length; k += 1) {
        const t = body[k]!;
        // #param stringifies an argument.
        if (t.kind === 'op' && t.text === '#' && body[k + 1]?.kind === 'ident') {
          const p = macro.params.indexOf(body[k + 1]!.text);
          if (p >= 0) {
            substituted.push({ ...t, kind: 'string', text: (args[p] ?? []).map((a) => a.text).join(' ') });
            k += 1;
            continue;
          }
        }
        if (t.kind === 'ident') {
          const p = macro.params.indexOf(t.text);
          if (p >= 0) {
            substituted.push(...(args[p] ?? []));
            continue;
          }
          if (t.text === '__VA_ARGS__' && macro.variadic) {
            const extra = args.slice(macro.params.length);
            extra.forEach((arg, n) => {
              if (n > 0) substituted.push({ ...t, kind: 'op', text: ',' });
              substituted.push(...arg);
            });
            continue;
          }
        }
        substituted.push(t);
      }
      body = substituted;
    }

    // Token pasting: a ## b joins two identifiers.
    const pasted: Token[] = [];
    for (let k = 0; k < body.length; k += 1) {
      const t = body[k]!;
      if (t.kind === 'op' && t.text === '#' && body[k + 1]?.kind === 'op' && body[k + 1]!.text === '#') {
        const left = pasted.pop();
        const right = body[k + 2];
        if (left && right) {
          const text = left.text + right.text;
          const relexed = lex(text, token.file).tokens[0]!;
          pasted.push({ ...relexed, line: token.line, col: token.col, file: token.file });
          k += 2;
          continue;
        }
      }
      pasted.push(t);
    }

    const nextActive = new Set(active);
    nextActive.add(token.text);
    const stamped = pasted.map((t) => ({ ...t, line: token.line, col: token.col, file: token.file, macro: token.text }));
    for (let k = 0; k < stamped.length; k += 1) {
      k = expandInto(stamped, k, out, nextActive);
    }
    return consumed;
  };

  for (const prelude of options.preludes ?? []) processFile(prelude, 0);
  processFile(entry, 0);
  output.push({ kind: 'eof', text: '', line: output[output.length - 1]?.line ?? 1, col: 1, file: entry.name });
  return { tokens: output, properties, comments, diagnostics, includes };
}
