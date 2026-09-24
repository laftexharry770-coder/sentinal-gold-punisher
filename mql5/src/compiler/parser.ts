import type {
  Access,
  Block,
  ClassDecl,
  Declarator,
  EnumDecl,
  EnumMember,
  Expr,
  FunctionDecl,
  InitList,
  Param,
  Pos,
  Stmt,
  StorageFlags,
  TopLevel,
  TypeRef,
  VarDecl,
} from './ast.js';
import { MqlSyntaxError, type Token } from './lexer.js';

export const PRIMITIVE_TYPES = new Set([
  'void', 'bool', 'char', 'uchar', 'short', 'ushort', 'int', 'uint', 'long', 'ulong',
  'float', 'double', 'string', 'datetime', 'color',
]);

const UNSIGNED: Record<string, string> = { char: 'uchar', short: 'ushort', int: 'uint', long: 'ulong' };

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=']);

/** Binary operator precedence, loosest first. */
const BINARY_LEVELS: string[][] = [
  ['||'],
  ['&&'],
  ['|'],
  ['^'],
  ['&'],
  ['==', '!='],
  ['<', '<=', '>', '>='],
  ['<<', '>>'],
  ['+', '-'],
  ['*', '/', '%'],
];

export interface ParseOptions {
  /** Type names the program can use without declaring them (built-in enums). */
  builtinTypes: Set<string>;
  /** Trailing comments by file and line, for input and enum labels. */
  comments: Map<string, Map<number, string>>;
}

export class Parser {
  private pos = 0;
  private readonly types = new Set<string>();
  private templateParams: string[][] = [];
  private currentGroup: string | undefined;

  constructor(
    private readonly tokens: Token[],
    private readonly options: ParseOptions,
  ) {
    for (const name of options.builtinTypes) this.types.add(name);
    this.prescanTypes();
  }

  /* ------------------------------------------------------------------ */
  /* Token helpers                                                       */
  /* ------------------------------------------------------------------ */

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!;
  }

  private next(): Token {
    const token = this.peek();
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return token;
  }

  private at(text: string, offset = 0): boolean {
    const token = this.peek(offset);
    return (token.kind === 'op' || token.kind === 'ident') && token.text === text;
  }

  private accept(text: string): boolean {
    if (this.at(text)) {
      this.next();
      return true;
    }
    return false;
  }

  private expect(text: string): Token {
    if (!this.at(text)) this.fail(`expected '${text}' but found '${this.describe(this.peek())}'`);
    return this.next();
  }

  private ident(): Token {
    const token = this.peek();
    if (token.kind !== 'ident') this.fail(`expected a name but found '${this.describe(token)}'`);
    return this.next();
  }

  private describe(token: Token): string {
    if (token.kind === 'eof') return 'end of file';
    if (token.kind === 'string') return `"${token.text}"`;
    return token.text;
  }

  private posOf(token: Token): Pos {
    return { file: token.file, line: token.line, col: token.col };
  }

  private fail(message: string, token = this.peek()): never {
    const where = token.macro ? ` (in expansion of macro ${token.macro})` : '';
    throw new MqlSyntaxError(message + where, token.file, token.line, token.col);
  }

  private commentFor(token: Token): string | undefined {
    return this.options.comments.get(token.file)?.get(token.line);
  }

  /** Collects every class, struct, enum and typedef name up front, so use-before-declaration parses. */
  private prescanTypes(): void {
    for (let i = 0; i < this.tokens.length - 1; i += 1) {
      const t = this.tokens[i]!;
      if (t.kind !== 'ident') continue;
      if (t.text === 'class' || t.text === 'struct' || t.text === 'enum' || t.text === 'interface' || t.text === 'union') {
        const name = this.tokens[i + 1];
        if (name?.kind === 'ident') this.types.add(name.text);
      }
      if (t.text === 'typedef') {
        // typedef <type> Name;  — the name is the identifier before ';'.
        let j = i + 1;
        while (j < this.tokens.length && !(this.tokens[j]!.kind === 'op' && this.tokens[j]!.text === ';')) j += 1;
        const name = this.tokens[j - 1];
        if (name?.kind === 'ident') this.types.add(name.text);
      }
    }
  }

  private isTypeName(name: string): boolean {
    return PRIMITIVE_TYPES.has(name) || name === 'unsigned' || this.types.has(name) ||
      this.templateParams.some((scope) => scope.includes(name));
  }

  /* ------------------------------------------------------------------ */
  /* Types                                                               */
  /* ------------------------------------------------------------------ */

  private parseType(): TypeRef {
    const start = this.peek();
    let isConst = false;
    while (this.accept('const')) isConst = true;
    let nameToken = this.ident();
    let name = nameToken.text;
    if (name === 'unsigned') {
      const base = this.peek();
      if (base.kind === 'ident' && UNSIGNED[base.text]) {
        this.next();
        name = UNSIGNED[base.text]!;
      } else {
        name = 'uint';
      }
    }
    if (name === 'signed') name = this.ident().text;
    if (!this.isTypeName(name)) this.fail(`'${name}' is not a known type`, nameToken);

    let templateArgs: TypeRef[] | undefined;
    if (this.at('<') && this.types.has(name) && !PRIMITIVE_TYPES.has(name)) {
      this.next();
      templateArgs = [];
      do templateArgs.push(this.parseType());
      while (this.accept(','));
      this.expect('>');
    }
    while (this.accept('const')) isConst = true;
    let pointer = false;
    if (this.accept('*')) pointer = true;
    let ref = false;
    if (this.accept('&')) ref = true;
    while (this.accept('const')) isConst = true;
    nameToken = start;
    return { name, isConst, pointer, ref, templateArgs, pos: this.posOf(nameToken) };
  }

  /** True when a declaration (type followed by a name) starts at the cursor. */
  private looksLikeDeclaration(): boolean {
    let k = 0;
    while (this.at('const', k) || this.at('static', k)) k += 1;
    const first = this.peek(k);
    if (first.kind !== 'ident' || !this.isTypeName(first.text)) return false;
    k += 1;
    if (first.text === 'unsigned' && this.peek(k).kind === 'ident' && UNSIGNED[this.peek(k).text]) k += 1;
    if (this.at('<', k) && !PRIMITIVE_TYPES.has(first.text)) {
      let depth = 0;
      for (; k < 64; k += 1) {
        if (this.at('<', k)) depth += 1;
        if (this.at('>', k)) {
          depth -= 1;
          if (depth === 0) {
            k += 1;
            break;
          }
        }
      }
    }
    while (this.at('const', k)) k += 1;
    if (this.at('*', k) || this.at('&', k)) k += 1;
    while (this.at('const', k)) k += 1;
    return this.peek(k).kind === 'ident';
  }

  /* ------------------------------------------------------------------ */
  /* Top level                                                           */
  /* ------------------------------------------------------------------ */

  parseProgram(): TopLevel[] {
    const body: TopLevel[] = [];
    while (this.peek().kind !== 'eof') {
      if (this.accept(';')) continue;
      body.push(...this.parseTopLevel());
    }
    return body;
  }

  private parseTemplatePrefix(): string[] | undefined {
    if (!this.at('template')) return undefined;
    this.next();
    this.expect('<');
    const names: string[] = [];
    do {
      if (!this.accept('typename')) this.expect('class');
      names.push(this.ident().text);
    } while (this.accept(','));
    this.expect('>');
    return names;
  }

  private parseTopLevel(): TopLevel[] {
    const template = this.parseTemplatePrefix();
    if (template) this.templateParams.push(template);
    try {
      const token = this.peek();

      if (token.kind === 'ident' && (token.text === 'class' || token.text === 'struct' || token.text === 'interface' || token.text === 'union')) {
        // `struct Foo x;` declares a variable of an existing struct type.
        if (!(this.peek(2).kind === 'ident' && !this.at('{', 2) && !this.at(':', 2))) {
          const decl = this.parseClass(template);
          return decl ? [decl] : [];
        }
        this.next();
      }
      if (this.at('enum')) return [this.parseEnum()];
      if (this.at('typedef')) return [this.parseTypedef()];

      // `input group "Title"` sets the heading for the inputs that follow.
      if (this.at('input') && this.at('group', 1) && this.peek(2).kind === 'string') {
        const start = this.next();
        this.next();
        const title = this.next().text;
        this.accept(';');
        this.currentGroup = title;
        return [{ kind: 'InputGroup', title, pos: this.posOf(start) }];
      }

      const storage: StorageFlags = {};
      let isVirtual = false;
      for (;;) {
        if (this.accept('input')) storage.input = true;
        else if (this.accept('sinput')) {
          storage.input = true;
          storage.sinput = true;
        } else if (this.accept('extern')) storage.extern = true;
        else if (this.accept('static')) storage.static = true;
        else if (this.accept('virtual')) isVirtual = true;
        else if (this.accept('export')) {
          /* export only matters for libraries */
        } else break;
      }

      // Out-of-class constructor / destructor: Class::Class(...) / Class::~Class()
      if (this.peek().kind === 'ident' && this.at('::', 1) && (this.peek(2).text === this.peek().text || this.at('~', 2))) {
        return [this.parseOutOfClassSpecial(template)];
      }

      const type = this.parseType();

      // Out-of-class method: Type Class::Name(...), or a static member: Type Class::name = v;
      if (this.peek().kind === 'ident' && this.at('::', 1)) {
        const classToken = this.next();
        this.next();
        const nameToken = this.parseOperatorAwareName();
        if (!this.at('(')) {
          const decl = this.parseVarDeclRest(type, nameToken, storage);
          decl.staticOf = classToken.text;
          return [decl];
        }
        return [this.parseFunctionRest(type, nameToken, { className: classToken.text, template, isVirtual })];
      }

      const nameToken = this.parseOperatorAwareName();
      if (this.at('(') && this.looksLikeParameterList()) {
        return [this.parseFunctionRest(type, nameToken, { template, isVirtual, isStatic: storage.static })];
      }

      const decl = this.parseVarDeclRest(type, nameToken, storage);
      if (storage.input) decl.group = this.currentGroup;
      return [decl];
    } finally {
      if (template) this.templateParams.pop();
    }
  }

  private parseOperatorAwareName(): Token {
    const token = this.ident();
    if (token.text === 'operator') {
      this.fail('operator overloading is not supported by the web runtime', token);
    }
    return token;
  }

  /** Distinguishes `int F(int a)` (function) from `CFoo obj(1, 2)` (object with constructor args). */
  private looksLikeParameterList(): boolean {
    const after = this.peek(1);
    if (after.kind === 'op' && (after.text === ')' || after.text === '...')) return true;
    if (after.kind === 'ident' && (this.isTypeName(after.text) || after.text === 'const')) return true;
    return false;
  }

  private parseOutOfClassSpecial(template?: string[]): FunctionDecl {
    const classToken = this.next();
    this.expect('::');
    const isDtor = this.accept('~');
    const nameToken = this.ident();
    const voidType: TypeRef = { name: 'void', pos: this.posOf(classToken) };
    return this.parseFunctionRest(voidType, nameToken, {
      className: classToken.text,
      template,
      isCtor: !isDtor,
      isDtor,
    });
  }

  private parseParams(): Param[] {
    this.expect('(');
    const params: Param[] = [];
    if (this.at('void') && this.at(')', 1)) this.next();
    while (!this.at(')')) {
      // A variadic tail, used by the built-in function table.
      if (this.at('...')) {
        const dots = this.next();
        params.push({ type: { name: 'any', pos: this.posOf(dots) }, name: '__variadic__', dims: 0, pos: this.posOf(dots) });
        break;
      }
      const type = this.parseType();
      const nameToken = this.peek().kind === 'ident' ? this.next() : null;
      let dims = 0;
      while (this.accept('[')) {
        // `double arr[]` or `double arr[][4]` — sizes after the first are layout, not length.
        while (!this.at(']')) this.next();
        this.expect(']');
        dims += 1;
      }
      let defaultValue: Expr | undefined;
      if (this.accept('=')) defaultValue = this.parseAssignment();
      params.push({
        type,
        name: nameToken?.text ?? `$unnamed${params.length}`,
        dims,
        defaultValue,
        pos: type.pos,
      });
      if (!this.accept(',')) break;
    }
    this.expect(')');
    return params;
  }

  private parseFunctionRest(
    returnType: TypeRef,
    nameToken: Token,
    extra: Partial<FunctionDecl>,
  ): FunctionDecl {
    const params = this.parseParams();
    const decl: FunctionDecl = {
      kind: 'Function',
      name: nameToken.text,
      returnType,
      params,
      body: null,
      pos: this.posOf(nameToken),
      ...extra,
    };
    for (;;) {
      if (this.accept('const')) decl.isConst = true;
      else if (this.accept('override') || this.accept('final')) {
        /* documentation only */
      } else break;
    }
    if (this.accept(':')) {
      decl.initList = [];
      do {
        const member = this.ident();
        this.expect('(');
        const args = this.parseArgs(')');
        decl.initList.push({ name: member.text, args, pos: this.posOf(member) });
      } while (this.accept(','));
    }
    if (this.accept('=')) {
      const zero = this.next();
      if (zero.text !== '0') this.fail('expected = 0 for a pure virtual method', zero);
      decl.isPure = true;
      this.expect(';');
      return decl;
    }
    if (this.accept(';')) return decl;
    decl.body = this.parseBlock();
    return decl;
  }

  private parseEnum(): EnumDecl {
    const start = this.expect('enum');
    const name = this.ident().text;
    this.expect('{');
    const members: EnumMember[] = [];
    while (!this.at('}')) {
      const memberToken = this.ident();
      let value: Expr | undefined;
      if (this.accept('=')) value = this.parseConditional();
      const comma = this.at(',') ? this.peek() : memberToken;
      // The label is the comment on the member's own line.
      const comment = this.commentFor(comma) ?? this.commentFor(memberToken);
      members.push({ name: memberToken.text, value, comment, pos: this.posOf(memberToken) });
      if (!this.accept(',')) break;
    }
    this.expect('}');
    this.accept(';');
    return { kind: 'Enum', name, members, pos: this.posOf(start) };
  }

  private parseTypedef(): TopLevel {
    const start = this.expect('typedef');
    // Function-pointer typedefs: typedef int (*Name)(int, int);
    if (this.peek(1).kind === 'op' && this.peek(1).text === '(') {
      const returnType = this.parseType();
      this.expect('(');
      this.expect('*');
      const name = this.ident().text;
      this.expect(')');
      this.parseParams();
      this.expect(';');
      return { kind: 'Typedef', name, type: { ...returnType, name: '$function' }, pos: this.posOf(start) };
    }
    const type = this.parseType();
    const name = this.ident().text;
    this.expect(';');
    return { kind: 'Typedef', name, type, pos: this.posOf(start) };
  }

  private parseClass(template?: string[]): ClassDecl | null {
    const keyword = this.next();
    const nameToken = this.ident();
    // Forward declaration.
    if (this.accept(';')) return null;

    let base: string | undefined;
    if (this.accept(':')) {
      this.accept('public') || this.accept('protected') || this.accept('private');
      base = this.ident().text;
      if (this.at('<')) {
        // Template base — keep the name, ignore arguments.
        let depth = 0;
        do {
          if (this.at('<')) depth += 1;
          if (this.at('>')) depth -= 1;
          this.next();
        } while (depth > 0);
      }
    }
    this.expect('{');
    const isStruct = keyword.text === 'struct' || keyword.text === 'union';
    let access: Access = isStruct ? 'public' : 'private';
    const members: ClassDecl['members'] = [];

    while (!this.at('}')) {
      if (this.accept(';')) continue;
      if ((this.at('public') || this.at('private') || this.at('protected')) && this.at(':', 1)) {
        access = this.next().text as Access;
        this.next();
        continue;
      }
      if (this.at('enum')) {
        members.push(this.parseEnum());
        continue;
      }
      if ((this.at('struct') || this.at('class')) && this.peek(1).kind === 'ident' && (this.at('{', 2) || this.at(':', 2))) {
        const nested = this.parseClass();
        if (nested) members.push(nested);
        continue;
      }
      const memberTemplate = this.parseTemplatePrefix();
      if (memberTemplate) this.templateParams.push(memberTemplate);
      try {
        let isVirtual = false;
        let isStatic = false;
        const storage: StorageFlags = {};
        for (;;) {
          if (this.accept('virtual')) isVirtual = true;
          else if (this.accept('static')) {
            isStatic = true;
            storage.static = true;
          } else break;
        }

        // Destructor.
        if (this.at('~')) {
          this.next();
          const dtorName = this.ident();
          const voidType: TypeRef = { name: 'void', pos: this.posOf(dtorName) };
          const decl = this.parseFunctionRest(voidType, dtorName, {
            className: nameToken.text,
            isDtor: true,
            isVirtual,
            access,
          });
          members.push(decl);
          continue;
        }

        // Constructor: Name( ... )
        if (this.peek().kind === 'ident' && this.peek().text === nameToken.text && this.at('(', 1)) {
          const ctorName = this.next();
          const voidType: TypeRef = { name: 'void', pos: this.posOf(ctorName) };
          members.push(
            this.parseFunctionRest(voidType, ctorName, { className: nameToken.text, isCtor: true, access }),
          );
          continue;
        }

        const type = this.parseType();
        const memberName = this.parseOperatorAwareName();
        if (this.at('(')) {
          members.push(
            this.parseFunctionRest(type, memberName, {
              className: nameToken.text,
              isVirtual,
              isStatic,
              access,
              template: memberTemplate,
            }),
          );
          continue;
        }
        const decl = this.parseVarDeclRest(type, memberName, storage);
        decl.access = access;
        members.push(decl);
      } finally {
        if (memberTemplate) this.templateParams.pop();
      }
    }
    this.expect('}');
    this.accept(';');
    return {
      kind: 'Class',
      name: nameToken.text,
      isStruct,
      isInterface: keyword.text === 'interface',
      base,
      members,
      template,
      pos: this.posOf(keyword),
    };
  }

  private parseDeclarator(nameToken: Token, pointer: boolean): Declarator {
    const dims: (Expr | null)[] = [];
    while (this.accept('[')) {
      if (this.accept(']')) {
        dims.push(null);
        continue;
      }
      dims.push(this.parseExpression());
      this.expect(']');
    }
    const declarator: Declarator = { name: nameToken.text, dims, pointer, pos: this.posOf(nameToken) };
    if (this.accept('=')) {
      declarator.init = this.at('{') ? this.parseInitList() : this.parseAssignment();
    } else if (this.at('(')) {
      this.next();
      declarator.ctorArgs = this.parseArgs(')');
    }
    return declarator;
  }

  private parseVarDeclRest(type: TypeRef, firstName: Token, storage: StorageFlags): VarDecl {
    const declarators: Declarator[] = [this.parseDeclarator(firstName, Boolean(type.pointer))];
    while (this.accept(',')) {
      const pointer = this.accept('*');
      this.accept('&');
      declarators.push(this.parseDeclarator(this.ident(), pointer || Boolean(type.pointer)));
    }
    const end = this.expect(';');
    const decl: VarDecl = {
      kind: 'VarDecl',
      type,
      declarators,
      storage: { ...storage, const: storage.const || type.isConst },
      pos: this.posOf(firstName),
    };
    const comment = this.commentFor(end) ?? this.commentFor(firstName);
    if (comment) decl.comment = comment;
    return decl;
  }

  private parseInitList(): InitList {
    const start = this.expect('{');
    const items: (Expr | InitList)[] = [];
    while (!this.at('}')) {
      items.push(this.at('{') ? this.parseInitList() : this.parseAssignment());
      if (!this.accept(',')) break;
    }
    this.expect('}');
    return { kind: 'InitList', items, pos: this.posOf(start) };
  }

  /* ------------------------------------------------------------------ */
  /* Statements                                                          */
  /* ------------------------------------------------------------------ */

  private parseBlock(): Block {
    const start = this.expect('{');
    const body: Stmt[] = [];
    while (!this.at('}')) {
      if (this.peek().kind === 'eof') this.fail("missing '}'", start);
      body.push(this.parseStatement());
    }
    this.expect('}');
    return { kind: 'Block', body, pos: this.posOf(start) };
  }

  private parseLocalDecl(): VarDecl {
    const storage: StorageFlags = {};
    for (;;) {
      if (this.accept('static')) storage.static = true;
      else break;
    }
    const type = this.parseType();
    const name = this.ident();
    return this.parseVarDeclRest(type, name, storage);
  }

  private parseStatement(): Stmt {
    const token = this.peek();
    const pos = this.posOf(token);

    if (token.kind === 'op') {
      if (token.text === '{') return this.parseBlock();
      if (token.text === ';') {
        this.next();
        return { kind: 'Empty', pos };
      }
    }

    if (token.kind === 'ident') {
      switch (token.text) {
        case 'if': {
          this.next();
          this.expect('(');
          const test = this.parseExpression();
          this.expect(')');
          const then = this.parseStatement();
          const alt = this.accept('else') ? this.parseStatement() : undefined;
          return { kind: 'If', test, then, else: alt, pos };
        }
        case 'for': {
          this.next();
          this.expect('(');
          let init: VarDecl | Expr | undefined;
          if (!this.at(';')) {
            if (this.looksLikeDeclaration()) {
              init = this.parseLocalDecl();
            } else {
              init = this.parseExpression();
              this.expect(';');
            }
          } else {
            this.next();
          }
          const test = this.at(';') ? undefined : this.parseExpression();
          this.expect(';');
          const update = this.at(')') ? undefined : this.parseExpression();
          this.expect(')');
          const body = this.parseStatement();
          return { kind: 'For', init, test, update, body, pos };
        }
        case 'while': {
          this.next();
          this.expect('(');
          const test = this.parseExpression();
          this.expect(')');
          return { kind: 'While', test, body: this.parseStatement(), pos };
        }
        case 'do': {
          this.next();
          const body = this.parseStatement();
          this.expect('while');
          this.expect('(');
          const test = this.parseExpression();
          this.expect(')');
          this.accept(';');
          return { kind: 'DoWhile', body, test, pos };
        }
        case 'switch': {
          this.next();
          this.expect('(');
          const discriminant = this.parseExpression();
          this.expect(')');
          this.expect('{');
          const cases: { test: Expr | null; body: Stmt[]; pos: Pos }[] = [];
          while (!this.at('}')) {
            const caseToken = this.peek();
            let test: Expr | null;
            if (this.accept('case')) {
              test = this.parseConditional();
            } else if (this.accept('default')) {
              test = null;
            } else {
              this.fail(`expected 'case' or 'default' but found '${this.describe(caseToken)}'`);
            }
            this.expect(':');
            const body: Stmt[] = [];
            while (!this.at('case') && !this.at('default') && !this.at('}')) body.push(this.parseStatement());
            cases.push({ test, body, pos: this.posOf(caseToken) });
          }
          this.expect('}');
          return { kind: 'Switch', discriminant, cases, pos };
        }
        case 'break':
          this.next();
          this.expect(';');
          return { kind: 'Break', pos };
        case 'continue':
          this.next();
          this.expect(';');
          return { kind: 'Continue', pos };
        case 'return': {
          this.next();
          if (this.accept(';')) return { kind: 'Return', pos };
          const value = this.parseExpression();
          this.expect(';');
          return { kind: 'Return', value, pos };
        }
        case 'delete': {
          this.next();
          const target = this.parseUnary();
          this.expect(';');
          return { kind: 'Delete', target, pos };
        }
        case 'enum':
          return this.parseEnum();
        case 'goto':
          this.fail('goto is not part of MQL5');
      }

      if (token.text === 'static' || token.text === 'const' || this.looksLikeDeclaration()) {
        return this.parseLocalDecl();
      }
    }

    const expr = this.parseExpression();
    this.expect(';');
    return { kind: 'ExprStmt', expr, pos };
  }

  /* ------------------------------------------------------------------ */
  /* Expressions                                                         */
  /* ------------------------------------------------------------------ */

  parseExpression(): Expr {
    const first = this.parseAssignment();
    if (!this.at(',')) return first;
    const exprs = [first];
    while (this.accept(',')) exprs.push(this.parseAssignment());
    return { kind: 'Comma', exprs, pos: first.pos };
  }

  private parseArgs(close: string): Expr[] {
    const args: Expr[] = [];
    while (!this.at(close)) {
      args.push(this.parseAssignment());
      if (!this.accept(',')) break;
    }
    this.expect(close);
    return args;
  }

  private parseAssignment(): Expr {
    const target = this.parseConditional();
    const token = this.peek();
    if (token.kind === 'op' && ASSIGN_OPS.has(token.text)) {
      this.next();
      const value = this.parseAssignment();
      return { kind: 'Assign', op: token.text, target, value, pos: this.posOf(token) };
    }
    return target;
  }

  private parseConditional(): Expr {
    const test = this.parseBinary(0);
    if (!this.at('?')) return test;
    const q = this.next();
    const consequent = this.parseAssignment();
    this.expect(':');
    const alternate = this.parseAssignment();
    return { kind: 'Conditional', test, consequent, alternate, pos: this.posOf(q) };
  }

  private parseBinary(level: number): Expr {
    if (level >= BINARY_LEVELS.length) return this.parseUnary();
    let left = this.parseBinary(level + 1);
    const ops = BINARY_LEVELS[level]!;
    for (;;) {
      const token = this.peek();
      if (token.kind !== 'op' || !ops.includes(token.text)) break;
      this.next();
      const right = this.parseBinary(level + 1);
      left = { kind: 'Binary', op: token.text, left, right, pos: this.posOf(token) };
    }
    return left;
  }

  /** True when `( Type )` or `( Type * )` starts at the cursor. */
  private looksLikeCast(): boolean {
    if (!this.at('(')) return false;
    let k = 1;
    while (this.at('const', k)) k += 1;
    const t = this.peek(k);
    if (t.kind !== 'ident' || !this.isTypeName(t.text)) return false;
    k += 1;
    if (t.text === 'unsigned' && this.peek(k).kind === 'ident' && UNSIGNED[this.peek(k).text]) k += 1;
    if (this.at('*', k)) k += 1;
    return this.at(')', k);
  }

  private parseUnary(): Expr {
    const token = this.peek();
    const pos = this.posOf(token);
    if (token.kind === 'op') {
      if (token.text === '!' || token.text === '~' || token.text === '-' || token.text === '+') {
        this.next();
        const arg = this.parseUnary();
        // Fold negative literals so `-1` is a constant rather than an operation.
        if (token.text === '-' && arg.kind === 'Number' && !arg.literal) {
          return { ...arg, value: -arg.value, pos };
        }
        return { kind: 'Unary', op: token.text, arg, pos };
      }
      if (token.text === '++' || token.text === '--') {
        this.next();
        return { kind: 'Unary', op: token.text, arg: this.parseUnary(), pos };
      }
      if (token.text === '&') {
        // `&obj` — MQL5 accepts address-of on objects, meaning a pointer to them.
        this.next();
        return this.parseUnary();
      }
      if (token.text === '*' ) {
        // Dereference of a pointer is a no-op here: pointers and objects are the same reference.
        this.next();
        return this.parseUnary();
      }
      if (this.looksLikeCast()) {
        this.next();
        const type = this.parseType();
        this.expect(')');
        const expr = this.parseUnary();
        return { kind: 'Cast', type, expr, pos };
      }
    }
    if (token.kind === 'ident' && token.text === 'new') {
      this.next();
      const type = this.parseType();
      const args = this.accept('(') ? this.parseArgs(')') : [];
      return this.parsePostfix({ kind: 'New', type, args, pos });
    }
    if (token.kind === 'ident' && token.text === 'sizeof') {
      this.next();
      this.expect('(');
      if (this.looksLikeDeclaration() || (this.peek().kind === 'ident' && this.isTypeName(this.peek().text) && this.at(')', 1))) {
        const type = this.parseType();
        this.expect(')');
        return { kind: 'Sizeof', type, pos };
      }
      const expr = this.parseExpression();
      this.expect(')');
      return { kind: 'Sizeof', expr, pos };
    }
    return this.parsePostfix(this.parsePrimary());
  }

  private parsePostfix(base: Expr): Expr {
    let expr = base;
    for (;;) {
      const token = this.peek();
      if (token.kind !== 'op') break;
      const pos = this.posOf(token);
      if (token.text === '(') {
        this.next();
        expr = { kind: 'Call', callee: expr, args: this.parseArgs(')'), pos };
      } else if (token.text === '[') {
        this.next();
        const index = this.parseExpression();
        this.expect(']');
        expr = { kind: 'Index', object: expr, index, pos };
      } else if (token.text === '.' || token.text === '->') {
        this.next();
        const name = this.ident();
        expr = { kind: 'Member', object: expr, name: name.text, pos: this.posOf(name) };
      } else if (token.text === '++' || token.text === '--') {
        this.next();
        expr = { kind: 'Postfix', op: token.text, arg: expr, pos };
      } else {
        break;
      }
    }
    return expr;
  }

  private parsePrimary(): Expr {
    const token = this.next();
    const pos = this.posOf(token);
    switch (token.kind) {
      case 'number':
        return { kind: 'Number', value: token.value ?? 0, float: Boolean(token.float), literal: token.literal, pos };
      case 'char':
        return { kind: 'Number', value: token.value ?? 0, float: false, literal: 'char', pos };
      case 'string': {
        // Adjacent literals concatenate, as in C.
        let value = token.text;
        while (this.peek().kind === 'string') value += this.next().text;
        return { kind: 'String', value, pos };
      }
      case 'op':
        if (token.text === '(') {
          const expr = this.parseExpression();
          this.expect(')');
          return expr;
        }
        if (token.text === '::') {
          const name = this.ident();
          return { kind: 'Scoped', scope: null, name: name.text, pos };
        }
        if (token.text === '{') {
          this.fail('initializer lists are only allowed in declarations', token);
        }
        this.fail(`unexpected '${this.describe(token)}'`, token);
      // eslint-disable-next-line no-fallthrough
      case 'ident': {
        switch (token.text) {
          case 'true':
            return { kind: 'Bool', value: true, pos };
          case 'false':
            return { kind: 'Bool', value: false, pos };
          case 'NULL':
            return { kind: 'Null', pos };
          case 'this':
            return { kind: 'This', pos };
        }
        // Functional cast: double(x), int(x), string(x)
        if (PRIMITIVE_TYPES.has(token.text) && this.at('(')) {
          this.next();
          const expr = this.parseExpression();
          this.expect(')');
          return { kind: 'Cast', type: { name: token.text, pos }, expr, pos };
        }
        if (this.at('::')) {
          this.next();
          const name = this.accept('~') ? `~${this.ident().text}` : this.ident().text;
          return { kind: 'Scoped', scope: token.text, name, pos };
        }
        // Template function call: Name<Type>(args) — the explicit arguments are inferred anyway.
        return { kind: 'Ident', name: token.text, pos };
      }
      default:
        this.fail(`unexpected '${this.describe(token)}'`, token);
    }
  }
}
