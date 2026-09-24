import type { FunctionDecl, TopLevel } from './ast.js';
import { BUILTIN_TYPE_NAMES } from './builtins.js';
import { CodeGenerator, CompileError, type HandlerInfo, type InputDescriptor } from './codegen.js';
import { lex, MqlSyntaxError } from './lexer.js';
import { NATIVE_PROTOTYPES } from './natives.js';
import { Parser } from './parser.js';
import { preprocess, type Diagnostic, type SourceFile } from './preprocess.js';
import { PRELUDE } from '../stdlib/prelude.js';
import { STDLIB } from '../stdlib/index.js';

export type { Diagnostic, SourceFile } from './preprocess.js';
export type { HandlerInfo, InputDescriptor, InputOption } from './codegen.js';

export interface CompiledProgram {
  ok: true;
  /** File name without extension — what MT5 would call the expert. */
  name: string;
  js: string;
  inputs: InputDescriptor[];
  handlers: HandlerInfo[];
  properties: Record<string, string[]>;
  diagnostics: Diagnostic[];
  /** Standard-library headers the program included. */
  includes: string[];
}

export interface CompileFailure {
  ok: false;
  name: string;
  diagnostics: Diagnostic[];
}

export type CompileResult = CompiledProgram | CompileFailure;

export interface CompileOptions {
  /** .mqh headers uploaded alongside the EA. */
  files?: SourceFile[];
}

interface NativeDecl {
  decl: FunctionDecl;
  impl: string;
  async: boolean;
}

let nativeCache: NativeDecl[] | null = null;

const STRUCT_NAMES = ['MqlRates', 'MqlTick', 'MqlDateTime', 'MqlTradeRequest', 'MqlTradeResult', 'MqlTradeCheckResult', 'MqlTradeTransaction', 'MqlBookInfo', 'MqlParam'];

/** Parses the built-in function table once. */
export function nativeDeclarations(): NativeDecl[] {
  if (nativeCache) return nativeCache;
  const types = new Set([...BUILTIN_TYPE_NAMES, 'any', ...STRUCT_NAMES]);
  const out: NativeDecl[] = [];
  for (const raw of NATIVE_PROTOTYPES.split('\n')) {
    let line = raw.trim();
    if (!line) continue;
    let isAsync = false;
    if (line.startsWith('async ')) {
      isAsync = true;
      line = line.slice(6);
    }
    let impl: string | undefined;
    const at = line.match(/\s@(\w+)\s*$/);
    if (at) {
      impl = at[1];
      line = line.slice(0, at.index).trim();
    }
    const { tokens, comments } = lex(`${line};`, '<natives>');
    const parser = new Parser(tokens, { builtinTypes: types, comments: new Map([['<natives>', comments]]) });
    const [decl] = parser.parseProgram() as TopLevel[];
    if (!decl || decl.kind !== 'Function') throw new Error(`bad native prototype: ${line}`);
    out.push({ decl, impl: impl ?? decl.name, async: isAsync });
  }
  nativeCache = out;
  return out;
}

function baseName(file: string): string {
  return file.replace(/^.*[\\/]/, '').replace(/\.(mq5|mq4|mqh)$/i, '');
}

function toDiagnostic(err: unknown, file: string): Diagnostic {
  if (err instanceof MqlSyntaxError) return { severity: 'error', message: err.message.replace(/^.*?\(\d+,\d+\): /, ''), file: err.file, line: err.line };
  if (err instanceof CompileError) return { severity: 'error', message: err.message, file: err.pos.file, line: err.pos.line };
  return { severity: 'error', message: err instanceof Error ? err.message : String(err), file, line: 0 };
}

/**
 * Compiles an MQL5 expert advisor to JavaScript.
 *
 * Refuses programs that are not experts (indicators, scripts), and anything
 * MetaTrader-only (DLL and .ex5 imports) with a reason, rather than letting an
 * EA start and fail on its first tick.
 */
export function compileMql5(source: string, fileName = 'Expert.mq5', options: CompileOptions = {}): CompileResult {
  const name = baseName(fileName);
  const diagnostics: Diagnostic[] = [];

  // SELECT_BY_POS and MODE_TRADES exist only in MQL4, so either one settles it.
  if (/\.mq4$/i.test(fileName) || /\b(SELECT_BY_POS|SELECT_BY_TICKET|MODE_TRADES|MODE_HISTORY)\b/.test(source)) {
    return {
      ok: false,
      name,
      diagnostics: [{
        severity: 'error',
        message: 'This is MQL4 code (MetaTrader 4). It would not compile in MetaTrader 5 either — upload the .mq5 version of the EA.',
        file: fileName,
        line: 1,
      }],
    };
  }

  try {
    const pp = preprocess(
      { name: fileName, source },
      { stdlib: STDLIB, files: options.files, preludes: [{ name: '<prelude>', source: PRELUDE }] },
    );
    diagnostics.push(...pp.diagnostics);
    if (pp.diagnostics.some((d) => d.severity === 'error')) return { ok: false, name, diagnostics };

    const parser = new Parser(pp.tokens, { builtinTypes: BUILTIN_TYPE_NAMES, comments: pp.comments });
    const program = parser.parseProgram();

    const functions = new Set(program.filter((d) => d.kind === 'Function' && !d.className).map((d) => (d as FunctionDecl).name));
    const properties = Object.fromEntries(pp.properties);
    if (functions.has('OnCalculate') || Object.keys(properties).some((k) => k.startsWith('indicator_'))) {
      return {
        ok: false,
        name,
        diagnostics: [...diagnostics, {
          severity: 'error',
          message: 'This file is an indicator, not an expert advisor — it draws on a chart and cannot trade. Upload the EA that uses it.',
          file: fileName,
          line: 1,
        }],
      };
    }
    if (functions.has('OnStart') && !functions.has('OnTick')) {
      return {
        ok: false,
        name,
        diagnostics: [...diagnostics, {
          severity: 'error',
          message: 'This file is a script (it has OnStart and no OnTick), which runs once and stops. The bot needs an expert advisor with OnTick.',
          file: fileName,
          line: 1,
        }],
      };
    }
    if (!functions.has('OnTick') && !functions.has('OnTimer')) {
      return {
        ok: false,
        name,
        diagnostics: [...diagnostics, {
          severity: 'error',
          message: 'No OnTick() or OnTimer() function was found, so this EA would never act.',
          file: fileName,
          line: 1,
        }],
      };
    }

    const generator = new CodeGenerator({ program, natives: nativeDeclarations(), entryFile: fileName });
    const generated = generator.generate();
    diagnostics.push(...generated.diagnostics);

    // A syntax error here is a compiler bug, and should say so rather than
    // blame the EA.
    try {
      // eslint-disable-next-line no-new-func
      new Function('$', 'N', generated.js);
    } catch (err) {
      return {
        ok: false,
        name,
        diagnostics: [...diagnostics, {
          severity: 'error',
          message: `Internal compiler error (the EA itself may be fine): ${err instanceof Error ? err.message : String(err)}`,
          file: fileName,
          line: 0,
        }],
      };
    }

    return {
      ok: true,
      name,
      js: generated.js,
      inputs: generated.inputs,
      handlers: generated.handlers,
      properties,
      diagnostics,
      includes: pp.includes,
    };
  } catch (err) {
    diagnostics.push(toDiagnostic(err, fileName));
    return { ok: false, name, diagnostics };
  }
}
