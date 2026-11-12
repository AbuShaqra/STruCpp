// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * STruC++ Abstract Syntax Tree Definitions
 *
 * This module defines the AST node types used throughout the compiler.
 * The AST is produced by the CST visitor from the parser output.
 */

import type { SourceSpan } from "../types.js";

// =============================================================================
// Base Types
// =============================================================================

/**
 * Base interface for all AST nodes.
 */
export interface ASTNode {
  /** Node type discriminator */
  readonly kind: string;

  /** Source location of this node */
  sourceSpan: SourceSpan;

  /** Parent node (set during tree construction) */
  parent?: ASTNode;
}

/**
 * Base interface for typed AST nodes (after semantic analysis).
 */
export interface TypedNode extends ASTNode {
  /** Resolved type after type checking */
  resolvedType?: IECType;
}

// =============================================================================
// Type System
// =============================================================================

/**
 * Base interface for IEC types.
 */
export interface IECType {
  readonly typeKind: string;
}

/**
 * Elementary type (BOOL, INT, REAL, etc.)
 */
export interface ElementaryType extends IECType {
  typeKind: "elementary";
  name: string;
  sizeBits: number;
}

/**
 * Array type
 */
export interface ArrayType extends IECType {
  typeKind: "array";
  elementType: IECType;
  dimensions: Array<{ start: number; end: number }>;
}

/**
 * Structure type
 */
export interface StructType extends IECType {
  typeKind: "struct";
  name: string;
  fields: Map<string, IECType>;
}

/**
 * Enumeration type
 */
export interface EnumType extends IECType {
  typeKind: "enum";
  name: string;
  values: string[];
}

/**
 * Reference type (REF_TO)
 */
export interface ReferenceType extends IECType {
  typeKind: "reference";
  referencedType: IECType;
  isImplicitDeref: boolean; // true for REFERENCE_TO (CODESYS), false for REF_TO
}

/**
 * Function block type
 */
export interface FunctionBlockType extends IECType {
  typeKind: "functionBlock";
  name: string;
  inputVars: Map<string, IECType>;
  outputVars: Map<string, IECType>;
  inoutVars: Map<string, IECType>;
}

// =============================================================================
// Compilation Unit
// =============================================================================

/**
 * Root node representing a complete compilation unit.
 */
export interface CompilationUnit extends ASTNode {
  kind: "CompilationUnit";
  programs: ProgramDeclaration[];
  functions: FunctionDeclaration[];
  functionBlocks: FunctionBlockDeclaration[];
  interfaces: InterfaceDeclaration[];
  types: TypeDeclaration[];
  configurations: ConfigurationDeclaration[];
  globalVarBlocks: VarBlock[];
  /** Top-level `ACTION Owner.Name ... END_ACTION` blocks (owner set). */
  actions: ActionDeclaration[];
}

/**
 * ACTION declaration: a named statement block of a PROGRAM or FUNCTION_BLOCK.
 * `owner` is set only for the top-level form `ACTION Owner.Name`.
 */
export interface ActionDeclaration extends ASTNode {
  kind: "ActionDeclaration";
  owner?: string;
  name: string;
  body: Statement[];
}

// =============================================================================
// Program Organization Units
// =============================================================================

/**
 * PROGRAM declaration
 */
export interface ProgramDeclaration extends ASTNode {
  kind: "ProgramDeclaration";
  name: string;
  varBlocks: VarBlock[];
  /** METHODs declared in the PROGRAM (the dialect feature program_methods). */
  methods: MethodDeclaration[];
  /** ACTION blocks written inside the PROGRAM, after its body. */
  actions: ActionDeclaration[];
  body: Statement[];
}

/**
 * FUNCTION declaration
 */
export interface FunctionDeclaration extends ASTNode {
  kind: "FunctionDeclaration";
  name: string;
  returnType: TypeReference;
  varBlocks: VarBlock[];
  body: Statement[];
}

/**
 * FUNCTION_BLOCK declaration
 */
export interface FunctionBlockDeclaration extends ASTNode {
  kind: "FunctionBlockDeclaration";
  name: string;
  isAbstract: boolean;
  isFinal: boolean;
  extends?: string;
  implements?: string[];
  varBlocks: VarBlock[];
  methods: MethodDeclaration[];
  properties: PropertyDeclaration[];
  /** ACTION blocks written inside the FUNCTION_BLOCK, after its body. */
  actions: ActionDeclaration[];
  body: Statement[];
}

/**
 * Visibility modifier for OOP members
 */
export type Visibility = "PUBLIC" | "PRIVATE" | "PROTECTED";

/**
 * METHOD declaration within a Function Block
 */
export interface MethodDeclaration extends ASTNode {
  kind: "MethodDeclaration";
  name: string;
  visibility: Visibility;
  isAbstract: boolean;
  isFinal: boolean;
  isOverride: boolean;
  returnType?: TypeReference;
  varBlocks: VarBlock[];
  body: Statement[];
  /** True when the method is a lowered ACTION (needs no feature in a PROGRAM). */
  fromAction?: boolean;
  /** True when the method holds the body of a property accessor that declares locals. */
  fromAccessor?: boolean;
  /**
   * Locals renamed so the program's member of the same name stays reachable
   * as `PRG_A.name` (see `lowerProgramSelfMembers`): the internal name and
   * the name as written.
   */
  renamedLocals?: Array<{ internal: string; name: string }>;
  /** Span of the method's name. */
  nameSpan?: SourceSpan;
}

/**
 * INTERFACE declaration (top-level POU)
 */
export interface InterfaceDeclaration extends ASTNode {
  kind: "InterfaceDeclaration";
  name: string;
  extends?: string[];
  methods: MethodDeclaration[];
  /** PROPERTY prototypes (feature property); each accessor present has no body. */
  properties: PropertyDeclaration[];
}

/**
 * PROPERTY declaration within a Function Block
 */
export interface PropertyDeclaration extends ASTNode {
  kind: "PropertyDeclaration";
  name: string;
  type: TypeReference;
  visibility: Visibility;
  getter?: Statement[];
  setter?: Statement[];
  /** The declaration part of GET, when it declares anything; lowered to `getterMethod`. */
  getterVarBlocks?: VarBlock[];
  /** The declaration part of SET, when it declares anything; lowered to `setterMethod`. */
  setterVarBlocks?: VarBlock[];
  /** The method holding the body of a GET that declares locals; `getter` is then empty. */
  getterMethod?: string;
  /** The method holding the body of a SET that declares locals; `setter` is then empty. */
  setterMethod?: string;
}

// =============================================================================
// Variable Declarations
// =============================================================================

/**
 * Variable block type
 */
export type VarBlockType =
  | "VAR"
  | "VAR_INPUT"
  | "VAR_OUTPUT"
  | "VAR_IN_OUT"
  | "VAR_EXTERNAL"
  | "VAR_GLOBAL"
  | "VAR_TEMP"
  | "VAR_INST";

/**
 * Variable block (VAR, VAR_INPUT, etc.)
 */
export interface VarBlock extends ASTNode {
  kind: "VarBlock";
  blockType: VarBlockType;
  isConstant: boolean;
  /**
   * True for `RETAIN` and for `PERSISTENT`.
   *
   * PERSISTENT is folded in rather than tracked separately: CODESYS
   * distinguishes them (PERSISTENT also survives a program download) and this
   * toolchain does not implement that yet, so the honest mapping is the weaker
   * guarantee both share. Splitting them would mean claiming a guarantee
   * nothing delivers.
   */
  isRetain: boolean;
  /**
   * True when the block spelled `NON_RETAIN` explicitly.
   *
   * Semantically the default — a plain `VAR` is already non-retained — so
   * nothing downstream branches on it. It is recorded so the qualifier is not
   * silently dropped by anything that reproduces source from the AST (the LSP
   * formatter, `--decompile-lib`), and so `NON_RETAIN` combined with `RETAIN`
   * can be reported as the contradiction it is.
   */
  isNonRetain: boolean;
  declarations: VarDeclaration[];
  /** Global variable list of a top-level VAR_GLOBAL block (feature named_global_lists). */
  globalListName?: string;
  /**
   * The RESOURCE that declares this block of a CONFIGURATION. A resource's
   * blocks are kept with the configuration's, so its globals are created and
   * reached as the configuration's are.
   */
  resourceName?: string;
  /**
   * Variable access specifiers written after the keyword (Ed. 3 Table 53,
   * 11a-11d), in source order; absent when none. PROTECTED is the default.
   */
  access?: VarAccess[];
}

/** A variable access specifier of a VAR section. */
export type VarAccess = "PUBLIC" | "PRIVATE" | "PROTECTED" | "INTERNAL";

/**
 * Single variable declaration
 */
export interface VarDeclaration extends ASTNode {
  kind: "VarDeclaration";
  names: string[];
  /** Global list aliases of these names (`LIST__NAME`), emitted as C++ references (feature named_global_lists). */
  listAliases?: Array<{ name: string; alias: string }>;
  type: TypeReference;
  initialValue?: Expression;
  /** The `AT` operand verbatim: a `%` location, or an OpenPLC alias name. */
  address?: string;
  /**
   * Which form {@link address} took.
   *
   * `"direct"` is an IEC `%` location. `"alias"` is a bare identifier, which
   * the OpenPLC Editor uses as a symbolic name for an I/O channel and resolves
   * to a real address before compiling. Absent when there is no address.
   *
   * Consumers that need a compilable location must check this: an alias is
   * accepted by the parser for the editor's benefit, never by a compile.
   */
  addressKind?: "direct" | "alias";
  /**
   * Span of the `AT` operand itself, so a caller can read it back from the
   * original source. The lexer upper-cases identifiers, so {@link address}
   * loses the spelling the user typed — an editor that writes the declaration
   * back to disk has to slice the source to keep `Motor_Start` from becoming
   * `MOTOR_START`. Absent when there is no address.
   */
  addressSpan?: SourceSpan;
  /**
   * Span of each declared name, positionally matching {@link names}, for the
   * same reason as {@link addressSpan}: the AST holds the folded-case name and
   * only the source holds the user's spelling.
   */
  nameSpans?: SourceSpan[];
  /** Init arguments `fb : FB_A(p := 1)` in source order (feature fb_init). */
  fbInitArguments?: Argument[];
  /** Span of the `(` that opens {@link fbInitArguments}. */
  fbInitSpan?: SourceSpan;
}

// =============================================================================
// Type Declarations
// =============================================================================

/**
 * TYPE declaration block
 */
export interface TypeDeclaration extends ASTNode {
  kind: "TypeDeclaration";
  name: string;
  definition: TypeDefinition;
  /**
   * Default value attached to the type itself
   * (`TYPE Temp : REAL := 25.0; END_TYPE`, `TYPE Origin : Point := (x := 0.0);`).
   *
   * IEC 61131-3 Annex B.1.3.3 `initialized_simple_type_declaration` /
   * `initialized_structure` / `initialized_array_type_declaration`. Applied to
   * every declaration of the type that does not carry its own initialiser — see
   * `applyTypeDefaults` in the AST builder.
   */
  defaultValue?: Expression;
  /** Base of `TYPE X EXTENDS Base : STRUCT`; needs the feature struct_extends. */
  extends?: TypeReference;
  /** The EXTENDS keyword of {@link extends}. */
  extendsKeywordSpan?: SourceSpan;
  /** Set on a TYPE hoisted from an inline enumeration or subrange. */
  inline?: InlineTypeOrigin;
}

/** Where a hoisted inline type was written. */
export interface InlineTypeOrigin {
  /** First variable of the declaration. */
  variable: string;
  /** POU, type or TEST that holds the declaration. */
  container: string;
  /** POU whose bodies see the members; absent for global, CONFIGURATION and STRUCT fields. */
  owner?: string;
}

/**
 * Type definition (struct, enum, array, subrange, or alias)
 */
export type TypeDefinition =
  | StructDefinition
  | EnumDefinition
  | ArrayDefinition
  | SubrangeDefinition
  | TypeReference;

/**
 * Structure definition
 */
export interface StructDefinition extends ASTNode {
  kind: "StructDefinition";
  /** With a base (`EXTENDS`), the inherited declarations first, then the own ones. */
  fields: VarDeclaration[];
  /**
   * Number of leading {@link fields} copied from the base chain by the
   * analyzer (feature struct_extends). Absent on a STRUCT without a base.
   */
  inheritedDeclarations?: number;
  /**
   * Set on `UNION ... END_UNION` (feature union): the fields share one
   * storage. Every other pass treats it as a STRUCT with the same fields.
   */
  isUnion?: true;
}

/**
 * Enumeration member with optional explicit value
 */
export interface EnumMember extends ASTNode {
  kind: "EnumMember";
  name: string;
  value?: Expression;
}

/**
 * Enumeration definition
 * Supports both simple enums: (RED, YELLOW, GREEN)
 * and typed enums with explicit values: INT (IDLE := 0, RUNNING := 1)
 */
export interface EnumDefinition extends ASTNode {
  kind: "EnumDefinition";
  baseType?: TypeReference;
  members: EnumMember[];
  defaultValue?: string;
  /** Base type written after the value list, `(A, B) DINT`; needs the feature postfix_enum_base. */
  postfixBase?: true;
}

/**
 * Subrange definition
 * Restricts a base type to a range of values: INT(0..100)
 */
export interface SubrangeDefinition extends ASTNode {
  kind: "SubrangeDefinition";
  baseType: TypeReference;
  lowerBound: Expression;
  upperBound: Expression;
}

/**
 * Array definition
 */
export interface ArrayDefinition extends ASTNode {
  kind: "ArrayDefinition";
  dimensions: ArrayDimension[];
  elementType: TypeReference;
}

/**
 * Array dimension
 * For fixed bounds: start and end are set, isVariableLength is false
 * For variable-length (ARRAY[*]): isVariableLength is true, start/end are undefined
 */
export interface ArrayDimension extends ASTNode {
  kind: "ArrayDimension";
  isVariableLength: boolean;
  start?: Expression;
  end?: Expression;
}

/**
 * Reference kind for type references
 */
export type ReferenceKind = "none" | "ref_to" | "reference_to" | "pointer_to";

/**
 * Type reference (name of a type)
 */
export interface TypeReference extends ASTNode {
  kind: "TypeReference";
  name: string;
  isReference: boolean; // true for REF_TO (for backwards compat)
  referenceKind: ReferenceKind; // more specific: "none", "ref_to", or "reference_to"
  /**
   * Every reference level, outermost first, when there is more than one:
   * `POINTER TO REF_TO INT` is `["pointer_to", "ref_to"]` with `name` "INT".
   * `referenceKind` is always the first entry. Absent for zero or one level,
   * so single-level types are unchanged.
   */
  referenceChain?: ReferenceKind[];
  /**
   * An anonymous type written inside a declaration: `a : (Idle, Running);`
   * or `a : INT(0..100);`. The AST keeps it where it was written; compile
   * lowers it to a TYPE declaration (see `lowerInlineTypes`) and points
   * `name` at that, so it behaves exactly like the declared equivalent.
   */
  inlineDefinition?: EnumDefinition | SubrangeDefinition;
  maxLength?: number | string; // For STRING(n) / WSTRING(n) parameterized length; string for constant names
  arrayDimensions?: Array<{ start: number; end: number }>; // For __INLINE_ARRAY_* types
  elementTypeName?: string; // Element type for inline arrays (e.g. "BYTE" for ARRAY[0..7] OF BYTE)
  /** STRING / WSTRING length of an inline array's element (`ARRAY[0..1] OF STRING(10)`). */
  elementMaxLength?: number | string;
  /**
   * The element's reference levels, outermost first, for an inline array of
   * pointers or references: `ARRAY[0..3] OF POINTER TO INT` is
   * `["pointer_to"]` with `elementTypeName` "INT". Absent for plain elements.
   */
  elementReferenceChain?: ReferenceKind[];
  /**
   * An inline array whose bounds the AST builder could not reduce to integers
   * (a global constant, an enumeration value). `resolveArrayBounds` replaces it
   * with `arrayDimensions` and `elementTypeName` on the merged unit.
   */
  unresolvedArray?: {
    dimensions: Array<{ start: Expression; end: Expression }>;
    elementTypeName: string;
  };
}

// =============================================================================
// Configuration
// =============================================================================

/**
 * CONFIGURATION declaration
 */
export interface ConfigurationDeclaration extends ASTNode {
  kind: "ConfigurationDeclaration";
  name: string;
  varBlocks: VarBlock[];
  resources: ResourceDeclaration[];
}

/**
 * RESOURCE declaration
 */
export interface ResourceDeclaration extends ASTNode {
  kind: "ResourceDeclaration";
  name: string;
  onType: string;
  tasks: TaskDeclaration[];
  programInstances: ProgramInstance[];
}

/**
 * TASK declaration
 */
export interface TaskDeclaration extends ASTNode {
  kind: "TaskDeclaration";
  name: string;
  properties: Map<string, Expression>;
}

/**
 * Program instance
 */
export interface ProgramInstance extends ASTNode {
  kind: "ProgramInstance";
  instanceName: string;
  taskName?: string;
  programType: string;
}

// =============================================================================
// Statements
// =============================================================================

/**
 * Union of all statement types
 */
export type Statement =
  | AssignmentStatement
  | RefAssignStatement
  | IfStatement
  | CaseStatement
  | ForStatement
  | WhileStatement
  | RepeatStatement
  | ExitStatement
  | ContinueStatement
  | ReturnStatement
  | FunctionCallStatement
  | ExternalCodePragma
  | DeleteStatement
  | AssertCall;

/**
 * Assignment statement
 */
export interface AssignmentStatement extends ASTNode {
  kind: "AssignmentStatement";
  target: Expression;
  value: Expression;
}

/**
 * REF= assignment statement (bind REFERENCE_TO to a variable)
 */
export interface RefAssignStatement extends ASTNode {
  kind: "RefAssignStatement";
  target: Expression;
  source: Expression;
}

/**
 * Set on a structured statement whose `END_x` keyword is not followed by `;`.
 * The grammar accepts that; `--strict` rejects it, as matiec did.
 */
export interface UnterminatedEnd {
  /** The keyword, e.g. "END_IF". */
  keyword: string;
  /** Where the keyword is. */
  sourceSpan: SourceSpan;
}

/**
 * IF statement
 */
export interface IfStatement extends ASTNode {
  kind: "IfStatement";
  unterminated?: UnterminatedEnd;
  condition: Expression;
  thenStatements: Statement[];
  elsifClauses: ElsifClause[];
  elseStatements: Statement[];
}

/**
 * ELSIF clause
 */
export interface ElsifClause extends ASTNode {
  kind: "ElsifClause";
  condition: Expression;
  statements: Statement[];
}

/**
 * CASE statement
 */
export interface CaseStatement extends ASTNode {
  kind: "CaseStatement";
  unterminated?: UnterminatedEnd;
  selector: Expression;
  cases: CaseElement[];
  elseStatements: Statement[];
}

/**
 * CASE element
 */
export interface CaseElement extends ASTNode {
  kind: "CaseElement";
  labels: CaseLabel[];
  statements: Statement[];
}

/**
 * Case label (single value or range)
 */
export interface CaseLabel extends ASTNode {
  kind: "CaseLabel";
  start: Expression;
  end?: Expression;
}

/**
 * FOR statement
 */
export interface ForStatement extends ASTNode {
  kind: "ForStatement";
  unterminated?: UnterminatedEnd;
  controlVariable: string;
  start: Expression;
  end: Expression;
  step?: Expression;
  body: Statement[];
  /** Set when the body is written as empty statements only (`DO ; END_FOR`). */
  emptyStatementBody?: true;
}

/**
 * WHILE statement
 */
export interface WhileStatement extends ASTNode {
  kind: "WhileStatement";
  unterminated?: UnterminatedEnd;
  condition: Expression;
  body: Statement[];
}

/**
 * REPEAT statement
 */
export interface RepeatStatement extends ASTNode {
  kind: "RepeatStatement";
  unterminated?: UnterminatedEnd;
  body: Statement[];
  condition: Expression;
}

/**
 * EXIT statement
 */
export interface ExitStatement extends ASTNode {
  kind: "ExitStatement";
}

/**
 * CONTINUE statement
 */
export interface ContinueStatement extends ASTNode {
  kind: "ContinueStatement";
}

/**
 * RETURN statement
 */
export interface ReturnStatement extends ASTNode {
  kind: "ReturnStatement";
}

/**
 * Function call as statement
 */
export interface FunctionCallStatement extends ASTNode {
  kind: "FunctionCallStatement";
  call: FunctionCallExpression | MethodCallExpression;
}

/**
 * __DELETE(pointer) statement - deallocate dynamic memory
 */
export interface DeleteStatement extends ASTNode {
  kind: "DeleteStatement";
  pointer: Expression;
}

// =============================================================================
// Pragmas
// =============================================================================

/**
 * External code pragma: {external ... }
 * Content is passed through AS-IS to generated C++ code.
 * Allows mixing Structured Text with C/C++ code.
 */
export interface ExternalCodePragma extends ASTNode {
  kind: "ExternalCodePragma";
  /** Raw C/C++ code content (AS-IS, no transformation) */
  code: string;
}

// =============================================================================
// Expressions
// =============================================================================

/**
 * Union of all expression types
 */
export type Expression =
  | BinaryExpression
  | UnaryExpression
  | FunctionCallExpression
  | MethodCallExpression
  | VariableExpression
  | LiteralExpression
  | ParenthesizedExpression
  | RefExpression
  | DrefExpression
  | NewExpression
  | ArrayLiteralExpression
  | StructInitializerExpression;

/**
 * Binary operator
 */
export type BinaryOperator =
  | "+"
  | "-"
  | "*"
  | "/"
  | "MOD"
  | "**"
  | "AND"
  | "OR"
  | "XOR"
  | "="
  | "<>"
  | "<"
  | ">"
  | "<="
  | ">=";

/**
 * Binary expression
 */
export interface BinaryExpression extends TypedNode {
  kind: "BinaryExpression";
  operator: BinaryOperator;
  left: Expression;
  right: Expression;
  /** Set by the type checker when `=` / `<>` compares a POINTER TO or REF_TO itself, not what it refers to. */
  comparesReferences?: true;
}

/**
 * Unary operator
 */
export type UnaryOperator = "NOT" | "-" | "+";

/**
 * Unary expression
 */
export interface UnaryExpression extends TypedNode {
  kind: "UnaryExpression";
  operator: UnaryOperator;
  operand: Expression;
}

/**
 * Function or FB call expression
 */
export interface FunctionCallExpression extends TypedNode {
  kind: "FunctionCallExpression";
  functionName: string;
  arguments: Argument[];
  /**
   * Set when the callee is a function block instance reached through an
   * expression rather than a bare name — today an array element, `units[0]()`.
   *
   * `functionName` still carries the base variable name (`units`), which is what
   * resolves the declared type; this expression is what the invocation is
   * emitted against.
   */
  instance?: Expression;
  /** Written as `THIS^.M()`; needs the feature self_caret. */
  selfCaret?: true;
  /** Set when written with a global variable list prefix (`LIST.fb()`), which was removed. */
  globalList?: string;
  /** Set by the type checker: the library whose FUNCTION of a standard function's name is called. */
  libraryFunction?: string;
}

/**
 * Method call on an expression (for method chaining / fluent interface).
 * e.g., fb.method1(args).method2(args) → nested MethodCallExpression nodes
 */
export interface MethodCallExpression extends TypedNode {
  kind: "MethodCallExpression";
  object: Expression; // The expression to call the method on
  methodName: string;
  arguments: Argument[];
  /** Where the method name is written; set for a call through a member chain. */
  methodNameSpan?: SourceSpan;
  /** Set by the type checker when `methodName` is a function block instance member, called (`a.b.fb()`). */
  fbInstanceCall?: true;
}

/**
 * Function argument
 */
export interface Argument extends ASTNode {
  kind: "Argument";
  name?: string;
  isOutput: boolean;
  value: Expression;
  /**
   * Set by the type checker on an argument bound to a VAR_IN_OUT of another
   * type (a warning outside the IEC profile): codegen passes it by copy-in /
   * copy-out instead of by reference.
   */
  inOutCopy?: true;
}

/**
 * An ordered access step in a variable access chain.
 * Preserves the interleaving of field accesses, subscripts, and dereferences.
 */
export type AccessStep =
  | { kind: "field"; name: string }
  | { kind: "subscript"; indices: Expression[] }
  | { kind: "dereference" };

/**
 * Variable reference expression
 */
export interface VariableExpression extends TypedNode {
  kind: "VariableExpression";
  name: string;
  subscripts: Expression[];
  fieldAccess: string[];
  isDereference: boolean;
  /** Ordered access chain preserving interleaving of fields, subscripts, deref */
  accessChain?: AccessStep[];
  /** Written as a typed enumeration value (`E_State#Idle`). */
  typedLiteral?: true;
  /** Written as `THIS^.member`; needs the feature self_caret. */
  selfCaret?: true;
  /** Set when written with a global variable list prefix (`LIST.var`), which was removed. */
  globalList?: string;
  /** Set by the type checker when the storage reached lies in a UNION's storage (feature union). */
  unionMember?: true;
  /** Set by the type checker when a REFERENCE TO is bound to this alias-typed variable, which compile cannot lower yet: the message. */
  aliasReferenceBinding?: string;
  /** Set by the type checker when the last field is a bit selected by a named constant (`w.C_BIT`). */
  namedBitIndex?: true;
  /** Set by the analyzer when a bare member of several enumerations is settled by the enum type it initialises or is assigned to: that enum's name. */
  enumType?: string;
}

/**
 * Literal expression
 */
export interface LiteralExpression extends TypedNode {
  kind: "LiteralExpression";
  literalType: LiteralType;
  value: string | number | boolean;
  rawValue: string;
  typePrefix?: string;
  /** Set by the type checker: a `0` stored in an interface (feature interface_zero), emitted as NULL. */
  asNull?: boolean;
}

/**
 * Literal type
 */
export type LiteralType =
  | "BOOL"
  | "INT"
  | "REAL"
  | "STRING"
  | "WSTRING"
  | "TIME"
  | "DATE"
  | "TIME_OF_DAY"
  | "DATE_AND_TIME"
  | "NULL";

/**
 * Parenthesized expression
 */
export interface ParenthesizedExpression extends TypedNode {
  kind: "ParenthesizedExpression";
  expression: Expression;
}

/**
 * REF(variable) expression - get reference to a variable
 */
export interface RefExpression extends TypedNode {
  kind: "RefExpression";
  operand: Expression;
}

/**
 * DREF(expression) expression - explicit dereference
 */
export interface DrefExpression extends TypedNode {
  kind: "DrefExpression";
  operand: Expression;
}

/**
 * __NEW(Type) or __NEW(Type, size) expression - allocate dynamic memory
 */
export interface NewExpression extends TypedNode {
  kind: "NewExpression";
  allocationType: TypeReference;
  arraySize?: Expression;
}

/**
 * Array literal expression (comma-separated list of values)
 * Used for inline array initializers: ARRAY := 0, 31, 59, 90;
 */
export interface ArrayLiteralExpression extends TypedNode {
  kind: "ArrayLiteralExpression";
  elements: Expression[];
}

/**
 * One `element := value` pair inside a structure initializer.
 * IEC 61131-3 Annex B.1.4.3 `structure_element_initialization`.
 */
export interface StructElementInitializer extends ASTNode {
  kind: "StructElementInitializer";
  /** Structure element (field) name, as written in the source. */
  name: string;
  value: Expression;
}

/**
 * Structure initializer: `(field := value, field := value)`
 *
 * IEC 61131-3 Annex B.1.4.3 `structure_initialization`. Used to initialise
 * STRUCT-typed variables in a declaration and to set the initial inputs of a
 * function block instance (`t : TON := (PT := T#1s)`). Elements may be given in
 * any order and may be omitted, in which case the element keeps the default
 * from its own declaration.
 */
export interface StructInitializerExpression extends TypedNode {
  kind: "StructInitializerExpression";
  elements: StructElementInitializer[];
}

// =============================================================================
// Test Framework Types
// =============================================================================

/**
 * Root node representing a parsed test file.
 */
export interface TestFile {
  fileName: string;
  setup?: SetupBlock;
  teardown?: TeardownBlock;
  testCases: TestCase[];
  /** TYPEs hoisted from inline enumerations and subranges in its VAR blocks. */
  inlineTypes?: TypeDeclaration[];
}

/**
 * SETUP block: shared initialization that runs before each TEST.
 */
export interface SetupBlock {
  varBlocks: VarBlock[];
  body: TestStatement[];
  sourceSpan: SourceSpan;
}

/**
 * TEARDOWN block: cleanup that runs after each TEST.
 */
export interface TeardownBlock {
  body: TestStatement[];
  sourceSpan: SourceSpan;
}

/**
 * A single TEST block.
 */
export interface TestCase {
  name: string;
  varBlocks: VarBlock[];
  body: TestStatement[];
  sourceSpan: SourceSpan;
}

/**
 * Assert function type
 */
export type AssertType =
  | "ASSERT_EQ"
  | "ASSERT_NEQ"
  | "ASSERT_TRUE"
  | "ASSERT_FALSE"
  | "ASSERT_GT"
  | "ASSERT_LT"
  | "ASSERT_GE"
  | "ASSERT_LE"
  | "ASSERT_NEAR";

/**
 * Assert function call within a test block.
 */
export interface AssertCall extends ASTNode {
  kind: "AssertCall";
  assertType: AssertType;
  args: Expression[];
  message?: string;
  /** The message's STRING literal, for its source position and checks. */
  messageLiteral?: LiteralExpression;
  sourceSpan: SourceSpan;
}

/**
 * MOCK instance.path; - Mock an FB instance (skip body, retain outputs).
 */
export interface MockFBStatement extends ASTNode {
  kind: "MockFBStatement";
  instancePath: string[];
  sourceSpan: SourceSpan;
}

/**
 * MOCK_FUNCTION FuncName RETURNS expression; - Mock a function with fixed return value.
 */
export interface MockFunctionStatement extends ASTNode {
  kind: "MockFunctionStatement";
  functionName: string;
  returnValue: Expression;
  sourceSpan: SourceSpan;
}

/**
 * MOCK_VERIFY_CALLED(instance.path); - Assert mocked FB was called at least once.
 */
export interface MockVerifyCalledStatement extends ASTNode {
  kind: "MockVerifyCalledStatement";
  instancePath: string[];
  sourceSpan: SourceSpan;
}

/**
 * MOCK_VERIFY_CALL_COUNT(instance.path, count); - Assert mocked FB call count.
 */
export interface MockVerifyCallCountStatement extends ASTNode {
  kind: "MockVerifyCallCountStatement";
  instancePath: string[];
  expectedCount: Expression;
  sourceSpan: SourceSpan;
}

/**
 * A statement within a test block (either a regular statement, assert call, or mock statement).
 */
/**
 * ADVANCE_TIME(duration) - Advance scan-cycle time in tests.
 */
export interface AdvanceTimeStatement extends ASTNode {
  kind: "AdvanceTimeStatement";
  duration: Expression;
  sourceSpan: SourceSpan;
}

export type TestStatement =
  | Statement
  | AssertCall
  | AdvanceTimeStatement
  | MockFBStatement
  | MockFunctionStatement
  | MockVerifyCalledStatement
  | MockVerifyCallCountStatement;

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a default source span for nodes without location info.
 */
export function createDefaultSourceSpan(): SourceSpan {
  return {
    file: "",
    startLine: 0,
    endLine: 0,
    startCol: 0,
    endCol: 0,
  };
}

/**
 * Create an empty compilation unit.
 */
export function createCompilationUnit(): CompilationUnit {
  return {
    kind: "CompilationUnit",
    sourceSpan: createDefaultSourceSpan(),
    programs: [],
    functions: [],
    functionBlocks: [],
    interfaces: [],
    types: [],
    configurations: [],
    globalVarBlocks: [],
    actions: [],
  };
}
