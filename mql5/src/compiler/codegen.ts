import type {
  ClassDecl,
  Declarator,
  EnumDecl,
  Expr,
  FunctionDecl,
  InitList,
  Pos,
  Stmt,
  TopLevel,
  TypeRef,
  VarDecl,
} from './ast.js';
import { BUILTIN_ENUMS, buildConstantTable, type ConstantInfo } from './builtins.js';
import type { Diagnostic } from './preprocess.js';
import {
  T,
  convertCode,
  is64,
  isArr,
  isFloat,
  isIntegral,
  isNumeric,
  isObj,
  isPrim,
  isString,
  prim,
  promote,
  rank,
  sameType,
  scalarDefault,
  strTag,
  typeName,
  type Prim,
  type Type,
} from './types.js';

/**
 * MQL5 → JavaScript code generator.
 *
 * The output is a plain JavaScript function body, so an EA runs at the
 * engine's native speed rather than through an interpreter loop. Three MQL5
 * behaviours need care that JavaScript would otherwise get wrong, and each is
 * emitted only where the types call for it:
 *
 * - integer arithmetic (truncating division, 32-bit wrap, int conversions);
 * - value semantics for structs (assignment copies) and reference parameters
 *   for scalars (`double &x`), which become small accessor objects;
 * - waiting on the broker. A function is emitted `async` only if it can reach
 *   `OrderSend` or `Sleep`; the rest stay synchronous, so a tick that trades
 *   nothing never waits for anything.
 */

export class CompileError extends Error {
  constructor(
    message: string,
    readonly pos: Pos,
  ) {
    super(message);
    this.name = 'CompileError';
  }
}

interface VarInfo {
  name: string;
  type: Type;
  js: string;
  /** A scalar reference parameter: the JS variable holds a `{ v }` accessor. */
  boxed?: boolean;
  constValue?: number | string | boolean;
}

interface ParamInfo {
  name: string;
  type: Type;
  /** Scalar passed by reference — needs an accessor. */
  box: boolean;
  /** Struct passed by value — the callee copies it on entry. */
  copyOnEntry: boolean;
  defaultValue?: Expr;
}

export interface FuncInfo {
  id: number;
  name: string;
  owner?: ClassInfo;
  decl?: FunctionDecl;
  native?: string;
  params: ParamInfo[];
  variadic: boolean;
  ret: Type;
  js: string;
  sig: string;
  isStatic: boolean;
  isVirtual: boolean;
  isCtor: boolean;
  isDtor: boolean;
  isPure: boolean;
  isTemplate: boolean;
  async: boolean;
  callees: Set<FuncInfo>;
}

interface FieldInfo {
  name: string;
  type: Type;
  js: string;
  isStatic: boolean;
  owner: ClassInfo;
  declarator: Declarator;
  decl: VarDecl;
}

interface ClassInfo {
  name: string;
  js: string;
  decl: ClassDecl;
  isStruct: boolean;
  baseName?: string;
  base?: ClassInfo;
  fields: Map<string, FieldInfo>;
  fieldOrder: FieldInfo[];
  methods: Map<string, FuncInfo[]>;
  ctors: FuncInfo[];
  dtor?: FuncInfo;
  subclasses: ClassInfo[];
  templateParams: string[];
}

interface EnumInfo {
  name: string;
  js: string;
  members: { name: string; value: number; label?: string }[];
  builtin: boolean;
}

type LValue =
  | { k: 'var'; code: string }
  | { k: 'box'; code: string }
  | { k: 'member'; obj: string; prop: string }
  | { k: 'elem'; arr: string; idx: string[] };

interface CExpr {
  code: string;
  type: Type;
  lv?: LValue;
  constValue?: number | string | boolean;
}

interface FnCtx {
  fn?: FuncInfo;
  cls?: ClassInfo;
  isStatic: boolean;
  scopes: Map<string, VarInfo>[];
  temps: number;
  funcName: string;
}

export interface InputOption {
  value: number;
  name: string;
  label: string;
}

export interface InputDescriptor {
  name: string;
  label: string;
  group?: string;
  /** How the settings form should present it. */
  kind: 'bool' | 'int' | 'double' | 'string' | 'enum' | 'datetime' | 'color' | 'timeframe';
  typeName: string;
  defaultValue: number | string | boolean | null;
  options?: InputOption[];
  static: boolean;
}

export interface HandlerInfo {
  name: string;
  async: boolean;
}

export interface CodegenResult {
  js: string;
  inputs: InputDescriptor[];
  handlers: HandlerInfo[];
  diagnostics: Diagnostic[];
}

const HANDLERS = ['OnInit', 'OnDeinit', 'OnTick', 'OnTimer', 'OnTrade', 'OnTradeTransaction', 'OnChartEvent', 'OnTester', 'OnBookEvent'];

const RESERVED_FIELD = new Set(['constructor', '__proto__', 'prototype', 'hasOwnProperty', 'toString', 'valueOf', 'then']);

const PREDEFINED: Record<string, { type: Type; code: string }> = {
  _Symbol: { type: T.string, code: '$._Symbol' },
  _Point: { type: T.double, code: '$._Point' },
  _Digits: { type: T.int, code: '$._Digits' },
  _Period: { type: { k: 'enum', n: 'ENUM_TIMEFRAMES' }, code: '$._Period' },
  _LastError: { type: T.int, code: '$._LastError' },
  _StopFlag: { type: T.bool, code: '$._StopFlag' },
  _UninitReason: { type: T.int, code: '$._UninitReason' },
  _RandomSeed: { type: T.int, code: '$._RandomSeed' },
  _IsX64: { type: T.bool, code: 'true' },
  _AppliedTo: { type: T.int, code: '0' },
};

function fieldJs(name: string): string {
  return RESERVED_FIELD.has(name) ? `${name}$` : name;
}

function sigOf(params: { type: Type }[]): string {
  if (params.length === 0) return 'v';
  return params.map((p) => typeName(p.type).replace(/[^A-Za-z0-9]/g, '_')).join('_');
}

const PRIMS = new Set<string>(['void', 'bool', 'char', 'uchar', 'short', 'ushort', 'int', 'uint', 'long', 'ulong', 'float', 'double', 'string', 'datetime', 'color']);

export interface CodegenOptions {
  /** Top-level declarations of the program, including prelude and headers. */
  program: TopLevel[];
  /** Native prototypes, parsed. */
  natives: { decl: FunctionDecl; impl: string; async: boolean }[];
  /** Name of the entry file, for diagnostics. */
  entryFile: string;
}

export class CodeGenerator {
  private readonly constants: Map<string, ConstantInfo> = buildConstantTable();
  private readonly enums = new Map<string, EnumInfo>();
  private readonly enumMembers = new Map<string, { enumName: string; value: number }>();
  private readonly classes = new Map<string, ClassInfo>();
  private readonly typedefs = new Map<string, TypeRef>();
  private readonly functions = new Map<string, FuncInfo[]>();
  private readonly natives = new Map<string, FuncInfo[]>();
  private readonly globals = new Map<string, VarInfo>();
  private readonly globalDecls: VarDecl[] = [];
  /** `int CFoo::count = 0;` definitions, applied once fields are known. */
  private readonly staticDefs: VarDecl[] = [];
  private readonly allFuncs: FuncInfo[] = [];
  private readonly diagnostics: Diagnostic[] = [];
  private nextId = 1;
  private staticCounter = 0;
  private staticDecls: string[] = [];
  /** When false (first pass) async is not yet known and calls are recorded instead. */
  private asyncKnown = false;
  private current: FnCtx | null = null;

  constructor(private readonly options: CodegenOptions) {}

  /* ================================================================== */
  /* Entry point                                                         */
  /* ================================================================== */

  generate(): CodegenResult {
    for (const [name, members] of Object.entries(BUILTIN_ENUMS)) {
      this.enums.set(name, {
        name,
        js: `$.B[${JSON.stringify(name)}]`,
        members: members.map(([member, value]) => ({ name: member, value })),
        builtin: true,
      });
    }
    this.collectDeclarations(this.options.program);
    this.resolveClassHierarchy();
    // Natives mention the prelude structs, so they come after classes are known.
    for (const native of this.options.natives) this.declareNative(native.decl, native.impl, native.async);
    this.declareMembers();

    // Pass 1 discovers the call graph; pass 2 emits with async known.
    this.emitAll();
    this.propagateAsync();
    this.asyncKnown = true;
    const js = this.emitAll();

    const handlers: HandlerInfo[] = [];
    for (const name of HANDLERS) {
      const fn = this.functions.get(name)?.find((f) => f.decl?.body);
      if (fn) handlers.push({ name, async: fn.async });
    }

    return { js, inputs: this.collectInputs(), handlers, diagnostics: this.diagnostics };
  }

  private fail(message: string, pos: Pos): never {
    throw new CompileError(message, pos);
  }

  private warn(message: string, pos: Pos): void {
    this.diagnostics.push({ severity: 'warning', message, file: pos.file, line: pos.line });
  }

  /* ================================================================== */
  /* Declarations                                                        */
  /* ================================================================== */

  private declareNative(decl: FunctionDecl, impl: string, isAsync: boolean): void {
    const params: ParamInfo[] = [];
    let variadic = false;
    for (const p of decl.params) {
      if (p.name === '__variadic__') {
        variadic = true;
        continue;
      }
      const type = this.resolveTypeRef(p.type, p.dims, []);
      params.push({ name: p.name, type, box: Boolean(p.type.ref) && !isArr(type) && !isObj(type), copyOnEntry: false, defaultValue: p.defaultValue });
    }
    const info: FuncInfo = {
      id: this.nextId++,
      name: decl.name,
      native: impl,
      params,
      variadic,
      ret: this.resolveTypeRef(decl.returnType, 0, []),
      js: `N.${impl}`,
      sig: sigOf(params),
      isStatic: true,
      isVirtual: false,
      isCtor: false,
      isDtor: false,
      isPure: false,
      isTemplate: false,
      async: isAsync,
      callees: new Set(),
    };
    const list = this.natives.get(decl.name) ?? [];
    list.push(info);
    this.natives.set(decl.name, list);
  }

  private collectDeclarations(body: TopLevel[]): void {
    for (const item of body) {
      switch (item.kind) {
        case 'Enum':
          this.declareEnum(item);
          break;
        case 'Class':
          this.declareClass(item);
          break;
        case 'Typedef':
          this.typedefs.set(item.name, item.type);
          break;
        case 'VarDecl':
          if (item.staticOf) this.staticDefs.push(item);
          else this.globalDecls.push(item);
          break;
        case 'Function':
          break;
        case 'InputGroup':
          break;
      }
    }
  }

  private declareEnum(decl: EnumDecl, owner?: string): void {
    const members: EnumInfo['members'] = [];
    let next = 0;
    for (const member of decl.members) {
      let value = next;
      if (member.value) {
        const evaluated = this.constEval(member.value);
        if (typeof evaluated !== 'number') this.fail(`enum value for ${member.name} must be an integer constant`, member.pos);
        value = evaluated;
      }
      members.push({ name: member.name, value, label: member.comment });
      this.enumMembers.set(member.name, { enumName: decl.name, value });
      if (owner) this.enumMembers.set(`${owner}::${member.name}`, { enumName: decl.name, value });
      next = value + 1;
    }
    this.enums.set(decl.name, { name: decl.name, js: `E$${decl.name}`, members, builtin: false });
  }

  private declareClass(decl: ClassDecl): void {
    if (this.classes.has(decl.name)) {
      const existing = this.classes.get(decl.name)!;
      // A forward declaration followed by the definition merges into one.
      if (existing.decl.members.length === 0) existing.decl = decl;
      return;
    }
    const info: ClassInfo = {
      name: decl.name,
      js: `C$${decl.name}`,
      decl,
      isStruct: decl.isStruct,
      baseName: decl.base,
      fields: new Map(),
      fieldOrder: [],
      methods: new Map(),
      ctors: [],
      subclasses: [],
      templateParams: decl.template ?? [],
    };
    this.classes.set(decl.name, info);
    for (const member of decl.members) {
      if (member.kind === 'Enum') this.declareEnum(member, decl.name);
      if (member.kind === 'Class') this.declareClass(member);
    }
  }

  private resolveClassHierarchy(): void {
    for (const info of this.classes.values()) {
      if (!info.baseName) continue;
      const base = this.classes.get(info.baseName);
      if (!base) this.fail(`base class ${info.baseName} of ${info.name} is not defined`, info.decl.pos);
      info.base = base;
      base.subclasses.push(info);
    }
  }

  private declareMembers(): void {
    for (const info of this.classes.values()) {
      for (const member of info.decl.members) {
        if (member.kind === 'VarDecl') {
          for (const declarator of member.declarators) {
            const type = this.resolveTypeRef(member.type, declarator.dims.length, info.templateParams, declarator.pointer);
            const field: FieldInfo = {
              name: declarator.name,
              type,
              js: member.storage.static ? `${info.js}.s$${declarator.name}` : fieldJs(declarator.name),
              isStatic: Boolean(member.storage.static),
              owner: info,
              declarator,
              decl: member,
            };
            info.fields.set(declarator.name, field);
            info.fieldOrder.push(field);
          }
        }
        if (member.kind === 'Function') this.declareFunction(member, info);
      }
    }

    // Out-of-class definitions attach to their declaration, or add a method.
    for (const item of this.options.program) {
      if (item.kind !== 'Function') continue;
      if (item.className) {
        const info = this.classes.get(item.className);
        if (!info) this.fail(`class ${item.className} is not defined`, item.pos);
        this.attachOutOfClass(item, info);
      } else {
        this.declareFunction(item);
      }
    }

    for (const def of this.staticDefs) {
      const cls = this.classes.get(def.staticOf!);
      const declarator = def.declarators[0]!;
      const field = cls?.fields.get(declarator.name);
      if (!field || !field.isStatic) this.fail(`${def.staticOf}::${declarator.name} is not a static member`, def.pos);
      if (declarator.init) field.declarator = { ...field.declarator, init: declarator.init };
    }

    for (const decl of this.globalDecls) {
      for (const declarator of decl.declarators) {
        const type = this.resolveTypeRef(decl.type, declarator.dims.length, [], declarator.pointer);
        const info: VarInfo = { name: declarator.name, type, js: `v$${declarator.name}` };
        if (decl.storage.const && declarator.init && declarator.init.kind !== 'InitList') {
          const value = this.constEval(declarator.init);
          if (value !== undefined) info.constValue = value;
        }
        this.globals.set(declarator.name, info);
      }
    }
  }

  private paramInfos(decl: FunctionDecl, template: string[]): ParamInfo[] {
    return decl.params.map((p) => {
      const type = this.resolveTypeRef(p.type, p.dims, template);
      const byRef = Boolean(p.type.ref);
      const constRef = byRef && Boolean(p.type.isConst);
      const isScalar = !isArr(type) && !isObj(type);
      return {
        name: p.name,
        type,
        box: byRef && isScalar && !constRef,
        copyOnEntry: !byRef && isObj(type) && !type.ptr,
        defaultValue: p.defaultValue,
      };
    });
  }

  private declareFunction(decl: FunctionDecl, owner?: ClassInfo): FuncInfo {
    const template = [...(owner?.templateParams ?? []), ...(decl.template ?? [])];
    const params = this.paramInfos(decl, template);
    const sig = sigOf(params);
    const isCtor = Boolean(decl.isCtor);
    const isDtor = Boolean(decl.isDtor);
    const info: FuncInfo = {
      id: this.nextId++,
      name: decl.name,
      owner,
      decl,
      params,
      variadic: false,
      ret: isCtor || isDtor ? T.void : this.resolveTypeRef(decl.returnType, 0, template),
      js: isCtor ? `$c$${sig}` : isDtor ? '$d' : owner ? `m$${decl.name}$${sig}` : `f$${decl.name}$${sig}`,
      sig,
      isStatic: Boolean(decl.isStatic),
      isVirtual: Boolean(decl.isVirtual),
      isCtor,
      isDtor,
      isPure: Boolean(decl.isPure),
      isTemplate: template.length > 0,
      async: false,
      callees: new Set(),
    };
    if (owner) {
      if (isCtor) owner.ctors.push(info);
      else if (isDtor) owner.dtor = info;
      else {
        const list = owner.methods.get(decl.name) ?? [];
        list.push(info);
        owner.methods.set(decl.name, list);
      }
    } else {
      const list = this.functions.get(decl.name) ?? [];
      // A prototype followed by its definition is one function.
      const existing = list.find((f) => f.sig === sig);
      if (existing) {
        if (decl.body) existing.decl = decl;
        return existing;
      }
      list.push(info);
      this.functions.set(decl.name, list);
    }
    this.allFuncs.push(info);
    return info;
  }

  private attachOutOfClass(decl: FunctionDecl, owner: ClassInfo): void {
    const template = [...owner.templateParams, ...(decl.template ?? [])];
    const sig = sigOf(this.paramInfos(decl, template));
    let target: FuncInfo | undefined;
    if (decl.isCtor) target = owner.ctors.find((c) => c.sig === sig);
    else if (decl.isDtor) target = owner.dtor;
    else target = owner.methods.get(decl.name)?.find((m) => m.sig === sig);
    if (target) {
      // Keep the in-class declaration's flags; take the body from here.
      target.decl = { ...target.decl!, body: decl.body, initList: decl.initList ?? target.decl!.initList };
      return;
    }
    this.declareFunction({ ...decl }, owner);
  }

  /* ================================================================== */
  /* Types                                                               */
  /* ================================================================== */

  private resolveTypeRef(ref: TypeRef, dims: number, template: string[], pointer = false): Type {
    let base: Type;
    let name = ref.name;
    const alias = this.typedefs.get(name);
    if (alias) {
      if (alias.name === '$function') this.fail(`function pointer type ${name} is not supported`, ref.pos);
      name = alias.name;
    }
    if (name === 'any') base = T.any;
    else if (PRIMS.has(name)) base = prim(name as Prim);
    else if (template.includes(name)) base = T.any;
    else if (this.enums.has(name) || BUILTIN_ENUMS[name]) base = { k: 'enum', n: name };
    else if (this.classes.has(name)) base = { k: 'obj', n: name, ptr: Boolean(ref.pointer) || pointer };
    else this.fail(`unknown type '${name}'`, ref.pos);
    if (dims > 0) return { k: 'arr', of: base, dims };
    return base;
  }

  private isSubclass(child: string, parent: string): boolean {
    let info = this.classes.get(child);
    while (info) {
      if (info.name === parent) return true;
      info = info.base;
    }
    return false;
  }

  /** Cost of passing `from` where `to` is expected; Infinity when not allowed. */
  private conversionCost(arg: CExpr, to: Type, param?: ParamInfo): number {
    const from = arg.type;
    if (to.k === 'any' || from.k === 'any') return 0;
    if (param?.box) {
      if (!arg.lv) return Infinity;
      if (sameType(from, to)) return 0;
      if (isIntegral(from) && isIntegral(to) && rank(from) === rank(to)) return 0.5;
      return Infinity;
    }
    if (isArr(to)) {
      if (!isArr(from)) return Infinity;
      if (to.of.k === 'any' || (isPrim(to.of, 'void'))) return 0;
      if (sameType(to.of, from.of)) return 0;
      if (isIntegral(to.of) && isIntegral(from.of) && rank(to.of) === rank(from.of)) return 0.5;
      return Infinity;
    }
    if (isArr(from)) return Infinity;
    if (isObj(to)) {
      if (from.k === 'null') return to.ptr ? 0 : Infinity;
      if (!isObj(from)) return Infinity;
      if (from.n === to.n) return 0;
      return this.isSubclass(from.n, to.n) ? 1 : Infinity;
    }
    if (isObj(from)) return Infinity;
    if (from.k === 'null') return isString(to) ? 0.5 : isNumeric(to) ? 1 : Infinity;
    if (sameType(from, to)) return 0;
    if (from.k === 'enum' && to.k === 'enum') return 1;
    if (isString(to)) return isString(from) ? 0 : 5;
    if (isString(from)) return 5;
    if (isPrim(to, 'bool')) return 2;
    const rf = rank(from);
    const rt = rank(to);
    if (from.k === 'enum' && isIntegral(to)) return rt >= 3 ? 0.5 : 2;
    if (to.k === 'enum') return isIntegral(from) ? 0.5 : 3;
    if (isIntegral(from) && isIntegral(to)) return rt >= rf ? 0.25 * (rt - rf) || 0.1 : 2;
    if (isIntegral(from) && isFloat(to)) return 1;
    if (isFloat(from) && isIntegral(to)) return 3;
    if (isFloat(from) && isFloat(to)) return rt >= rf ? 0.1 : 1;
    return Infinity;
  }

  private pickOverload(candidates: FuncInfo[], args: CExpr[], name: string, pos: Pos): FuncInfo {
    let best: FuncInfo | undefined;
    let bestScore = Infinity;
    for (const fn of candidates) {
      if (args.length > fn.params.length && !fn.variadic) continue;
      const required = fn.params.filter((p) => p.defaultValue === undefined).length;
      if (args.length < required) continue;
      let score = 0;
      for (let i = 0; i < args.length && i < fn.params.length; i += 1) {
        score += this.conversionCost(args[i]!, fn.params[i]!.type, fn.params[i]);
        if (score === Infinity) break;
      }
      if (score < bestScore) {
        best = fn;
        bestScore = score;
      }
    }
    if (!best) {
      const shown = args.map((a) => typeName(a.type)).join(', ');
      const sigs = candidates
        .map((c) => `${c.name}(${c.params.map((p) => `${typeName(p.type)}${p.box ? '&' : ''} ${p.name}`).join(', ')}${c.variadic ? ', ...' : ''})`)
        .join('; ');
      this.fail(`no overload of ${name} accepts (${shown}). Available: ${sigs}`, pos);
    }
    return best;
  }

  /* ================================================================== */
  /* Constant evaluation                                                 */
  /* ================================================================== */

  constEval(expr: Expr): number | string | boolean | undefined {
    switch (expr.kind) {
      case 'Number':
        return expr.value;
      case 'String':
        return expr.value;
      case 'Bool':
        return expr.value;
      case 'Null':
        return 0;
      case 'Ident': {
        const member = this.enumMembers.get(expr.name);
        if (member) return member.value;
        const constant = this.constants.get(expr.name);
        if (constant) return constant.value;
        return this.globals.get(expr.name)?.constValue;
      }
      case 'Scoped': {
        const member = this.enumMembers.get(expr.scope ? `${expr.scope}::${expr.name}` : expr.name) ?? this.enumMembers.get(expr.name);
        return member?.value;
      }
      case 'Unary': {
        const v = this.constEval(expr.arg);
        if (v === undefined) return undefined;
        switch (expr.op) {
          case '-':
            return -Number(v);
          case '+':
            return +Number(v);
          case '!':
            return !v;
          case '~':
            return ~Number(v);
          default:
            return undefined;
        }
      }
      case 'Binary': {
        const l = this.constEval(expr.left);
        const r = this.constEval(expr.right);
        if (l === undefined || r === undefined) return undefined;
        if (typeof l === 'string' || typeof r === 'string') return expr.op === '+' ? String(l) + String(r) : undefined;
        const a = Number(l);
        const b = Number(r);
        switch (expr.op) {
          case '+':
            return a + b;
          case '-':
            return a - b;
          case '*':
            return a * b;
          case '/':
            return b === 0 ? undefined : Number.isInteger(a) && Number.isInteger(b) && !this.isFloatLiteral(expr) ? Math.trunc(a / b) : a / b;
          case '%':
            return b === 0 ? undefined : a % b;
          case '|':
            return a | b;
          case '&':
            return a & b;
          case '^':
            return a ^ b;
          case '<<':
            return a << b;
          case '>>':
            return a >> b;
          case '==':
            return a === b;
          case '!=':
            return a !== b;
          case '<':
            return a < b;
          case '>':
            return a > b;
          case '<=':
            return a <= b;
          case '>=':
            return a >= b;
          case '&&':
            return Boolean(a) && Boolean(b);
          case '||':
            return Boolean(a) || Boolean(b);
          default:
            return undefined;
        }
      }
      case 'Conditional': {
        const t = this.constEval(expr.test);
        if (t === undefined) return undefined;
        return t ? this.constEval(expr.consequent) : this.constEval(expr.alternate);
      }
      case 'Cast': {
        const v = this.constEval(expr.expr);
        if (v === undefined) return undefined;
        if (['int', 'long', 'uint', 'ulong', 'short', 'ushort', 'char', 'uchar', 'datetime', 'color'].includes(expr.type.name)) return Math.trunc(Number(v));
        if (expr.type.name === 'double' || expr.type.name === 'float') return Number(v);
        if (expr.type.name === 'bool') return Boolean(v);
        if (expr.type.name === 'string') return String(v);
        return typeof v === 'number' ? Math.trunc(v) : v;
      }
      default:
        return undefined;
    }
  }

  private isFloatLiteral(expr: Expr): boolean {
    if (expr.kind === 'Number') return expr.float;
    if (expr.kind === 'Binary') return this.isFloatLiteral(expr.left) || this.isFloatLiteral(expr.right);
    if (expr.kind === 'Unary') return this.isFloatLiteral(expr.arg);
    if (expr.kind === 'Ident') {
      const g = this.globals.get(expr.name);
      if (g) return isFloat(g.type);
      const c = this.constants.get(expr.name);
      return c?.type === 'double';
    }
    return false;
  }

  /* ================================================================== */
  /* Inputs                                                              */
  /* ================================================================== */

  private collectInputs(): InputDescriptor[] {
    const inputs: InputDescriptor[] = [];
    for (const decl of this.globalDecls) {
      if (!decl.storage.input) continue;
      for (const declarator of decl.declarators) {
        const type = this.resolveTypeRef(decl.type, 0, []);
        let kind: InputDescriptor['kind'] = 'int';
        let options: InputOption[] | undefined;
        if (type.k === 'enum') {
          const info = this.enums.get(type.n);
          kind = type.n === 'ENUM_TIMEFRAMES' ? 'timeframe' : 'enum';
          options = info?.members.map((m) => ({ value: m.value, name: m.name, label: m.label || m.name }));
        } else if (type.k === 'prim') {
          if (type.n === 'bool') kind = 'bool';
          else if (type.n === 'double' || type.n === 'float') kind = 'double';
          else if (type.n === 'string') kind = 'string';
          else if (type.n === 'datetime') kind = 'datetime';
          else if (type.n === 'color') kind = 'color';
          else kind = 'int';
        }
        let defaultValue: InputDescriptor['defaultValue'] = null;
        if (declarator.init && declarator.init.kind !== 'InitList') {
          const v = this.constEval(declarator.init);
          if (v !== undefined) defaultValue = kind === 'bool' ? Boolean(v) : v;
        } else {
          defaultValue = kind === 'bool' ? false : kind === 'string' ? '' : 0;
        }
        inputs.push({
          name: declarator.name,
          label: decl.comment || declarator.name,
          group: decl.group,
          kind,
          typeName: typeName(type),
          defaultValue,
          options,
          static: Boolean(decl.storage.sinput),
        });
      }
    }
    return inputs;
  }

  /* ================================================================== */
  /* Async propagation                                                   */
  /* ================================================================== */

  /** Methods that override one another must agree, since dispatch picks one at run time. */
  private overrideGroups(): FuncInfo[][] {
    const groups = new Map<string, FuncInfo[]>();
    const rootOf = (info: ClassInfo): ClassInfo => {
      let root = info;
      while (root.base) root = root.base;
      return root;
    };
    for (const fn of this.allFuncs) {
      if (!fn.owner || fn.isCtor || fn.isStatic) continue;
      const key = `${rootOf(fn.owner).name}::${fn.name}::${fn.sig}`;
      const list = groups.get(key) ?? [];
      list.push(fn);
      groups.set(key, list);
    }
    return [...groups.values()].filter((g) => g.length > 1);
  }

  private propagateAsync(): void {
    const groups = this.overrideGroups();
    let changed = true;
    while (changed) {
      changed = false;
      for (const fn of this.allFuncs) {
        if (fn.async) continue;
        for (const callee of fn.callees) {
          if (callee.async) {
            fn.async = true;
            changed = true;
            break;
          }
        }
      }
      for (const group of groups) {
        if (group.some((f) => f.async) && group.some((f) => !f.async)) {
          for (const f of group) f.async = true;
          changed = true;
        }
      }
    }
  }

  /* ================================================================== */
  /* Emission                                                            */
  /* ================================================================== */

  private emitAll(): string {
    this.staticCounter = 0;
    this.staticDecls = [];
    const out: string[] = [];
    out.push('"use strict";');

    for (const info of this.sortedClasses()) out.push(this.emitClass(info));

    for (const g of this.globals.values()) out.push(`let ${g.js};`);

    for (const list of this.functions.values()) {
      for (const fn of list) {
        if (!fn.decl?.body) continue;
        out.push(this.emitFunction(fn));
      }
    }

    out.push(...this.staticDecls);
    out.push(this.emitInit());

    // Enum name tables for EnumToString — emitted last so enums declared
    // inside functions are included too.
    for (const info of this.enums.values()) {
      if (info.builtin) continue;
      const names = Object.fromEntries(info.members.map((m) => [m.value, m.name]));
      out.push(`var ${info.js} = ${JSON.stringify(names)};`);
    }

    const handlers = HANDLERS.map((name) => {
      const fn = this.functions.get(name)?.find((f) => f.decl?.body);
      return `${name}: ${fn ? fn.js : 'null'}`;
    });
    const structs = [...this.classes.values()].map((c) => `${JSON.stringify(c.name)}: ${c.js}`);
    out.push(`return { init: $init, deinitGlobals: $deinitGlobals, handlers: { ${handlers.join(', ')} }, classes: { ${structs.join(', ')} } };`);
    return out.join('\n');
  }

  private sortedClasses(): ClassInfo[] {
    const done = new Set<string>();
    const order: ClassInfo[] = [];
    const visit = (info: ClassInfo): void => {
      if (done.has(info.name)) return;
      if (info.base) visit(info.base);
      done.add(info.name);
      order.push(info);
    };
    for (const info of this.classes.values()) visit(info);
    return order;
  }

  private elementFactory(elem: Type): string {
    if (isObj(elem)) return elem.ptr ? '() => null' : `() => new C$${elem.n}().$c$v()`;
    return `() => ${scalarDefault(elem)}`;
  }

  /** Default value for a declared variable or field, fully constructed. */
  private defaultValueCode(type: Type, declarator: Declarator, constructObjects = true): string {
    if (isArr(type)) {
      const dims = declarator.dims;
      const first = dims[0];
      const dynamic = first === null || first === undefined;
      const size = dynamic ? '0' : this.withCtx(() => this.expr(first!).code);
      const inner = dims.slice(1).map((d) => (d ? this.withCtx(() => this.expr(d).code) : '0'));
      return `new $.MqlArray(${this.elementFactory(type.of)}, ${dynamic}, ${size}${inner.length ? `, [${inner.join(', ')}]` : ''})`;
    }
    if (isObj(type)) {
      if (type.ptr) return 'null';
      return constructObjects ? `new C$${type.n}().$c$v()` : `new C$${type.n}()`;
    }
    return scalarDefault(type);
  }

  private withCtx<R>(fn: () => R, ctx?: FnCtx): R {
    const saved = this.current;
    this.current = ctx ?? this.current ?? { isStatic: true, scopes: [new Map()], temps: 0, funcName: '' };
    try {
      return fn();
    } finally {
      this.current = saved;
    }
  }

  private emitClass(info: ClassInfo): string {
    const lines: string[] = [];
    const ext = info.base ? info.base.js : '$.Obj';
    lines.push(`class ${info.js} extends ${ext} {`);

    // Raw construction: fields hold defaults, nested objects are allocated.
    const ctorLines: string[] = ['super();'];
    const assignLines: string[] = ['super.$assign(s);'];
    for (const field of info.fieldOrder) {
      if (field.isStatic) continue;
      const code = this.withCtx(() => this.defaultValueCode(field.type, field.declarator, false), {
        cls: info,
        isStatic: false,
        scopes: [new Map()],
        temps: 0,
        funcName: info.name,
      });
      ctorLines.push(`this.${field.js} = ${code};`);
      if (isArr(field.type)) assignLines.push(`this.${field.js} = s.${field.js}.clone();`);
      else if (isObj(field.type) && !field.type.ptr) assignLines.push(`this.${field.js}.$assign(s.${field.js});`);
      else assignLines.push(`this.${field.js} = s.${field.js};`);
    }
    lines.push(`constructor() { ${ctorLines.join(' ')} }`);
    lines.push(`$assign(s) { ${assignLines.join(' ')} return this; }`);
    lines.push(`$clone() { return new ${info.js}().$assign(this); }`);
    lines.push(`$reset() { return this.$assign(new ${info.js}()); }`);

    const hasDefaultCtor = info.ctors.some((c) => c.params.every((p) => p.defaultValue !== undefined));
    if (info.ctors.length === 0 || !info.ctors.some((c) => c.sig === 'v')) {
      // A parameterless entry point, used for automatic objects and array elements.
      const target = info.ctors.find((c) => c.params.every((p) => p.defaultValue !== undefined));
      if (target && target.sig !== 'v') {
        const args = target.params.map((p) => this.withCtx(() => this.convertArg(this.expr(p.defaultValue!), p)));
        lines.push(`$c$v() { return this.${target.js}(${args.join(', ')}); }`);
      } else if (!hasDefaultCtor || info.ctors.length === 0) {
        lines.push(`$c$v() { ${this.ctorPrologue(info, undefined).join(' ')} return this; }`);
      }
    }
    for (const ctor of info.ctors) {
      if (ctor.decl?.body || ctor.decl?.initList) lines.push(this.emitMethod(ctor, info));
      else lines.push(`${ctor.js}() { ${this.ctorPrologue(info, undefined).join(' ')} return this; }`);
    }
    if (info.dtor?.decl?.body) lines.push(this.emitMethod(info.dtor, info));
    for (const list of info.methods.values()) {
      for (const fn of list) {
        if (fn.decl?.body) lines.push(this.emitMethod(fn, info));
        else if (fn.isPure) lines.push(`${fn.js}() { throw new $.MqlRuntimeError("pure virtual function ${info.name}::${fn.name} called"); }`);
      }
    }
    lines.push('}');
    return lines.join('\n');
  }

  /** Base constructor, then member objects, then the initializer list — MQL5's construction order. */
  private ctorPrologue(info: ClassInfo, fn: FuncInfo | undefined): string[] {
    const out: string[] = [];
    const initList = fn?.decl?.initList ?? [];
    const baseInit = info.base ? initList.find((i) => i.name === info.base!.name) : undefined;
    if (info.base) {
      if (baseInit) {
        const args = baseInit.args.map((a) => this.expr(a));
        const ctor = this.pickOverload(info.base.ctors.length ? info.base.ctors : [], args, `${info.base.name} constructor`, baseInit.pos);
        this.recordCall(ctor);
        out.push(`${this.awaitIf(ctor)}super.${ctor.js}(${this.callArgs(ctor, args, baseInit.pos)});`);
      } else {
        out.push('super.$c$v();');
      }
    }
    for (const field of info.fieldOrder) {
      if (field.isStatic) continue;
      const init = initList.find((i) => i.name === field.name);
      if (isObj(field.type) && !field.type.ptr) {
        const cls = this.classes.get(field.type.n)!;
        if (init && init.args.length > 0) {
          const args = init.args.map((a) => this.expr(a));
          if (args.length === 1 && isObj(args[0]!.type) && args[0]!.type.n === field.type.n) {
            out.push(`this.${field.js}.$assign(${args[0]!.code});`);
          } else {
            const ctor = this.pickOverload(cls.ctors, args, `${cls.name} constructor`, init.pos);
            this.recordCall(ctor);
            out.push(`${this.awaitIf(ctor)}this.${field.js}.${ctor.js}(${this.callArgs(ctor, args, init.pos)});`);
          }
        } else {
          out.push(`this.${field.js}.$c$v();`);
        }
      } else if (init) {
        const value = init.args.length ? this.expr(init.args[0]!) : { code: scalarDefault(field.type), type: field.type };
        out.push(`this.${field.js} = ${convertCode(value.code, value.type, field.type)};`);
      }
    }
    return out;
  }

  private newCtx(fn: FuncInfo, cls?: ClassInfo): FnCtx {
    const scope = new Map<string, VarInfo>();
    for (const p of fn.params) {
      scope.set(p.name, { name: p.name, type: p.type, js: `v$${p.name}`, boxed: p.box });
    }
    return { fn, cls, isStatic: fn.isStatic || !cls, scopes: [scope], temps: 0, funcName: fn.name };
  }

  private emitBody(fn: FuncInfo, cls?: ClassInfo): { params: string; body: string } {
    const ctx = this.newCtx(fn, cls);
    const saved = this.current;
    this.current = ctx;
    try {
      const lines: string[] = [];
      for (const p of fn.params) {
        if (p.copyOnEntry) lines.push(`v$${p.name} = v$${p.name}.$clone();`);
      }
      if (fn.isCtor && cls) lines.push(...this.ctorPrologue(cls, fn));
      if (fn.decl?.body) {
        for (const stmt of fn.decl.body.body) lines.push(this.stmt(stmt));
      }
      if (fn.isCtor) lines.push('return this;');
      if (fn.isDtor && cls?.base) lines.push('super.$d();');
      const temps = ctx.temps > 0 ? `let ${Array.from({ length: ctx.temps }, (_, i) => `$t${i}`).join(', ')};` : '';
      return { params: fn.params.map((p) => `v$${p.name}`).join(', '), body: `${temps}\n${lines.join('\n')}` };
    } finally {
      this.current = saved;
    }
  }

  private emitFunction(fn: FuncInfo): string {
    const { params, body } = this.emitBody(fn);
    return `${fn.async ? 'async ' : ''}function ${fn.js}(${params}) {\n${body}\n}`;
  }

  private emitMethod(fn: FuncInfo, cls: ClassInfo): string {
    const { params, body } = this.emitBody(fn, cls);
    return `${fn.isStatic ? 'static ' : ''}${fn.async ? 'async ' : ''}${fn.js}(${params}) {\n${body}\n}`;
  }

  private emitInit(): string {
    const ctx: FnCtx = { isStatic: true, scopes: [new Map()], temps: 0, funcName: '' };
    const saved = this.current;
    this.current = ctx;
    const lines: string[] = [];
    const dtors: string[] = [];
    try {
      // Static members first: global initialisers may already use them.
      for (const cls of this.classes.values()) {
        for (const field of cls.fieldOrder) {
          if (field.isStatic) lines.push(`${field.js} = ${this.initializerCode(field.type, field.declarator)};`);
        }
      }
      for (const decl of this.globalDecls) {
        for (const declarator of decl.declarators) {
          const info = this.globals.get(declarator.name)!;
          lines.push(`$.ln = ${declarator.pos.line};`);
          if (decl.storage.input) {
            const initial = this.initializerCode(info.type, declarator);
            lines.push(`${info.js} = $.input($inputs, ${JSON.stringify(declarator.name)}, ${JSON.stringify(typeName(info.type))}, () => ${initial});`);
          } else {
            lines.push(`${info.js} = ${this.initializerCode(info.type, declarator)};`);
          }
          if (isObj(info.type) && !info.type.ptr) {
            const cls = this.classes.get(info.type.n);
            if (cls && this.hasDtor(cls)) dtors.unshift(`${info.js}.$d();`);
          }
        }
      }
      const temps = ctx.temps > 0 ? `let ${Array.from({ length: ctx.temps }, (_, i) => `$t${i}`).join(', ')};` : '';
      return `function $init($inputs) {\n${temps}\n${lines.join('\n')}\n}\nfunction $deinitGlobals() {\n${dtors.join('\n')}\n}`;
    } finally {
      this.current = saved;
    }
  }

  private hasDtor(cls: ClassInfo): boolean {
    let info: ClassInfo | undefined = cls;
    while (info) {
      if (info.dtor?.decl?.body) return true;
      info = info.base;
    }
    return false;
  }

  /** Initial value of a declared variable: its initializer, constructor arguments or default. */
  private initializerCode(type: Type, declarator: Declarator): string {
    const init = declarator.init;
    if (isArr(type)) {
      const base = this.defaultValueCode(type, declarator);
      if (!init) return base;
      if (init.kind !== 'InitList') this.fail('an array is initialised with { ... }', declarator.pos);
      const items = this.flattenInit(init).map((item) => {
        const e = this.expr(item);
        return convertCode(e.code, e.type, type.of);
      });
      return `$.arrInit(${base}, [${items.join(', ')}])`;
    }
    if (isObj(type) && !type.ptr) {
      const cls = this.classes.get(type.n)!;
      if (declarator.ctorArgs) {
        const args = declarator.ctorArgs.map((a) => this.expr(a));
        const ctor = this.pickOverload(cls.ctors, args, `${cls.name} constructor`, declarator.pos);
        this.recordCall(ctor);
        return `${this.awaitIf(ctor)}new ${cls.js}().${ctor.js}(${this.callArgs(ctor, args, declarator.pos)})`;
      }
      if (init && init.kind === 'InitList') return this.structInitList(cls, init);
      if (init) {
        const e = this.expr(init);
        if (isObj(e.type)) return `new ${cls.js}().$c$v().$assign(${e.code})`;
        // `CFoo obj = value;` calls the one-argument constructor.
        const ctor = this.pickOverload(cls.ctors, [e], `${cls.name} constructor`, declarator.pos);
        this.recordCall(ctor);
        return `${this.awaitIf(ctor)}new ${cls.js}().${ctor.js}(${this.callArgs(ctor, [e], declarator.pos)})`;
      }
      return `new ${cls.js}().$c$v()`;
    }
    if (!init) return this.defaultValueCode(type, declarator);
    if (init.kind === 'InitList') {
      if (init.items.length === 0) return scalarDefault(type);
      const first = init.items[0]!;
      if (first.kind === 'InitList') this.fail('nested initializer list for a scalar', declarator.pos);
      const e = this.expr(first);
      return convertCode(e.code, e.type, type);
    }
    const e = this.expr(init);
    return convertCode(e.code, e.type, type);
  }

  private flattenInit(list: InitList): Expr[] {
    const out: Expr[] = [];
    for (const item of list.items) {
      if (item.kind === 'InitList') out.push(...this.flattenInit(item));
      else out.push(item);
    }
    return out;
  }

  private structInitList(cls: ClassInfo, init: InitList): string {
    const fields = cls.fieldOrder.filter((f) => !f.isStatic);
    const parts: string[] = [];
    init.items.forEach((item, i) => {
      const field = fields[i];
      if (!field) return;
      if (item.kind === 'InitList') {
        if (isObj(field.type) && !field.type.ptr) {
          parts.push(`o.${field.js}.$assign(${this.structInitList(this.classes.get(field.type.n)!, item)});`);
        }
        return;
      }
      const e = this.expr(item);
      parts.push(`o.${field.js} = ${convertCode(e.code, e.type, field.type)};`);
    });
    if (parts.length === 0) return `new ${cls.js}().$c$v()`;
    return `((o) => { ${parts.join(' ')} return o; })(new ${cls.js}().$c$v())`;
  }

  /* ================================================================== */
  /* Scopes                                                              */
  /* ================================================================== */

  private ctx(): FnCtx {
    return this.current!;
  }

  private temp(): string {
    const ctx = this.ctx();
    const name = `$t${ctx.temps}`;
    ctx.temps += 1;
    return name;
  }

  private declareLocal(name: string, type: Type, js?: string): VarInfo {
    const ctx = this.ctx();
    const info: VarInfo = { name, type, js: js ?? `v$${name}` };
    ctx.scopes[ctx.scopes.length - 1]!.set(name, info);
    return info;
  }

  private lookupLocal(name: string): VarInfo | undefined {
    const ctx = this.current;
    if (!ctx) return undefined;
    for (let i = ctx.scopes.length - 1; i >= 0; i -= 1) {
      const found = ctx.scopes[i]!.get(name);
      if (found) return found;
    }
    return undefined;
  }

  private findField(cls: ClassInfo | undefined, name: string): FieldInfo | undefined {
    let info = cls;
    while (info) {
      const field = info.fields.get(name);
      if (field) return field;
      info = info.base;
    }
    return undefined;
  }

  private findMethods(cls: ClassInfo | undefined, name: string): FuncInfo[] {
    const out: FuncInfo[] = [];
    const seen = new Set<string>();
    let info = cls;
    while (info) {
      for (const m of info.methods.get(name) ?? []) {
        if (seen.has(m.sig)) continue;
        seen.add(m.sig);
        out.push(m);
      }
      info = info.base;
    }
    return out;
  }

  /** Every implementation a virtual call could land on. */
  private overridesOf(fn: FuncInfo): FuncInfo[] {
    const out = [fn];
    if (!fn.owner) return out;
    const walk = (info: ClassInfo): void => {
      for (const sub of info.subclasses) {
        for (const m of sub.methods.get(fn.name) ?? []) if (m.sig === fn.sig) out.push(m);
        walk(sub);
      }
    };
    walk(fn.owner);
    return out;
  }

  private recordCall(fn: FuncInfo): void {
    const caller = this.current?.fn;
    if (!caller) return;
    for (const target of this.overridesOf(fn)) caller.callees.add(target);
  }

  private awaitIf(fn: FuncInfo): string {
    if (!this.asyncKnown) return '';
    const anyAsync = this.overridesOf(fn).some((f) => f.async);
    if (!anyAsync) return '';
    const caller = this.current?.fn;
    if (!caller) {
      // Global initialisers run synchronously; an initializer that trades is not something MQL5 allows either.
      return '';
    }
    return 'await ';
  }

  /* ================================================================== */
  /* Statements                                                          */
  /* ================================================================== */

  private block(stmts: Stmt[]): string {
    const ctx = this.ctx();
    ctx.scopes.push(new Map());
    try {
      return stmts.map((s) => this.stmt(s)).join('\n');
    } finally {
      ctx.scopes.pop();
    }
  }

  private scoped(stmt: Stmt): string {
    if (stmt.kind === 'Block') return `{\n${this.block(stmt.body)}\n}`;
    const ctx = this.ctx();
    ctx.scopes.push(new Map());
    try {
      return `{\n${this.stmt(stmt)}\n}`;
    } finally {
      ctx.scopes.pop();
    }
  }

  private cond(e: Expr): string {
    const c = this.expr(e);
    if (isString(c.type)) return `(${c.code} !== "")`;
    return c.code;
  }

  private loopGuard(): string {
    return 'if (++$.ops > $.opsLimit) $.tooLong();';
  }

  private localDecl(decl: VarDecl): string {
    const lines: string[] = [];
    for (const declarator of decl.declarators) {
      const type = this.resolveTypeRef(decl.type, declarator.dims.length, this.templateScope(), declarator.pointer);
      if (decl.storage.static) {
        // Static locals live for the whole run: hoisted, initialised once.
        const id = this.staticCounter++;
        const js = `s$${id}$${declarator.name}`;
        const flag = `${js}$i`;
        this.staticDecls.push(`let ${js} = ${isObj(type) || isArr(type) ? 'null' : scalarDefault(type)}; let ${flag} = false;`);
        const init = this.initializerCode(type, declarator);
        lines.push(`if (!${flag}) { ${flag} = true; ${js} = ${init}; }`);
        this.declareLocal(declarator.name, type, js);
        continue;
      }
      const init = this.initializerCode(type, declarator);
      const info = this.declareLocal(declarator.name, type);
      lines.push(`let ${info.js} = ${init};`);
    }
    return lines.join('\n');
  }

  private templateScope(): string[] {
    const ctx = this.current;
    const out: string[] = [];
    if (ctx?.cls) out.push(...ctx.cls.templateParams);
    if (ctx?.fn?.decl?.template) out.push(...ctx.fn.decl.template);
    return out;
  }

  private stmt(stmt: Stmt): string {
    const line = `$.ln = ${stmt.pos.line};`;
    switch (stmt.kind) {
      case 'Block':
        return `{\n${this.block(stmt.body)}\n}`;
      case 'VarDecl':
        return `${line} ${this.localDecl(stmt)}`;
      case 'Enum':
        this.declareEnum(stmt);
        return '';
      case 'ExprStmt':
        return `${line} ${this.expr(stmt.expr, true).code};`;
      case 'If':
        return `${line} if (${this.cond(stmt.test)}) ${this.scoped(stmt.then)}${stmt.else ? ` else ${this.scoped(stmt.else)}` : ''}`;
      case 'While':
        return `${line} while (${this.cond(stmt.test)}) { ${this.loopGuard()} ${this.scoped(stmt.body)} }`;
      case 'DoWhile':
        return `${line} do { ${this.loopGuard()} ${this.scoped(stmt.body)} } while (${this.cond(stmt.test)});`;
      case 'For': {
        const ctx = this.ctx();
        ctx.scopes.push(new Map());
        try {
          let init = '';
          if (stmt.init) {
            if (stmt.init.kind === 'VarDecl') init = this.localDecl(stmt.init).replace(/;\s*$/, '');
            else init = this.expr(stmt.init, true).code;
          }
          // A `let` list in a for-header is one statement; multiple declarators came out as lines.
          init = init.replace(/;\nlet /g, ', ');
          const test = stmt.test ? this.cond(stmt.test) : '';
          const update = stmt.update ? this.expr(stmt.update, true).code : '';
          return `${line} for (${init}; ${test}; ${update}) { ${this.loopGuard()} ${this.scoped(stmt.body)} }`;
        } finally {
          ctx.scopes.pop();
        }
      }
      case 'Switch': {
        const d = this.expr(stmt.discriminant);
        const ctx = this.ctx();
        ctx.scopes.push(new Map());
        try {
          const cases = stmt.cases.map((c) => {
            const label = c.test ? `case ${this.caseValue(c.test)}:` : 'default:';
            return `${label}\n${c.body.map((s) => this.stmt(s)).join('\n')}`;
          });
          return `${line} switch (${d.code}) {\n${cases.join('\n')}\n}`;
        } finally {
          ctx.scopes.pop();
        }
      }
      case 'Break':
        return 'break;';
      case 'Continue':
        return 'continue;';
      case 'Return': {
        const fn = this.ctx().fn;
        if (fn?.isCtor) return 'return this;';
        if (!stmt.value) return `${line} return;`;
        const e = this.expr(stmt.value);
        const ret = fn?.ret ?? T.any;
        return `${line} return ${convertCode(e.code, e.type, ret)};`;
      }
      case 'Delete': {
        const e = this.expr(stmt.target);
        return `${line} $.del(${e.code});`;
      }
      case 'Empty':
        return '';
    }
  }

  private caseValue(test: Expr): string {
    const value = this.constEval(test);
    if (value === undefined) this.fail('a case label must be a constant', test.pos);
    return typeof value === 'number' ? String(value) : typeof value === 'boolean' ? String(Number(value)) : JSON.stringify(value);
  }

  /* ================================================================== */
  /* Expressions                                                         */
  /* ================================================================== */

  /** `discard` marks a statement-level expression whose value is unused. */
  expr(e: Expr, discard = false): CExpr {
    switch (e.kind) {
      case 'Number': {
        const code = Number.isFinite(e.value) ? String(e.value) : e.value > 0 ? 'Infinity' : '-Infinity';
        if (e.literal === 'datetime') return { code, type: T.datetime, constValue: e.value };
        if (e.literal === 'color') return { code, type: T.color, constValue: e.value };
        if (e.literal === 'char') return { code, type: T.ushort, constValue: e.value };
        if (e.float) return { code: code.includes('.') || code.includes('e') || code.includes('Infinity') ? code : `${code}`, type: T.double, constValue: e.value };
        return { code, type: Math.abs(e.value) > 2147483647 ? T.long : T.int, constValue: e.value };
      }
      case 'String':
        return { code: JSON.stringify(e.value), type: T.string, constValue: e.value };
      case 'Bool':
        return { code: String(e.value), type: T.bool, constValue: e.value };
      case 'Null':
        return { code: 'null', type: T.null };
      case 'This': {
        const ctx = this.ctx();
        if (!ctx.cls || ctx.isStatic) this.fail("'this' used outside a method", e.pos);
        return { code: 'this', type: { k: 'obj', n: ctx.cls.name, ptr: true } };
      }
      case 'Ident':
        return this.ident(e.name, e.pos);
      case 'Scoped':
        return this.scopedIdent(e.scope, e.name, e.pos);
      case 'Member':
        return this.member(e.object, e.name, e.pos);
      case 'Index':
        return this.index(e);
      case 'Call':
        return this.call(e.callee, e.args, e.pos);
      case 'Unary':
        return this.unary(e.op, e.arg, e.pos, discard);
      case 'Postfix':
        return this.incDec(e.arg, e.op === '++' ? 1 : -1, false, discard, e.pos);
      case 'Binary':
        return this.binary(e.op, e.left, e.right, e.pos);
      case 'Assign':
        return this.assign(e.op, e.target, e.value, e.pos);
      case 'Conditional': {
        const test = this.cond(e.test);
        const a = this.expr(e.consequent);
        const b = this.expr(e.alternate);
        let type: Type = a.type;
        if (isString(a.type) || isString(b.type)) type = T.string;
        else if (isNumeric(a.type) && isNumeric(b.type) && !sameType(a.type, b.type)) type = promote(a.type, b.type);
        else if (a.type.k === 'null') type = b.type;
        return { code: `(${test} ? ${convertCode(a.code, a.type, type)} : ${convertCode(b.code, b.type, type)})`, type };
      }
      case 'Cast':
        return this.cast(e.type, e.expr, e.pos);
      case 'New': {
        const type = this.resolveTypeRef(e.type, 0, this.templateScope());
        if (!isObj(type)) this.fail('new creates class objects only', e.pos);
        const cls = this.classes.get(type.n)!;
        const args = e.args.map((a) => this.expr(a));
        const t = this.temp();
        if (args.length === 0) return { code: `(${t} = new ${cls.js}(), ${t}.$dyn = true, ${t}.$c$v())`, type: { ...type, ptr: true } };
        const ctor = this.pickOverload(cls.ctors, args, `${cls.name} constructor`, e.pos);
        this.recordCall(ctor);
        return {
          code: `(${t} = new ${cls.js}(), ${t}.$dyn = true, ${this.awaitIf(ctor)}${t}.${ctor.js}(${this.callArgs(ctor, args, e.pos)}))`,
          type: { ...type, ptr: true },
        };
      }
      case 'Sizeof': {
        const type = e.type ? this.resolveTypeRef(e.type, 0, this.templateScope()) : this.expr(e.expr!).type;
        return { code: String(this.sizeOf(type)), type: T.int };
      }
      case 'Comma': {
        const parts = e.exprs.map((x) => this.expr(x, true));
        return { code: `(${parts.map((p) => p.code).join(', ')})`, type: parts[parts.length - 1]!.type };
      }
    }
  }

  private sizeOf(type: Type): number {
    if (type.k === 'prim') {
      switch (type.n) {
        case 'bool':
        case 'char':
        case 'uchar':
          return 1;
        case 'short':
        case 'ushort':
          return 2;
        case 'int':
        case 'uint':
        case 'color':
        case 'float':
          return 4;
        case 'string':
          return 12;
        default:
          return 8;
      }
    }
    if (type.k === 'enum') return 4;
    if (isObj(type)) {
      if (type.ptr) return 8;
      const cls = this.classes.get(type.n);
      return (cls?.fieldOrder ?? []).filter((f) => !f.isStatic).reduce((sum, f) => sum + this.sizeOf(f.type), 0);
    }
    return 8;
  }

  private ident(name: string, pos: Pos): CExpr {
    const local = this.lookupLocal(name);
    if (local) {
      if (local.boxed) return { code: `${local.js}.v`, type: local.type, lv: { k: 'box', code: local.js } };
      return { code: local.js, type: local.type, lv: { k: 'var', code: local.js } };
    }
    const ctx = this.current;
    if (ctx?.cls) {
      const field = this.findField(ctx.cls, name);
      if (field) {
        if (field.isStatic) return { code: field.js, type: field.type, lv: { k: 'var', code: field.js } };
        if (ctx.isStatic) this.fail(`instance member ${name} used in a static method`, pos);
        return { code: `this.${field.js}`, type: field.type, lv: { k: 'var', code: `this.${field.js}` } };
      }
    }
    const global = this.globals.get(name);
    if (global) {
      if (global.constValue !== undefined && typeof global.constValue !== 'object') {
        return { code: global.js, type: global.type, lv: { k: 'var', code: global.js }, constValue: global.constValue };
      }
      return { code: global.js, type: global.type, lv: { k: 'var', code: global.js } };
    }
    const member = this.enumMembers.get(name);
    if (member) return { code: String(member.value), type: { k: 'enum', n: member.enumName }, constValue: member.value };
    const predefined = PREDEFINED[name];
    if (predefined) {
      const lv: LValue | undefined = name === '_LastError' ? { k: 'var', code: '$._LastError' } : undefined;
      return { code: predefined.code, type: predefined.type, lv };
    }
    if (name === '__FUNCTION__') return { code: JSON.stringify(ctx?.funcName ?? ''), type: T.string };
    if (name === '__FUNCSIG__') return { code: JSON.stringify(ctx?.funcName ?? ''), type: T.string };
    const constant = this.constants.get(name);
    if (constant) {
      const type: Type = constant.enumName
        ? { k: 'enum', n: constant.enumName }
        : PRIMS.has(constant.type)
          ? prim(constant.type as Prim)
          : T.int;
      const code = typeof constant.value === 'string' ? JSON.stringify(constant.value) : constant.value === Number.MAX_VALUE ? 'Number.MAX_VALUE' : String(constant.value);
      return { code, type, constValue: constant.value };
    }
    this.fail(`'${name}' is not declared`, pos);
  }

  private scopedIdent(scope: string | null, name: string, pos: Pos): CExpr {
    if (scope === null) {
      const global = this.globals.get(name);
      if (global) return { code: global.js, type: global.type, lv: { k: 'var', code: global.js } };
      return this.ident(name, pos);
    }
    const member = this.enumMembers.get(`${scope}::${name}`) ?? (this.enums.has(scope) ? this.enumMembers.get(name) : undefined);
    if (member) return { code: String(member.value), type: { k: 'enum', n: member.enumName }, constValue: member.value };
    const cls = this.classes.get(scope);
    if (cls) {
      const field = this.findField(cls, name);
      if (field?.isStatic) return { code: field.js, type: field.type, lv: { k: 'var', code: field.js } };
      if (field) return { code: `this.${field.js}`, type: field.type, lv: { k: 'var', code: `this.${field.js}` } };
    }
    this.fail(`'${scope}::${name}' is not declared`, pos);
  }

  private objectOf(e: Expr): CExpr {
    const obj = this.expr(e);
    return obj;
  }

  private member(objectExpr: Expr, name: string, pos: Pos): CExpr {
    const obj = this.objectOf(objectExpr);
    if (!isObj(obj.type)) {
      if (obj.type.k === 'any') return { code: `${obj.code}.${fieldJs(name)}`, type: T.any, lv: { k: 'member', obj: obj.code, prop: fieldJs(name) } };
      this.fail(`'.${name}' used on a value of type ${typeName(obj.type)}`, pos);
    }
    const cls = this.classes.get(obj.type.n);
    const field = this.findField(cls, name);
    if (!field) this.fail(`${obj.type.n} has no member '${name}'`, pos);
    if (field.isStatic) return { code: field.js, type: field.type, lv: { k: 'var', code: field.js } };
    const simple = /^[A-Za-z_$][\w$]*(\.[\w$]+)*$/.test(obj.code);
    const code = `${obj.code}.${field.js}`;
    return { code, type: field.type, lv: simple ? { k: 'var', code } : { k: 'member', obj: obj.code, prop: field.js } };
  }

  private index(e: Extract<Expr, { kind: 'Index' }>): CExpr {
    const indices: Expr[] = [];
    let base: Expr = e;
    while (base.kind === 'Index') {
      indices.unshift(base.index);
      base = base.object;
    }
    const arr = this.expr(base);
    if (arr.type.k === 'any') {
      const idx = indices.map((i) => this.expr(i).code);
      return { code: `${arr.code}.getN(${idx.join(', ')})`, type: T.any, lv: { k: 'elem', arr: arr.code, idx } };
    }
    if (isString(arr.type)) this.fail('strings cannot be indexed in MQL5 — use StringGetCharacter', e.pos);
    if (!isArr(arr.type)) this.fail(`indexing a value of type ${typeName(arr.type)}`, e.pos);
    if (indices.length !== arr.type.dims) this.fail(`array has ${arr.type.dims} dimension(s) but ${indices.length} index(es) were given`, e.pos);
    const idx = indices.map((i) => {
      const c = this.expr(i);
      return isIntegral(c.type) ? c.code : `((${c.code})|0)`;
    });
    const code = idx.length === 1 ? `${arr.code}.get(${idx[0]})` : `${arr.code}.getN(${idx.join(', ')})`;
    return { code, type: arr.type.of, lv: { k: 'elem', arr: arr.code, idx } };
  }

  private cast(ref: TypeRef, inner: Expr, pos: Pos): CExpr {
    const to = this.resolveTypeRef(ref, 0, this.templateScope());
    const e = this.expr(inner);
    if (isObj(to)) {
      if (!isObj(e.type) && e.type.k !== 'null' && e.type.k !== 'any') this.fail(`cannot cast ${typeName(e.type)} to ${typeName(to)}`, pos);
      return { code: `$.dynCast(${e.code}, ${this.classes.get(to.n)!.js})`, type: { ...to, ptr: true } };
    }
    if (isString(to)) return { code: convertCode(e.code, e.type, to), type: to, constValue: e.constValue !== undefined ? String(e.constValue) : undefined };
    if (isPrim(to, 'bool')) return { code: `!!(${e.code})`, type: to };
    if (isFloat(to)) return { code: convertCode(e.code, e.type, to), type: to };
    // Explicit integer casts truncate even where the implicit rule would not bother.
    let code = convertCode(e.code, e.type, to);
    if (code === e.code && isFloat(e.type)) code = `$.toLong(${e.code})`;
    return { code, type: to };
  }

  /* ------------------------------------------------------------------ */
  /* Operators                                                           */
  /* ------------------------------------------------------------------ */

  private unary(op: string, argExpr: Expr, pos: Pos, discard: boolean): CExpr {
    if (op === '++' || op === '--') return this.incDec(argExpr, op === '++' ? 1 : -1, true, discard, pos);
    const a = this.expr(argExpr);
    switch (op) {
      case '!':
        return { code: `(!${isString(a.type) ? `(${a.code} !== "")` : `(${a.code})`})`, type: T.bool };
      case '-': {
        const type = isPrim(a.type, 'bool') || a.type.k === 'enum' ? T.int : a.type;
        if (isPrim(type, 'int')) return { code: `((-(${a.code}))|0)`, type };
        return { code: `(-(${a.code}))`, type };
      }
      case '+':
        return { code: `(+(${a.code}))`, type: isPrim(a.type, 'bool') ? T.int : a.type };
      case '~':
        if (is64(a.type)) return { code: `$.lnot(${a.code})`, type: a.type };
        return { code: `(~(${a.code}))`, type: isPrim(a.type, 'uint') ? T.uint : T.int };
      default:
        this.fail(`unsupported operator ${op}`, pos);
    }
  }

  /** Arithmetic on already-compiled operands, shared by `a op b` and `a op= b`. */
  private arith(op: string, l: CExpr, r: CExpr, pos: Pos): CExpr {
    if (op === '+' && (isString(l.type) || isString(r.type))) {
      const ls = isString(l.type) ? l.code : convertCode(l.code, l.type, T.string);
      const rs = isString(r.type) ? r.code : convertCode(r.code, r.type, T.string);
      return { code: `(${ls} + ${rs})`, type: T.string };
    }
    const lt = l.type.k === 'null' ? T.int : l.type;
    const rt = r.type.k === 'null' ? T.int : r.type;
    if (lt.k === 'any' || rt.k === 'any') {
      return { code: `(${l.code} ${op} ${r.code})`, type: T.any };
    }
    if (!isNumeric(lt) || !isNumeric(rt)) {
      this.fail(`operator ${op} cannot combine ${typeName(l.type)} and ${typeName(r.type)}`, pos);
    }
    const type = promote(lt, rt);
    const a = l.code;
    const b = r.code;
    switch (op) {
      case '+':
      case '-':
      case '*':
        if (isPrim(type, 'int')) return { code: `((${a} ${op} ${b})|0)`, type };
        if (isPrim(type, 'uint')) return { code: `((${a} ${op} ${b})>>>0)`, type };
        return { code: `(${a} ${op} ${b})`, type };
      case '/':
        if (isFloat(type)) return { code: `(${a} / ${b})`, type };
        if (isPrim(type, 'int')) return { code: `$.idiv(${a}, ${b})`, type };
        return { code: `$.ldiv(${a}, ${b})`, type };
      case '%':
        if (isFloat(type)) return { code: `(${a} % ${b})`, type };
        return { code: `$.imod(${a}, ${b})`, type };
      case '&':
      case '|':
      case '^':
        if (is64(type)) return { code: `$.l${op === '&' ? 'and' : op === '|' ? 'or' : 'xor'}(${a}, ${b})`, type };
        if (isPrim(type, 'uint')) return { code: `((${a} ${op} ${b})>>>0)`, type };
        return { code: `(${a} ${op} ${b})`, type: isFloat(type) ? T.long : type };
      case '<<':
        if (is64(lt)) return { code: `$.lshl(${a}, ${b})`, type: lt };
        return { code: `(${a} << ${b})`, type: isPrim(lt, 'uint') ? T.uint : T.int };
      case '>>':
        if (is64(lt)) return { code: `$.lshr(${a}, ${b})`, type: lt };
        if (isPrim(lt, 'uint') || isPrim(lt, 'ushort') || isPrim(lt, 'uchar')) return { code: `(${a} >>> ${b})`, type: lt };
        return { code: `(${a} >> ${b})`, type: T.int };
      default:
        this.fail(`unsupported operator ${op}`, pos);
    }
  }

  private binary(op: string, leftExpr: Expr, rightExpr: Expr, pos: Pos): CExpr {
    const l = this.expr(leftExpr);
    const r = this.expr(rightExpr);
    switch (op) {
      case '&&':
      case '||': {
        const a = isString(l.type) ? `(${l.code} !== "")` : l.code;
        const b = isString(r.type) ? `(${r.code} !== "")` : r.code;
        return { code: `(!!(${a}) ${op} !!(${b}))`, type: T.bool };
      }
      case '==':
      case '!=':
      case '<':
      case '>':
      case '<=':
      case '>=': {
        const strict = op === '==' ? '===' : op === '!=' ? '!==' : op;
        if (l.type.k === 'null' || r.type.k === 'null') {
          const other = l.type.k === 'null' ? r : l;
          if (isString(other.type)) return { code: `(${other.code} ${op === '==' ? '===' : '!=='} "")`, type: T.bool };
          if (isNumeric(other.type)) return { code: `(${other.code} ${strict} 0)`, type: T.bool };
          return { code: `(${other.code} ${op === '==' ? '==' : '!='} null)`, type: T.bool };
        }
        if (isString(l.type) !== isString(r.type) && (isString(l.type) || isString(r.type))) {
          const a = convertCode(l.code, l.type, T.string);
          const b = convertCode(r.code, r.type, T.string);
          return { code: `(${a} ${strict} ${b})`, type: T.bool };
        }
        const a = isPrim(l.type, 'bool') && !isPrim(r.type, 'bool') ? `(+${l.code})` : l.code;
        const b = isPrim(r.type, 'bool') && !isPrim(l.type, 'bool') ? `(+${r.code})` : r.code;
        return { code: `(${a} ${strict} ${b})`, type: T.bool };
      }
      default:
        return this.arith(op, l, r, pos);
    }
  }

  /** Writes `value` (already converted) to an l-value, returning the expression. */
  private store(lv: LValue, value: string): string {
    switch (lv.k) {
      case 'var':
        return `(${lv.code} = ${value})`;
      case 'box':
        return `(${lv.code}.v = ${value})`;
      case 'member': {
        const t = this.temp();
        return `((${t} = ${lv.obj}).${lv.prop} = ${value})`;
      }
      case 'elem':
        return lv.idx.length === 1 ? `${lv.arr}.set(${lv.idx[0]}, ${value})` : `${lv.arr}.setN(${value}, ${lv.idx.join(', ')})`;
    }
  }

  /**
   * Read-modify-write on an l-value with its object and index evaluated once.
   * `compute` receives the current value's code and returns the new value's.
   */
  private readModifyWrite(lv: LValue, type: Type, compute: (current: string) => string): string {
    switch (lv.k) {
      case 'var':
        return `(${lv.code} = ${compute(lv.code)})`;
      case 'box':
        return `(${lv.code}.v = ${compute(`${lv.code}.v`)})`;
      case 'member': {
        const t = this.temp();
        return `((${t} = ${lv.obj}), ${t}.${lv.prop} = ${compute(`${t}.${lv.prop}`)})`;
      }
      case 'elem': {
        const ta = this.temp();
        const ti = lv.idx.map(() => this.temp());
        const prep = [`${ta} = ${lv.arr}`, ...lv.idx.map((ix, i) => `${ti[i]} = ${ix}`)];
        const current = ti.length === 1 ? `${ta}.get(${ti[0]})` : `${ta}.getN(${ti.join(', ')})`;
        const write = ti.length === 1 ? `${ta}.set(${ti[0]}, ${compute(current)})` : `${ta}.setN(${compute(current)}, ${ti.join(', ')})`;
        void type;
        return `(${prep.join(', ')}, ${write})`;
      }
    }
  }

  private assign(op: string, targetExpr: Expr, valueExpr: Expr, pos: Pos): CExpr {
    const target = this.expr(targetExpr);
    if (!target.lv) this.fail('the left side of an assignment must be a variable, field or array element', pos);
    const value = this.expr(valueExpr);

    if (op === '=') {
      if (isObj(target.type) && !target.type.ptr) {
        if (!isObj(value.type)) this.fail(`cannot assign ${typeName(value.type)} to ${typeName(target.type)}`, pos);
        return { code: `${target.code}.$assign(${value.code})`, type: target.type };
      }
      if (isArr(target.type)) this.fail('arrays cannot be assigned — use ArrayCopy', pos);
      return { code: this.store(target.lv, convertCode(value.code, value.type, target.type)), type: target.type };
    }

    const binop = op.slice(0, -1);
    const code = this.readModifyWrite(target.lv, target.type, (current) => {
      const result = this.arith(binop, { code: current, type: target.type }, value, pos);
      return convertCode(result.code, result.type, target.type);
    });
    return { code, type: target.type };
  }

  private incDec(argExpr: Expr, delta: number, prefix: boolean, discard: boolean, pos: Pos): CExpr {
    const target = this.expr(argExpr);
    if (!target.lv) this.fail(`${delta > 0 ? '++' : '--'} needs a variable`, pos);
    const type = target.type;
    const step = (current: string): string => {
      const result = this.arith(delta > 0 ? '+' : '-', { code: current, type }, { code: '1', type: T.int }, pos);
      return convertCode(result.code, result.type, type);
    };
    if (prefix || discard) return { code: this.readModifyWrite(target.lv, type, step), type };
    // Postfix whose value is used: keep the old value.
    const old = this.temp();
    const code = this.readModifyWrite(target.lv, type, (current) => `(${old} = ${current}, ${step(old)})`);
    return { code: `(${code}, ${old})`, type };
  }

  /* ------------------------------------------------------------------ */
  /* Calls                                                               */
  /* ------------------------------------------------------------------ */

  /** Builds the argument list for a call, applying defaults, conversions and references. */
  private callArgs(fn: FuncInfo, args: CExpr[], pos: Pos): string {
    const out: string[] = [];
    fn.params.forEach((param, i) => {
      if (i < args.length) {
        out.push(this.convertArg(args[i]!, param));
      } else if (param.defaultValue !== undefined) {
        out.push(this.convertArg(this.withCtx(() => this.expr(param.defaultValue!)), param));
      } else {
        this.fail(`missing argument ${param.name} in call to ${fn.name}`, pos);
      }
    });
    if (fn.variadic) {
      for (let i = fn.params.length; i < args.length; i += 1) {
        const a = args[i]!;
        out.push(`[${a.code}, ${JSON.stringify(strTag(a.type))}]`);
      }
    }
    return out.join(', ');
  }

  private convertArg(arg: CExpr, param: ParamInfo): string {
    if (param.box) {
      if (!arg.lv) return `{ v: ${arg.code} }`;
      return this.refOf(arg.lv);
    }
    if (isObj(param.type) || isArr(param.type)) return arg.code;
    return convertCode(arg.code, arg.type, param.type);
  }

  private refOf(lv: LValue): string {
    switch (lv.k) {
      case 'box':
        return lv.code;
      case 'var':
        return `{ get v() { return ${lv.code}; }, set v($n) { ${lv.code} = $n; } }`;
      case 'member':
        return `(($o) => ({ get v() { return $o.${lv.prop}; }, set v($n) { $o.${lv.prop} = $n; } }))(${lv.obj})`;
      case 'elem':
        if (lv.idx.length === 1) {
          return `(($a, $i) => ({ get v() { return $a.get($i); }, set v($n) { $a.set($i, $n); } }))(${lv.arr}, ${lv.idx[0]})`;
        }
        return `(($a, ...$i) => ({ get v() { return $a.getN(...$i); }, set v($n) { $a.setN($n, ...$i); } }))(${lv.arr}, ${lv.idx.join(', ')})`;
    }
  }

  private intrinsic(name: string, argExprs: Expr[], pos: Pos): CExpr | null {
    switch (name) {
      case 'EnumToString': {
        const a = this.expr(argExprs[0]!);
        if (a.type.k === 'enum') {
          const info = this.enums.get(a.type.n);
          return { code: `$.enumStr(${info ? info.js : '{}'}, ${a.code})`, type: T.string };
        }
        return { code: `String(${a.code})`, type: T.string };
      }
      case 'CheckPointer': {
        const a = this.expr(argExprs[0]!);
        return { code: `$.checkPtr(${a.code})`, type: { k: 'enum', n: 'ENUM_POINTER_TYPE' } };
      }
      case 'GetPointer': {
        const a = this.expr(argExprs[0]!);
        return { code: a.code, type: isObj(a.type) ? { ...a.type, ptr: true } : a.type };
      }
      case 'ZeroMemory': {
        const a = this.expr(argExprs[0]!);
        if (isObj(a.type)) return { code: `${a.code}.$reset()`, type: T.void };
        if (isArr(a.type)) return { code: `$.zeroArray(${a.code})`, type: T.void };
        if (a.lv) return { code: this.store(a.lv, scalarDefault(a.type)), type: T.void };
        return { code: 'undefined', type: T.void };
      }
      case 'typename': {
        const a = this.expr(argExprs[0]!);
        return { code: JSON.stringify(typeName(a.type)), type: T.string };
      }
      default:
        return null;
    }
  }

  private call(calleeExpr: Expr, argExprs: Expr[], pos: Pos): CExpr {
    // obj.Method(...)
    if (calleeExpr.kind === 'Member') {
      const obj = this.expr(calleeExpr.object);
      if (!isObj(obj.type)) {
        if (obj.type.k === 'any') {
          const args = argExprs.map((a) => this.expr(a));
          return { code: `$.dynCall(${obj.code}, ${JSON.stringify(calleeExpr.name)}, [${args.map((a) => a.code).join(', ')}])`, type: T.any };
        }
        this.fail(`'${calleeExpr.name}' called on a value of type ${typeName(obj.type)}`, pos);
      }
      const cls = this.classes.get(obj.type.n)!;
      const methods = this.findMethods(cls, calleeExpr.name);
      if (methods.length === 0) this.fail(`${cls.name} has no method '${calleeExpr.name}'`, pos);
      const args = argExprs.map((a) => this.expr(a));
      const fn = this.pickOverload(methods, args, `${cls.name}::${calleeExpr.name}`, pos);
      this.recordCall(fn);
      const target = fn.isStatic ? fn.owner!.js : obj.code;
      return { code: `(${this.awaitIf(fn)}${target}.${fn.js}(${this.callArgs(fn, args, pos)}))`, type: fn.ret };
    }

    // Base::Method(...), Class::StaticMethod(...), ::GlobalFunction(...)
    if (calleeExpr.kind === 'Scoped') {
      const args = argExprs.map((a) => this.expr(a));
      if (calleeExpr.scope === null) return this.globalCall(calleeExpr.name, args, pos, true);
      const cls = this.classes.get(calleeExpr.scope);
      if (!cls) this.fail(`'${calleeExpr.scope}' is not a class`, pos);
      const methods = this.findMethods(cls, calleeExpr.name);
      if (methods.length === 0) this.fail(`${cls.name} has no method '${calleeExpr.name}'`, pos);
      const fn = this.pickOverload(methods, args, `${cls.name}::${calleeExpr.name}`, pos);
      this.recordCall(fn);
      const code = fn.isStatic
        ? `${fn.owner!.js}.${fn.js}(${this.callArgs(fn, args, pos)})`
        : `${fn.owner!.js}.prototype.${fn.js}.call(this${fn.params.length ? ', ' : ''}${this.callArgs(fn, args, pos)})`;
      return { code: `(${this.awaitIf(fn)}${code})`, type: fn.ret };
    }

    if (calleeExpr.kind !== 'Ident') this.fail('only named functions can be called', pos);
    const name = calleeExpr.name;

    const special = this.intrinsic(name, argExprs, pos);
    if (special) return special;

    const args = argExprs.map((a) => this.expr(a));

    // Implicit this: a method of the enclosing class wins over a global function.
    const ctx = this.current;
    if (ctx?.cls) {
      const methods = this.findMethods(ctx.cls, name);
      if (methods.length > 0) {
        const fn = this.pickOverload(methods, args, `${ctx.cls.name}::${name}`, pos);
        this.recordCall(fn);
        if (fn.isStatic) return { code: `(${this.awaitIf(fn)}${fn.owner!.js}.${fn.js}(${this.callArgs(fn, args, pos)}))`, type: fn.ret };
        if (ctx.isStatic) this.fail(`instance method ${name} called from a static method`, pos);
        return { code: `(${this.awaitIf(fn)}this.${fn.js}(${this.callArgs(fn, args, pos)}))`, type: fn.ret };
      }
    }
    return this.globalCall(name, args, pos, false);
  }

  private globalCall(name: string, args: CExpr[], pos: Pos, globalScope: boolean): CExpr {
    void globalScope;
    const user = this.functions.get(name);
    const natives = this.natives.get(name);
    if (!user && !natives) {
      const cls = this.classes.get(name);
      if (cls) {
        // Functional notation for a temporary object: CFoo(args).
        const ctor = this.pickOverload(cls.ctors, args, `${cls.name} constructor`, pos);
        this.recordCall(ctor);
        return { code: `(${this.awaitIf(ctor)}new ${cls.js}().${ctor.js}(${this.callArgs(ctor, args, pos)}))`, type: { k: 'obj', n: cls.name, ptr: false } };
      }
      this.fail(`'${name}' is not a function the web runtime knows. ` + unsupportedHint(name), pos);
    }
    const candidates = [...(user ?? []), ...(natives ?? [])];
    const fn = this.pickOverload(candidates, args, name, pos);
    this.recordCall(fn);
    let type = fn.ret;
    // Template functions return whatever their arguments were.
    if (fn.isTemplate && type.k === 'any' && args[0]) type = args[0].type;
    return { code: `(${this.awaitIf(fn)}${fn.js}(${this.callArgs(fn, args, pos)}))`, type };
  }
}

function unsupportedHint(name: string): string {
  if (/^(OrderSelect|OrderClose|OrderModify|OrderTicket|OrderLots|OrderOpenPrice|OrderType|OrdersHistoryTotal|MarketInfo|AccountBalance|AccountEquity|AccountFreeMargin|iMAOnArray|RefreshRates|IsTradeAllowed|IsTesting|DayOfWeek|Hour|Minute|TimeHour|TimeDay|TimeMinute|TimeDayOfWeek)$/.test(name)) {
    return 'It is an MQL4 function: this EA is MQL4 code and would not compile in MetaTrader 5 either.';
  }
  return 'If it comes from a .mqh file, upload that file together with the EA.';
}
