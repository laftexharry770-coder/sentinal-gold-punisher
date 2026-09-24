/** Abstract syntax tree for MQL5 programs. */

export interface Pos {
  file: string;
  line: number;
  col: number;
}

export interface TypeRef {
  name: string;
  isConst?: boolean;
  /** `CFoo *` — a pointer to a class object. */
  pointer?: boolean;
  /** `double &x` — a reference parameter. */
  ref?: boolean;
  /** `Name<A,B>` for template instantiations. */
  templateArgs?: TypeRef[];
  pos: Pos;
}

export interface InitList {
  kind: 'InitList';
  items: (Expr | InitList)[];
  pos: Pos;
}

export interface Declarator {
  name: string;
  /** One entry per `[...]`; null for an unsized (dynamic) dimension. */
  dims: (Expr | null)[];
  init?: Expr | InitList;
  /** `CFoo obj(1, 2);` */
  ctorArgs?: Expr[];
  pointer?: boolean;
  pos: Pos;
}

export interface StorageFlags {
  input?: boolean;
  sinput?: boolean;
  extern?: boolean;
  static?: boolean;
  const?: boolean;
}

export interface VarDecl {
  kind: 'VarDecl';
  type: TypeRef;
  declarators: Declarator[];
  storage: StorageFlags;
  /** Trailing `// comment` — the input's display name in MetaTrader. */
  comment?: string;
  /** The `input group` this input sits under, if any. */
  group?: string;
  access?: Access;
  /** `int CFoo::count = 0;` — the out-of-class definition of a static member. */
  staticOf?: string;
  pos: Pos;
}

export type Access = 'public' | 'protected' | 'private';

export interface Param {
  type: TypeRef;
  name: string;
  /** Number of `[]` after the name — array parameters are always by reference. */
  dims: number;
  defaultValue?: Expr;
  pos: Pos;
}

export interface FunctionDecl {
  kind: 'Function';
  name: string;
  /** Set for methods, whether declared inside the class or defined as `Class::Name`. */
  className?: string;
  returnType: TypeRef;
  params: Param[];
  body: Block | null;
  isConst?: boolean;
  isVirtual?: boolean;
  isStatic?: boolean;
  isPure?: boolean;
  isCtor?: boolean;
  isDtor?: boolean;
  initList?: { name: string; args: Expr[]; pos: Pos }[];
  template?: string[];
  access?: Access;
  pos: Pos;
}

export interface EnumMember {
  name: string;
  value?: Expr;
  comment?: string;
  pos: Pos;
}

export interface EnumDecl {
  kind: 'Enum';
  name: string;
  members: EnumMember[];
  pos: Pos;
}

export interface ClassDecl {
  kind: 'Class';
  name: string;
  isStruct: boolean;
  isInterface: boolean;
  base?: string;
  members: (VarDecl | FunctionDecl | EnumDecl | ClassDecl)[];
  template?: string[];
  pos: Pos;
}

export interface InputGroup {
  kind: 'InputGroup';
  title: string;
  pos: Pos;
}

export interface Typedef {
  kind: 'Typedef';
  name: string;
  type: TypeRef;
  pos: Pos;
}

export type TopLevel = VarDecl | FunctionDecl | EnumDecl | ClassDecl | InputGroup | Typedef;

/* ------------------------------------------------------------------ */
/* Statements                                                          */
/* ------------------------------------------------------------------ */

export interface Block {
  kind: 'Block';
  body: Stmt[];
  pos: Pos;
}

export type Stmt =
  | Block
  | VarDecl
  | { kind: 'ExprStmt'; expr: Expr; pos: Pos }
  | { kind: 'If'; test: Expr; then: Stmt; else?: Stmt; pos: Pos }
  | { kind: 'For'; init?: VarDecl | Expr; test?: Expr; update?: Expr; body: Stmt; pos: Pos }
  | { kind: 'While'; test: Expr; body: Stmt; pos: Pos }
  | { kind: 'DoWhile'; body: Stmt; test: Expr; pos: Pos }
  | { kind: 'Switch'; discriminant: Expr; cases: { test: Expr | null; body: Stmt[]; pos: Pos }[]; pos: Pos }
  | { kind: 'Break'; pos: Pos }
  | { kind: 'Continue'; pos: Pos }
  | { kind: 'Return'; value?: Expr; pos: Pos }
  | { kind: 'Delete'; target: Expr; pos: Pos }
  | { kind: 'Empty'; pos: Pos }
  | EnumDecl;

/* ------------------------------------------------------------------ */
/* Expressions                                                         */
/* ------------------------------------------------------------------ */

export type Expr =
  | { kind: 'Number'; value: number; float: boolean; literal?: 'datetime' | 'color' | 'char'; pos: Pos }
  | { kind: 'String'; value: string; pos: Pos }
  | { kind: 'Bool'; value: boolean; pos: Pos }
  | { kind: 'Null'; pos: Pos }
  | { kind: 'Ident'; name: string; pos: Pos }
  | { kind: 'This'; pos: Pos }
  | { kind: 'Scoped'; scope: string | null; name: string; pos: Pos }
  | { kind: 'Unary'; op: '!' | '~' | '-' | '+' | '++' | '--'; arg: Expr; pos: Pos }
  | { kind: 'Postfix'; op: '++' | '--'; arg: Expr; pos: Pos }
  | { kind: 'Binary'; op: string; left: Expr; right: Expr; pos: Pos }
  | { kind: 'Assign'; op: string; target: Expr; value: Expr; pos: Pos }
  | { kind: 'Conditional'; test: Expr; consequent: Expr; alternate: Expr; pos: Pos }
  | { kind: 'Call'; callee: Expr; args: Expr[]; pos: Pos }
  | { kind: 'Index'; object: Expr; index: Expr; pos: Pos }
  | { kind: 'Member'; object: Expr; name: string; pos: Pos }
  | { kind: 'Cast'; type: TypeRef; expr: Expr; pos: Pos }
  | { kind: 'New'; type: TypeRef; args: Expr[]; pos: Pos }
  | { kind: 'Sizeof'; type?: TypeRef; expr?: Expr; pos: Pos }
  | { kind: 'Comma'; exprs: Expr[]; pos: Pos };

export interface Program {
  body: TopLevel[];
  properties: Map<string, string[]>;
}
