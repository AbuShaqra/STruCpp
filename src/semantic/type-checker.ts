// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * STruC++ Type Checker
 *
 * Performs type checking and type inference on the AST.
 * Validates IEC 61131-3 type rules and resolves types for expressions.
 *
 * Sub-Phase B: Walks all POUs and resolves every expression's type (sets resolvedType on AST nodes).
 * Sub-Phase C: Validates type rules (assignment compatibility, conditions, FOR vars, function args).
 */

import type {
  ASTNode,
  RefAssignStatement,
  VarAccess,
  AssignmentStatement,
  Expression,
  BinaryExpression,
  UnaryExpression,
  LiteralExpression,
  VariableExpression,
  FunctionCallExpression,
  MethodCallExpression,
  Argument,
  TypeReference,
  IECType,
  ElementaryType,
  ReferenceType,
  EnumType,
  StructType,
  CompilationUnit,
  FunctionBlockDeclaration,
  FunctionDeclaration,
  InterfaceDeclaration,
  MethodDeclaration,
  ProgramDeclaration,
  Statement,
  VarBlock,
  UnterminatedEnd,
  VarDeclaration,
  AccessStep,
} from "../frontend/ast.js";
import type {
  AnySymbol,
  FunctionSymbol,
  SymbolTables,
  Scope,
} from "./symbol-table.js";
import { Scope as SymbolScope } from "./symbol-table.js";
import type { StdFunctionRegistry } from "./std-function-registry.js";
import type { CompileError, SourceSpan } from "../types.js";
import {
  ELEMENTARY_TYPES,
  isTypeInCategory as _isTypeInCategory,
  isAssignable as _isAssignable,
  isNarrowingConversion,
  matchesConstraint,
  getCommonType,
  resolveFieldType,
  resolveArrayElementType,
  typeName as typeNameUtil,
  isGenericGroupType,
  canonicalElementaryName,
  getBitAccessWidth,
  resolveAccessType,
  resolveArrayElementAccessType,
  resolveFieldDeclaration,
  type AccessLookup,
  type AccessType,
} from "./type-utils.js";
import {
  type GlobalOrder,
  orderConfigurationGlobals,
  orderGlobals,
} from "./global-order.js";
import { stripEnEno, walkAST } from "../ast-utils.js";
import { DEFAULT_FEATURES, type FeatureId } from "../dialect.js";
import { structExtends } from "./struct-extends.js";
import { bindStdFunctionArguments } from "./std-function-args.js";
import { STD_FUNCTIONS_LIBRARY } from "../library/library-manifest.js";
import { libraryOverloadFor } from "./library-overload.js";
import { charLiteralUnits } from "../literal-utils.js";
import {
  vendorOperatorArgumentError,
  vendorOperatorFeature,
  vendorOperatorNamed,
  vendorOperatorResultType,
} from "./vendor-operators.js";
import {
  fbIndex,
  fbInitArgumentScope,
  fbInitChain,
  fbInitInput,
  storedInstance,
} from "./fb-init.js";

// Re-export from type-utils for backward compatibility
export { ELEMENTARY_TYPES, TYPE_CATEGORIES } from "./type-utils.js";
export type { TypeCategory } from "./type-utils.js";

// =============================================================================
// IEC 61131-3 date/time arithmetic helpers
// =============================================================================

/** Elementary type names Ed. 3 added; a user TYPE may already bear one. */
const ED3_ELEMENTARY_NAMES = new Set([
  "LTIME",
  "LDATE",
  "LTOD",
  "LTIME_OF_DAY",
  "LDT",
  "LDATE_AND_TIME",
  "CHAR",
  "WCHAR",
]);

/** Canonical name of an elementary operand type, or undefined. */
function temporalName(t: IECType): string | undefined {
  return t.typeKind === "elementary"
    ? canonicalElementaryName((t as ElementaryType).name)
    : undefined;
}

/** The long form of an instant or duration type (DT → LDT); itself when long. */
const LONG_FORM: Record<string, string> = {
  DT: "LDT",
  DATE: "LDATE",
  TOD: "LTOD",
  TIME: "LTIME",
  LDT: "LDT",
  LDATE: "LDATE",
  LTOD: "LTOD",
  LTIME: "LTIME",
};
const LONG_TYPES = new Set(["LDT", "LDATE", "LTOD", "LTIME"]);

/** Instant types by the name the operand carries (TIME_OF_DAY and
 *  DATE_AND_TIME stay out, as before the long forms came). */
const INSTANT_NAMES = new Set([
  "DT",
  "DATE",
  "TOD",
  "LDT",
  "LDATE_AND_TIME",
  "LDATE",
  "LTOD",
  "LTIME_OF_DAY",
]);

/** True when the operand type is one of the absolute-time types. */
function isInstantType(t: IECType): boolean {
  return (
    t.typeKind === "elementary" &&
    INSTANT_NAMES.has((t as ElementaryType).name.toUpperCase())
  );
}

/** True when the operand type is a duration type (TIME, LTIME). */
function isDurationType(t: IECType): boolean {
  const name = temporalName(t);
  return name === "TIME" || name === "LTIME";
}

/** True when either operand is a long (64-bit Ed. 3) temporal type. */
function anyLong(left: IECType, right: IECType): boolean {
  return (
    LONG_TYPES.has(temporalName(left) ?? "") ||
    LONG_TYPES.has(temporalName(right) ?? "")
  );
}

/** True when the operand pair maps to a recognised date/time arithmetic
 *  rule from IEC 61131-3 §6.6.2.2 — instant minus instant, or instant
 *  ± duration. Anything else (DT * 2, TIME / DT, …) falls through to
 *  the normal arithmetic path so we don't widen the rule beyond what
 *  the standard sanctions. A type and its long form (DT, LDT) count as one
 *  instant kind, the short converting implicitly to the long. */
function isDateTimeArithmetic(
  left: IECType,
  right: IECType,
  op: string,
): boolean {
  const leftIsInstant = isInstantType(left);
  const rightIsInstant = isInstantType(right);
  const leftIsTime = isDurationType(left);
  const rightIsTime = isDurationType(right);

  // instant - instant → duration. Both must be the same instant kind per
  // the standard (DT - TOD is meaningless).
  if (op === "-" && leftIsInstant && rightIsInstant) {
    return LONG_FORM[temporalName(left)!] === LONG_FORM[temporalName(right)!];
  }
  // instant ± duration → instant (offset)
  if (leftIsInstant && rightIsTime) return true;
  // duration + instant → instant (commutative addition only)
  if (op === "+" && leftIsTime && rightIsInstant) return true;
  return false;
}

/** Resolves the result type for a recognised date/time arithmetic pair.
 *  Pre-condition: isDateTimeArithmetic returned true for the same args.
 *  A long operand makes the result long (LTIME, or the long instant). */
function resolveDateTimeArithmetic(
  left: IECType,
  right: IECType,
  op: string,
): IECType | undefined {
  const leftIsInstant = isInstantType(left);
  const rightIsInstant = isInstantType(right);
  const long = anyLong(left, right);

  if (op === "-" && leftIsInstant && rightIsInstant) {
    return ELEMENTARY_TYPES[long ? "LTIME" : "TIME"];
  }
  // instant ± duration: result keeps the instant kind.
  const instant = leftIsInstant ? left : rightIsInstant ? right : undefined;
  if (instant === undefined) return undefined;
  return long ? ELEMENTARY_TYPES[LONG_FORM[temporalName(instant)!]!] : instant;
}

// =============================================================================
// Type Checker
// =============================================================================

const REFERENCE_LEVEL_TEXT: Record<string, string> = {
  ref_to: "REF_TO",
  reference_to: "REFERENCE TO",
  pointer_to: "POINTER TO",
};

/** `REF_TO REF_TO INT` for a declared reference shape. */
function describeReferenceShape(shape: ReferenceShape): string {
  const base =
    shape.length === undefined
      ? shape.base
      : `${shape.base}(${String(shape.length)})`;
  return [...shape.chain.map((k) => REFERENCE_LEVEL_TEXT[k] ?? k), base]
    .join(" ")
    .toUpperCase();
}

/** The reference levels and target type of a declared type. */
interface ReferenceShape {
  chain: string[];
  base: string;
  /** The declared length of a STRING(n) / WSTRING(n) target. */
  length?: number | string;
  /** Set when the declaration's string length is not carried (an array element). */
  lengthUnknown?: boolean;
}

/** Characters a STRING or WSTRING holds when no length is declared. */
const DEFAULT_STRING_LENGTH = 254;

/**
 * Whether two STRING / WSTRING targets are known to differ in length. A length
 * named by a constant is only compared with the same name.
 */
function stringLengthsDiffer(a: ReferenceShape, b: ReferenceShape): boolean {
  if (a.lengthUnknown === true || b.lengthUnknown === true) return false;
  const la = a.length ?? DEFAULT_STRING_LENGTH;
  const lb = b.length ?? DEFAULT_STRING_LENGTH;
  if (typeof la === "number" && typeof lb === "number") return la !== lb;
  return false;
}

/** Whether a type name is STRING or WSTRING. */
function isStringBase(name: string): boolean {
  const upper = name.toUpperCase();
  return upper === "STRING" || upper === "WSTRING";
}

/** A string shape's type as written: `STRING(3)`, or `STRING` by default. */
function stringText(shape: ReferenceShape): string {
  return shape.length === undefined
    ? shape.base
    : `${shape.base}(${String(shape.length)})`;
}

/**
 * Type checker for IEC 61131-3 programs.
 */
/** An input or in-out parameter of a call, in declaration order. */
interface CallInput {
  name: string;
  type: AccessType;
  inOut: boolean;
}

/** `NULL` or `0`: the only initializers a pointer or reference keeps (it starts null anyway). */
function isNullInitializer(expr: Expression): boolean {
  return (
    expr.kind === "LiteralExpression" &&
    (expr.literalType === "NULL" || expr.value === 0)
  );
}

/** `ADR(x)`. */
function isAddressOf(expr: Expression): expr is FunctionCallExpression {
  return (
    expr.kind === "FunctionCallExpression" &&
    expr.functionName.toUpperCase() === "ADR" &&
    expr.instance === undefined
  );
}

/** An elementary integer or bit-string type name (not BOOL). */
function isIntegerOrBitStringName(name: string): boolean {
  return /^(U?S?INT|U?DINT|U?LINT|BYTE|WORD|DWORD|LWORD)$/i.test(name);
}

/** An untyped integer literal 0 (`0`, `16#0`), not `INT#0`. */
function isUntypedZero(expr: Expression): expr is LiteralExpression {
  return (
    expr.kind === "LiteralExpression" &&
    expr.literalType === "INT" &&
    expr.typePrefix === undefined &&
    expr.value === 0
  );
}

/** The reference levels and target type of a declared type; undefined for an array. */
function referenceShapeOf(type: AccessType): ReferenceShape | undefined {
  if (type.arrayDimensions) return undefined;
  const chain =
    type.referenceChain ??
    (type.referenceKind !== undefined && type.referenceKind !== "none"
      ? [type.referenceKind]
      : []);
  const length = (type as { maxLength?: number | string }).maxLength;
  return {
    chain,
    base: type.name,
    ...(length !== undefined ? { length } : {}),
  };
}

/** Standard functions comparing or selecting their arguments, by leading arguments to skip. */
const CHAR_COMPARE_FUNCTIONS: ReadonlyMap<string, number> = new Map([
  ["MAX", 0],
  ["MIN", 0],
  ["LIMIT", 0],
  ["GT", 0],
  ["GE", 0],
  ["LT", 0],
  ["LE", 0],
  ["EQ", 0],
  ["NE", 0],
  ["SEL", 1],
  ["MUX", 1],
]);

/** Standard functions whose result is one of their CHAR arguments. */
const CHAR_SELECTION_FUNCTIONS: ReadonlySet<string> = new Set([
  "MAX",
  "MIN",
  "LIMIT",
  "SEL",
  "MUX",
]);

/** The C++ storage of each integer and bit-string type (same storage, same C++ type). */
const INTEGER_STORAGE: Readonly<Record<string, string>> = {
  SINT: "i8",
  INT: "i16",
  DINT: "i32",
  LINT: "i64",
  USINT: "u8",
  BYTE: "u8",
  UINT: "u16",
  WORD: "u16",
  UDINT: "u32",
  DWORD: "u32",
  ULINT: "u64",
  LWORD: "u64",
};

/** Long temporal types stored as their short form. */
const TEMPORAL_STORAGE: Readonly<Record<string, string>> = {
  TIME: "time",
  LTIME: "time",
  DATE: "date",
  LDATE: "date",
  TIME_OF_DAY: "tod",
  TOD: "tod",
  LTIME_OF_DAY: "tod",
  LTOD: "tod",
  DATE_AND_TIME: "dt",
  DT: "dt",
  LDATE_AND_TIME: "dt",
  LDT: "dt",
};

const COMPARISON_OPS: ReadonlySet<string> = new Set([
  "=",
  "<>",
  "<",
  ">",
  "<=",
  ">=",
]);

/** The error for an arithmetic or logic operator given an enumeration. */
function enumOperatorMessage(operator: string, enumType: IECType): string {
  return `Operator '${operator}' cannot be applied to the enumeration ${typeNameUtil(enumType)}; convert it first, for example with TO_INT`;
}

// =============================================================================
// Strict mode helpers
// =============================================================================

const STRICT_ARITHMETIC_OPS: ReadonlySet<string> = new Set([
  "+",
  "-",
  "*",
  "/",
  "MOD",
]);
const STRICT_BIT_STRINGS: ReadonlySet<string> = new Set([
  "BYTE",
  "WORD",
  "DWORD",
  "LWORD",
]);

type StrictKind = "int" | "real" | "bool" | "bit";
/** The literal kind of an untyped constant expression. */
type StrictConstKind = "INT" | "REAL" | "BOOL";
/** Generic constraints: a parameter or result of this kind takes its type from the call. */
const STRICT_GENERIC: ReadonlySet<string> = new Set([
  "ANY",
  "ANY_NUM",
  "ANY_INT",
  "ANY_REAL",
  "ANY_BIT",
  "ANY_ELEMENTARY",
]);

/** Strict classification of an elementary type; undefined for all other types. */
function strictKind(name: string): StrictKind | undefined {
  const n = name.toUpperCase();
  if (n === "BOOL") return "bool";
  if (n === "REAL" || n === "LREAL") return "real";
  if (/^U?(SINT|INT|DINT|LINT)$/.test(n)) return "int";
  if (STRICT_BIT_STRINGS.has(n)) return "bit";
  return undefined;
}

function strictConversionMessage(from: string, to: string): string {
  return `Implicit conversion from ${from} to ${to} is not allowed; use ${from}_TO_${to}`;
}

/**
 * Whether converting `from` to `to` is implicit (Ed. 3 Figures 11 and 12):
 * integer to a wider integer (unsigned to a wider signed too, never signed to
 * unsigned), SINT/INT/USINT/UINT to REAL, any integer up to 32 bits to LREAL,
 * REAL to LREAL, and BOOL or a bit string to a wider bit string.
 */
function strictIsExactWidening(from: string, to: string): boolean {
  const fromKind = strictKind(from);
  const toKind = strictKind(to);
  const fromBits = ELEMENTARY_TYPES[from]?.sizeBits;
  const toBits = ELEMENTARY_TYPES[to]?.sizeBits;
  if (fromKind === undefined || toKind === undefined) return false;
  if (fromBits === undefined || toBits === undefined) return false;
  const fromUnsigned = from.startsWith("U");
  const toUnsigned = to.startsWith("U");
  if (fromKind === "int" && toKind === "int") {
    if (!fromUnsigned && toUnsigned) return false;
    return toBits > fromBits;
  }
  if (fromKind === "int" && toKind === "real") {
    return fromBits <= (to === "REAL" ? 16 : 32);
  }
  if (fromKind === "real" && toKind === "real") {
    return from === "REAL" && to === "LREAL";
  }
  if ((fromKind === "bit" || fromKind === "bool") && toKind === "bit") {
    return toBits > fromBits;
  }
  return false;
}

/** How a function block member may be reached from outside the block. */
type MemberKind = "internal" | "external" | "input" | "output" | "inout";

/** The member kind each declaring block gives its variables. */
const MEMBER_KIND: Partial<Record<VarBlock["blockType"], MemberKind>> = {
  VAR: "internal",
  VAR_TEMP: "internal",
  VAR_EXTERNAL: "external",
  VAR_INPUT: "input",
  VAR_OUTPUT: "output",
  VAR_IN_OUT: "inout",
};

export class TypeChecker {
  private errors: CompileError[] = [];
  private warnings: CompileError[] = [];
  private ast: CompilationUnit | undefined;

  constructor(
    private symbolTables: SymbolTables,
    private stdRegistry?: StdFunctionRegistry,
    private strict = false,
    /** Language features enabled by the dialect. */
    readonly features: ReadonlySet<string> = DEFAULT_FEATURES,
    /** The refusal text for `construct` when `feature` is off (adds the profiles hint). */
    private readonly featureMessage: (
      feature: FeatureId,
      construct: string,
    ) => string = (feature, construct) =>
      `${construct} needs the feature ${feature}`,
    /** The IEC profile is selected: in-out binding forms that compile elsewhere are errors. */
    private readonly inOutErrors = false,
  ) {}

  /**
   * The output bindings of the calls in TEST, SETUP and TEARDOWN bodies (see
   * checkOutputBindings), which are not otherwise type-checked.
   */
  checkTestOutputBindings(
    roots: readonly ASTNode[],
    scope: Scope,
    ast: CompilationUnit | undefined,
  ): { errors: CompileError[]; warnings: CompileError[] } {
    this.errors = [];
    this.warnings = [];
    this.ast = ast;
    for (const root of roots) {
      walkAST(root, (node) => {
        if (node.kind === "FunctionCallExpression") {
          const call = node as FunctionCallExpression;
          // A built-in operator (XSIZEOF) is marked for codegen, as in a POU.
          this.vendorOperatorCallType(
            call,
            call.functionName.toUpperCase(),
            scope,
          );
          this.checkOutputBindings(call, scope);
        }
      });
    }
    return { errors: [...this.errors], warnings: [...this.warnings] };
  }

  /**
   * Check types for a complete compilation unit.
   * Walks all POUs, resolves expression types, and validates type rules.
   */
  check(ast: CompilationUnit): {
    errors: CompileError[];
    warnings: CompileError[];
  } {
    this.errors = [];
    this.warnings = [];
    this.strictReported.clear();
    this.ast = ast;
    this.writeTargets = new Set();
    walkAST(ast, (node) => {
      if (node.kind === "AssignmentStatement") {
        this.writeTargets.add((node as AssignmentStatement).target);
      } else if (node.kind === "RefAssignStatement") {
        this.writeTargets.add((node as RefAssignStatement).target);
      } else if (node.kind === "Argument" && (node as Argument).isOutput) {
        this.writeTargets.add((node as Argument).value);
      }
    });
    this.checkAllInitializerElements(ast);

    this.checkGlobalInitialCycles(ast);
    this.checkStructReferenceDefaults(ast);
    this.markGlobalVendorOperators(ast);

    // Init arguments of global FB instances (feature fb_init)
    if (this.features.has("fb_init")) {
      this.checkVarBlocks(
        ast.globalVarBlocks.map((b) => ({
          ...b,
          declarations: b.declarations.filter((d) => d.fbInitArguments),
        })),
        this.symbolTables.globalScope,
      );
    }

    // Walk all programs
    for (const prog of ast.programs) {
      const scope = this.symbolTables.getProgramScope(prog.name);
      if (scope) {
        this.currentProgram = prog;
        this.checkVarBlocks(prog.varBlocks, scope);
        this.checkStatements(prog.body, scope);
        for (const method of prog.methods) {
          const methodScope = this.symbolTables.getMethodScope(
            prog.name,
            method.name,
          );
          this.checkVarBlocks(method.varBlocks, methodScope ?? scope);
          this.checkAddressInitialOrder(method.varBlocks);
          if (method.returnType) {
            this.currentReturn = {
              name: method.name,
              type: method.returnType,
            };
          }
          this.checkStatements(method.body, methodScope ?? scope);
          this.currentReturn = undefined;
        }
        this.currentProgram = undefined;
      }
    }

    // Walk all functions
    for (const func of ast.functions) {
      const scope = this.symbolTables.getFunctionScope(func.name);
      if (scope) {
        this.checkVarBlocks(func.varBlocks, scope);
        this.checkAddressInitialOrder(func.varBlocks);
        this.currentReturn = { name: func.name, type: func.returnType };
        this.checkStatements(func.body, scope);
        this.currentReturn = undefined;
      }
    }

    // Walk all function blocks
    for (const fb of ast.functionBlocks) {
      const scope = this.symbolTables.getFBScope(fb.name);
      this.currentFBName = fb.name;
      if (scope) {
        // FB body
        this.checkVarBlocks(
          fb.varBlocks,
          scope,
          this.features.has("fb_init")
            ? fbInitArgumentScope(this.symbolTables, fbIndex(ast), fb, scope)
            : scope,
        );
        this.checkStatements(fb.body, scope);

        // Method bodies (use method scope for local variable resolution)
        for (const method of fb.methods) {
          const methodScope = this.symbolTables.getMethodScope(
            fb.name,
            method.name,
          );
          this.checkVarBlocks(method.varBlocks, methodScope ?? scope);
          this.checkAddressInitialOrder(method.varBlocks);
          if (method.returnType) {
            this.currentReturn = {
              name: method.name,
              type: method.returnType,
            };
          }
          this.checkStatements(method.body, methodScope ?? scope);
          this.currentReturn = undefined;
        }

        // Property getter/setter bodies
        for (const prop of fb.properties) {
          this.currentPropertyName = prop.name.toUpperCase();
          if (prop.getter) this.checkStatements(prop.getter, scope);
          if (prop.setter) this.checkStatements(prop.setter, scope);
          this.currentPropertyName = undefined;
        }
      }
      this.currentFBName = undefined;
    }

    return {
      errors: this.errors,
      warnings: this.warnings,
    };
  }

  // ===========================================================================
  // Expression Type Resolution (Sub-Phase B)
  // ===========================================================================

  /**
   * Resolve the type of an expression, setting resolvedType on the AST node.
   * Public so codegen can call it for standalone expressions.
   */
  resolveExprType(expr: Expression, scope: Scope): IECType | undefined {
    const type = this.inferType(expr, scope);
    if (type) {
      expr.resolvedType = type;
    }
    return type;
  }

  /**
   * Resolve a struct/FB/program field's declared type name, consulting the local
   * compilation unit first and then the dependency libraries' symbol entries.
   *
   * The members of an FB whose type is defined in an imported `.stlib` (e.g.
   * `rmp : _RMP_NEXT` where `_RMP_NEXT` lives in oscat-basic) are not in the local
   * AST, so the AST-only `resolveFieldType` returns undefined for `rmp.DN`. That
   * left the member access untyped, which only surfaced as a hard error when an
   * overloaded bitwise std-function (e.g. `NOT`/`OR` from the IEC functions library)
   * propagated the missing type as the generic `ANY_BIT` into a condition. Falling
   * back to the FB symbol's registered inputs/outputs/inouts/locals fixes the root
   * cause: `rmp.DN` now resolves to its real `BOOL` type.
   */
  private resolveFieldTypeAnywhere(
    typeName: string,
    fieldName: string,
  ): string | undefined {
    if (this.ast) {
      const local = resolveFieldType(typeName, fieldName, this.ast);
      if (local) return local;
    }
    // A library block's members and properties, then those of its bases.
    const fu = fieldName.toUpperCase();
    const seen = new Set<string>();
    let fb = this.symbolTables.lookupFunctionBlock(typeName);
    while (fb !== undefined && !seen.has(fb.name.toUpperCase())) {
      seen.add(fb.name.toUpperCase());
      for (const m of [
        ...fb.inputs,
        ...fb.outputs,
        ...fb.inouts,
        ...fb.locals,
        ...(fb.temps ?? []),
      ]) {
        if (m.name.toUpperCase() === fu) return m.declaration?.type?.name;
      }
      const prop = fb.declaration.properties.find(
        (p) => p.name.toUpperCase() === fu,
      );
      if (prop !== undefined && fb.libraryName !== undefined) {
        return prop.type.name;
      }
      const base =
        fb.libraryName !== undefined ? fb.declaration.extends : undefined;
      fb =
        base !== undefined
          ? this.symbolTables.lookupFunctionBlock(base)
          : undefined;
    }
    // Dependency struct types: their member types are carried on the registered
    // StructType (e.g. CONSTANTS_MATH.PI), so `MATH.PI` resolves to REAL.
    const ty = this.symbolTables.lookupType(typeName);
    if (ty?.resolvedType?.typeKind === "struct") {
      const fu = fieldName.toUpperCase();
      for (const [fname, ftype] of (ty.resolvedType as StructType).fields) {
        if (fname.toUpperCase() === fu) {
          return (ftype as { name?: string }).name;
        }
      }
    }
    return undefined;
  }

  /**
   * Report `a := b` where one side is a plain array and the other a plain
   * elementary or STRING variable or literal (no POINTER or reference
   * levels). Returns whether it reported.
   */
  private checkArrayScalarAssignment(
    target: Expression,
    value: Expression,
    scope: Scope,
  ): boolean {
    const kind = (expr: Expression): "array" | "scalar" | undefined => {
      if (expr.kind === "LiteralExpression") {
        return expr.literalType === "INT" ||
          expr.literalType === "REAL" ||
          expr.literalType === "BOOL"
          ? "scalar"
          : undefined;
      }
      if (expr.kind !== "VariableExpression" || !this.ast) return undefined;
      const sym = scope.lookup(expr.name);
      if (sym?.kind !== "variable" && sym?.kind !== "constant") {
        return undefined;
      }
      const declared = (sym.declaration as VarDeclaration | undefined)?.type;
      if (!declared) return undefined;
      const type = this.hasMemberAccess(expr)
        ? resolveAccessType(declared, expr, this.accessLookup)
        : declared;
      if (
        !type ||
        type.referenceKind !== "none" ||
        type.referenceChain !== undefined
      ) {
        return undefined;
      }
      if (type.arrayDimensions !== undefined) return "array";
      const upper = this.aliasBase(type.name);
      if (/^__(INLINE_ARRAY_|VLA_)/.test(upper)) return "array";
      const def = this.ast.types.find(
        (t) => t.name.toUpperCase() === upper,
      )?.definition;
      if (def?.kind === "ArrayDefinition") return "array";
      return def === undefined &&
        upper !== "__XWORD" &&
        ELEMENTARY_TYPES[canonicalElementaryName(upper)] !== undefined
        ? "scalar"
        : undefined;
    };
    const t = kind(target);
    const v = kind(value);
    if (t === undefined || v === undefined || t === v) return false;
    const span = value.sourceSpan;
    this.addError(
      t === "array"
        ? "Cannot assign a single value to an array"
        : "Cannot assign an array to a single value",
      span.startLine,
      span.startCol,
      span.file,
    );
    return true;
  }

  /**
   * The function block declaring `member` of `typeName` (or of a base) as an
   * internal variable (VAR, VAR_TEMP) or a VAR_EXTERNAL; undefined for an
   * interface variable or a name that is no FB member.
   */
  private internalMemberOwner(
    typeName: string,
    member: string,
  ): { name: string; kind: MemberKind; access?: VarAccess } | undefined {
    const upper = member.toUpperCase();
    const seen = new Set<string>();
    let current: string | undefined = typeName.toUpperCase();
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const name: string = current;
      const fb = this.ast?.functionBlocks.find(
        (f) => f.name.toUpperCase() === name,
      );
      if (fb !== undefined) {
        for (const block of fb.varBlocks) {
          const declared = block.declarations.some((d) =>
            d.names.some((n) => n.toUpperCase() === upper),
          );
          if (!declared) continue;
          const kind = MEMBER_KIND[block.blockType];
          if (kind === undefined) return undefined;
          const access = block.access?.[0];
          return access !== undefined
            ? { name: fb.name, kind, access }
            : { name: fb.name, kind };
        }
        current = fb.extends?.toUpperCase();
        continue;
      }
      const lib = this.symbolTables.lookupFunctionBlock(name);
      if (lib?.libraryName === undefined) return undefined;
      const named = (v: { name: string }): boolean =>
        v.name.toUpperCase() === upper;
      if (lib.inputs.some(named)) return { name: lib.name, kind: "input" };
      if (lib.outputs.some(named)) return { name: lib.name, kind: "output" };
      if (lib.inouts.some(named)) return { name: lib.name, kind: "inout" };
      const local = lib.locals.find(named);
      if (local !== undefined) {
        return local.access !== undefined
          ? { name: lib.name, kind: "internal", access: local.access }
          : { name: lib.name, kind: "internal" };
      }
      if ((lib.temps ?? []).some(named)) {
        return { name: lib.name, kind: "internal" };
      }
      current = lib.declaration.extends?.toUpperCase();
    }
    return undefined;
  }

  /** The function block `name` and the blocks it EXTENDS, upper case. */
  private fbLineage(name: string): Set<string> {
    const out = new Set<string>();
    let current: string | undefined = name.toUpperCase();
    while (current !== undefined && !out.has(current)) {
      out.add(current);
      const upper: string = current;
      const fb = this.ast?.functionBlocks.find(
        (f) => f.name.toUpperCase() === upper,
      );
      current =
        fb !== undefined
          ? fb.extends?.toUpperCase()
          : this.symbolTables
              .lookupFunctionBlock(upper)
              ?.declaration.extends?.toUpperCase();
    }
    return out;
  }

  /**
   * Refuse `inst.P` where P is a PRIVATE property of another block, or a
   * PROTECTED one outside its block and the blocks derived from it, as for
   * methods (`context`: the current block).
   */
  private refuseHiddenProperty(
    typeName: string,
    member: string,
    expr: { sourceSpan: SourceSpan },
    context: string | undefined,
  ): void {
    const upper = member.toUpperCase();
    const seen = new Set<string>();
    let current: string | undefined = typeName.toUpperCase();
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const name: string = current;
      const fb = this.ast?.functionBlocks.find(
        (f) => f.name.toUpperCase() === name,
      );
      if (fb === undefined) return;
      const prop = fb.properties.find((p) => p.name.toUpperCase() === upper);
      if (prop !== undefined) {
        const owner = fb.name.toUpperCase();
        const inside =
          context !== undefined &&
          (prop.visibility === "PRIVATE"
            ? context.toUpperCase() === owner
            : this.fbLineage(context).has(owner));
        if (prop.visibility === "PUBLIC" || inside) return;
        const span = expr.sourceSpan;
        const key = `${span.file ?? ""}:${span.startLine}:${span.startCol}:property:${upper}`;
        if (this.unknownMemberReported.has(key)) return;
        this.unknownMemberReported.add(key);
        this.addError(
          prop.visibility === "PRIVATE"
            ? `Cannot access PRIVATE property '${member}' of '${fb.name}' from outside '${fb.name}'.`
            : `Cannot access PROTECTED property '${member}' of '${fb.name}' from '${context ?? "PROGRAM"}'.`,
          span.startLine,
          span.startCol,
          span.file,
        );
        return;
      }
      current = fb.extends?.toUpperCase();
    }
  }

  /**
   * Refuse `inst.x` (or `x := ...` in an instance initializer) where x is an
   * internal variable or VAR_EXTERNAL of the instance's block, outside that
   * block and the blocks derived from it (`context`, the current block).
   */
  private refuseInternalMember(
    typeName: string,
    member: string,
    expr: { sourceSpan: SourceSpan },
    context: string | undefined = this.currentFBName,
    initializer = false,
  ): void {
    const upper = member.toUpperCase();
    if (upper === "EN" || upper === "ENO") return;
    const owner = this.internalMemberOwner(this.aliasBase(typeName), member);
    if (owner === undefined) {
      this.refuseHiddenProperty(
        this.aliasBase(typeName),
        member,
        expr,
        context,
      );
      return;
    }
    // An instance initializer writes; an access path writes when it is the target.
    const write = initializer || this.writeTargets.has(expr as Expression);
    if (
      (owner.kind === "input" && write) ||
      (owner.kind === "output" && !write)
    ) {
      return;
    }
    if (owner.access === "PUBLIC") return;
    const ownerUpper = owner.name.toUpperCase();
    const inside =
      context !== undefined &&
      (owner.access === "PRIVATE"
        ? context.toUpperCase() === ownerUpper
        : this.fbLineage(context).has(ownerUpper));
    if (inside) return;
    const span = expr.sourceSpan;
    const key = `${span.file ?? ""}:${span.startLine}:${span.startCol}:internal:${member.toUpperCase()}`;
    if (this.unknownMemberReported.has(key)) return;
    this.unknownMemberReported.add(key);
    const fb = `FUNCTION_BLOCK '${owner.name}'`;
    const message = {
      internal:
        owner.access === "PRIVATE"
          ? `'${member}' is a PRIVATE variable of ${fb}; only '${owner.name}' itself can access it`
          : `'${member}' is an internal variable of ${fb} and cannot be accessed from outside`,
      external: `'${member}' is a VAR_EXTERNAL of ${fb}, not a member it exposes, and cannot be accessed from outside`,
      input: `'${member}' is a VAR_INPUT of ${fb}; from outside it can be written, not read`,
      output: `'${member}' is a VAR_OUTPUT of ${fb}; from outside it can be read, not written`,
      inout: `'${member}' is a VAR_IN_OUT of ${fb}; from outside it is bound in the call, not accessed through the instance`,
    }[owner.kind];
    this.addError(message, span.startLine, span.startCol, span.file);
  }

  /**
   * A bare name in a derived block naming a base's PRIVATE property (a name
   * the block itself or the body's scope declares is no such property).
   */
  private refuseInheritedPrivateProperty(
    expr: VariableExpression,
    scope: Scope,
  ): void {
    if (
      this.currentFBName === undefined ||
      expr.fieldAccess.length > 0 ||
      (expr.accessChain?.length ?? 0) > 0
    ) {
      return;
    }
    const upper = expr.name.toUpperCase();
    const own = this.ast?.functionBlocks.find(
      (f) => f.name.toUpperCase() === this.currentFBName?.toUpperCase(),
    );
    if (own?.extends === undefined) return;
    if (own.properties.some((p) => p.name.toUpperCase() === upper)) return;
    const local = scope.lookup(expr.name);
    if (local !== undefined && local.kind !== "functionBlock") {
      const declaredHere = own.varBlocks.some((b) =>
        b.declarations.some((d) =>
          d.names.some((n) => n.toUpperCase() === upper),
        ),
      );
      if (declaredHere || scope.lookupLocal(expr.name) !== undefined) return;
    }
    this.refuseHiddenProperty(own.extends, expr.name, expr, this.currentFBName);
  }

  /** `THIS.x` / `SUPER.x` in a block: x may be a base's PRIVATE variable. */
  private refuseSelfMember(expr: VariableExpression): void {
    const self = expr.name.toUpperCase();
    if (
      (self !== "THIS" && self !== "SUPER") ||
      this.currentFBName === undefined
    ) {
      return;
    }
    const fb = this.ast?.functionBlocks.find(
      (f) => f.name.toUpperCase() === this.currentFBName?.toUpperCase(),
    );
    // Each step of `THIS.a.b[i].c`, from the own block or its base down.
    let type: string | undefined =
      self === "THIS" ? this.currentFBName : fb?.extends;
    const steps =
      expr.accessChain ??
      expr.fieldAccess.map((name) => ({ kind: "field" as const, name }));
    for (const step of steps) {
      if (type === undefined || step.kind === "dereference") return;
      if (step.kind === "subscript") {
        if (this.ast) {
          type = resolveArrayElementType(type, this.ast) ?? type;
        }
        continue;
      }
      this.refuseInternalMember(type, step.name, expr);
      type = this.resolveFieldTypeAnywhere(this.aliasBase(type), step.name);
    }
  }

  /** Assignment and REF= targets and `=>` output targets of the unit: the access paths that write. */
  private writeTargets = new Set<Expression>();

  /** Unknown-member reports already made, so an expression visited twice reports once. */
  private unknownMemberReported = new Set<string>();

  /**
   * Report `v.name` when `ownerName` is a type whose members are all known
   * here and none is `name`: an elementary or STRING value, a STRUCT whose
   * EXTENDS chain is declared here, or a function block whose EXTENDS chain is
   * declared here (methods, actions and properties count as members).
   */
  private reportUnknownMember(
    ownerName: string,
    name: string,
    expr: VariableExpression,
    scope: Scope,
  ): void {
    if (!this.ast || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return;
    const memberUpper = name.toUpperCase();
    if (memberUpper === "EN" || memberUpper === "ENO") return;
    const upper = this.aliasBase(ownerName);
    if (this.resolveFieldTypeAnywhere(upper, name) !== undefined) return;
    let what: string | undefined;
    if (ELEMENTARY_TYPES[canonicalElementaryName(upper)] !== undefined) {
      // `w.C_BIT`: a bit selected by a named constant, not a member.
      const sym = scope.lookup(name);
      if (sym?.kind === "constant" || sym?.kind === "variable") {
        const last = expr.fieldAccess[expr.fieldAccess.length - 1];
        if (
          getBitAccessWidth(canonicalElementaryName(upper)) !== undefined &&
          last?.toUpperCase() === memberUpper
        ) {
          expr.namedBitIndex = true;
        }
        return;
      }
      what = `A value of type '${upper}'`;
    } else if (this.isClosedStruct(upper)) {
      what = `STRUCT '${upper}'`;
    } else if (this.isClosedFunctionBlock(upper, memberUpper)) {
      what = `Function block '${upper}'`;
    }
    if (what === undefined) return;
    const span = expr.sourceSpan;
    const key = `${span.file ?? ""}:${span.startLine}:${span.startCol}:${memberUpper}`;
    if (this.unknownMemberReported.has(key)) return;
    this.unknownMemberReported.add(key);
    this.addError(
      `${what} has no member '${name}'`,
      span.startLine,
      span.startCol,
      span.file,
    );
  }

  /**
   * Check every declaration's structure initializers. A type-level default
   * (`TYPE T : ST := (...)`) is not: g++ only sees it once a variable uses it.
   */
  private checkAllInitializerElements(ast: CompilationUnit): void {
    // A type's own default has its own check and message.
    this.typeDefaults = new Set(
      ast.types.flatMap((t) => (t.defaultValue ? [t.defaultValue] : [])),
    );
    // Declarations of a function block, with the block as the context of
    // its initializers, then every other declaration.
    const seen = new Set<VarDeclaration>();
    const visit = (root: ASTNode, context: string | undefined): void =>
      walkAST(root, (node) => {
        if (node.kind !== "VarDeclaration") return;
        const decl = node as VarDeclaration;
        if (seen.has(decl)) return;
        seen.add(decl);
        if (decl.initialValue) {
          this.checkInitializerElements(decl.type, decl.initialValue, context);
        }
      });
    for (const fb of ast.functionBlocks) visit(fb, fb.name);
    visit(ast, undefined);
    for (const t of ast.types) {
      if (t.defaultValue && t.definition.kind === "TypeReference") {
        this.checkCharInitialValue(t.name, t.defaultValue);
      }
    }
  }

  /**
   * Report an element a structure initializer names that its STRUCT or
   * function block does not have, at any depth: `(zz := 1)`, `[(zz := 1)]`,
   * `(p := (zz := 1))`. Only types whose whole EXTENDS chain is declared here.
   */
  private checkInitializerElements(
    type: AccessType | undefined,
    value: Expression,
    context?: string,
  ): void {
    if (
      !this.ast ||
      !type ||
      type.referenceKind !== "none" ||
      type.referenceChain !== undefined
    ) {
      return;
    }
    if (value.kind === "ArrayLiteralExpression") {
      const element: AccessType | undefined =
        type.arrayDimensions !== undefined
          ? type.elementTypeName !== undefined &&
            type.elementReferenceChain === undefined
            ? { name: type.elementTypeName, referenceKind: "none" }
            : undefined
          : resolveArrayElementAccessType(type.name, this.ast);
      for (const e of value.elements) {
        this.checkInitializerElements(element, e, context);
      }
      return;
    }
    if (
      value.kind !== "StructInitializerExpression" &&
      type.arrayDimensions === undefined
    ) {
      this.checkCharInitialValue(type.name, value);
      this.checkEnumInitialValue(type.name, value);
    }
    if (
      value.kind !== "StructInitializerExpression" ||
      type.arrayDimensions !== undefined
    ) {
      return;
    }
    const upper = this.aliasBase(type.name);
    for (const el of value.elements) {
      const field = resolveFieldDeclaration(upper, el.name, this.ast);
      this.refuseInternalMember(upper, el.name, el, context, true);
      if (field) {
        this.checkInitializerElements(field.type, el.value, context);
        continue;
      }
      if (this.resolveFieldTypeAnywhere(upper, el.name) !== undefined) continue;
      const memberUpper = el.name.toUpperCase();
      let what: string | undefined;
      if (this.isClosedStruct(upper)) {
        what = `STRUCT '${upper}'`;
      } else if (
        memberUpper !== "EN" &&
        memberUpper !== "ENO" &&
        this.isClosedFunctionBlock(upper, memberUpper)
      ) {
        what = `Function block '${upper}'`;
      }
      if (what === undefined) continue;
      const span = el.sourceSpan;
      const key = `${span.file ?? ""}:${span.startLine}:${span.startCol}:${memberUpper}`;
      if (this.unknownMemberReported.has(key)) continue;
      this.unknownMemberReported.add(key);
      this.addError(
        `${what} has no member '${el.name}'`,
        span.startLine,
        span.startCol,
        span.file,
      );
    }
  }

  /**
   * The initial value of a variable, field or element declared with an
   * enumeration type (not an alias of one) is a value of that enumeration.
   * A value whose type is not known here is left alone.
   */
  private checkEnumInitialValue(typeName: string, value: Expression): void {
    if (this.typeDefaults.has(value)) return;
    const target = this.symbolTables.lookupType(typeName)?.resolvedType;
    if (target?.typeKind !== "enum") return;
    const fail = (message: string): void =>
      this.addError(
        message,
        value.sourceSpan.startLine,
        value.sourceSpan.startCol,
        value.sourceSpan.file,
      );
    // `E#Z` / `E.Z` naming no value of E
    if (
      value.kind === "VariableExpression" &&
      value.fieldAccess.length === 1 &&
      value.subscripts.length === 0 &&
      !value.isDereference
    ) {
      const named = this.symbolTables.lookupType(value.name)?.resolvedType;
      const member = value.fieldAccess[0]!;
      if (
        named?.typeKind === "enum" &&
        !(named as EnumType).values.some(
          (v) => v.toUpperCase() === member.toUpperCase(),
        )
      ) {
        fail(
          `'${member.toUpperCase()}' is not a value of enumeration ${typeNameUtil(named)}`,
        );
        return;
      }
    }
    const valueType = this.resolveExprType(
      value,
      this.symbolTables.globalScope,
    );
    if (valueType === undefined) return;
    const sameEnum =
      valueType.typeKind === "enum" &&
      typeNameUtil(valueType).toUpperCase() ===
        typeNameUtil(target).toUpperCase();
    const known =
      valueType.typeKind === "enum" ||
      (valueType.typeKind === "elementary" &&
        ELEMENTARY_TYPES[(valueType as ElementaryType).name.toUpperCase()] !==
          undefined);
    if (!sameEnum && known) {
      fail(
        `Cannot assign ${typeNameUtil(valueType)} to ${typeNameUtil(target)}`,
      );
    }
  }

  /** A STRUCT (not a UNION) whose whole EXTENDS chain this compile declares. */
  private isClosedStruct(upper: string): boolean {
    const seen = new Set<string>();
    let current: string | undefined = upper;
    while (current !== undefined) {
      if (seen.has(current)) return false;
      seen.add(current);
      const name: string = current;
      const decl = this.ast?.types.find((t) => t.name.toUpperCase() === name);
      if (decl?.definition.kind !== "StructDefinition") return false;
      if (decl.definition.isUnion) return false;
      current = decl.extends?.name.toUpperCase();
    }
    return true;
  }

  /**
   * A function block whose whole EXTENDS chain this compile declares and no
   * block of which has a method, action or property named `memberUpper`.
   */
  private isClosedFunctionBlock(upper: string, memberUpper: string): boolean {
    const seen = new Set<string>();
    let current: string | undefined = upper;
    while (current !== undefined) {
      if (seen.has(current)) return false;
      seen.add(current);
      const name: string = current;
      const fb = this.ast?.functionBlocks.find(
        (f) => f.name.toUpperCase() === name,
      );
      const named = (n: { name: string }): boolean =>
        n.name.toUpperCase() === memberUpper;
      if (!fb) {
        // A library block whose archive lists all its members.
        const lib = this.symbolTables.lookupFunctionBlock(name);
        if (lib?.libraryMethodNames === undefined) return false;
        if (
          lib.libraryMethodNames.some((m) => m.toUpperCase() === memberUpper) ||
          lib.declaration.properties.some(named)
        ) {
          return false;
        }
        current = lib.declaration.extends?.toUpperCase();
        continue;
      }
      if (
        fb.methods.some(named) ||
        fb.actions.some(named) ||
        fb.properties.some(named)
      ) {
        return false;
      }
      current = fb.extends?.toUpperCase();
    }
    return true;
  }

  /**
   * Resolve a type *name* to its IECType: an elementary type, else a registered
   * type (struct/FB/enum from the local AST or a dependency library), else a
   * minimal elementary placeholder. Using the registered type (rather than always
   * wrapping the name in a placeholder elementary) keeps member/array-element
   * access consistent with how a variable's declared type resolves — otherwise
   * `event := prog[pos]` where both are a library struct would compare a real
   * StructType against a placeholder elementary and be wrongly rejected.
   */
  private resolveNamedType(name: string): IECType {
    return (
      ELEMENTARY_TYPES[name.toUpperCase()] ??
      this.symbolTables.lookupType(name)?.resolvedType ??
      ({ typeKind: "elementary", name, sizeBits: 0 } as ElementaryType)
    );
  }

  /**
   * Infer the type of an expression.
   */
  inferType(expr: Expression, scope: Scope): IECType | undefined {
    switch (expr.kind) {
      case "LiteralExpression":
        return this.inferLiteralType(expr);
      case "VariableExpression":
        return this.inferVariableType(expr, scope);
      case "BinaryExpression":
        return this.inferBinaryType(expr, scope);
      case "UnaryExpression":
        return this.inferUnaryType(expr, scope);
      case "FunctionCallExpression":
        return this.inferFunctionCallType(expr, scope);
      case "MethodCallExpression":
        return this.inferMethodCallType(expr, scope);
      case "ParenthesizedExpression": {
        const inner = this.inferType(expr.expression, scope);
        if (inner) expr.resolvedType = inner;
        return inner;
      }
      case "RefExpression": {
        const operandType = this.resolveExprType(expr.operand, scope);
        if (this.refuseStringElement(expr.operand, "REF() cannot take")) {
          return undefined;
        }
        if (operandType) {
          const refType: ReferenceType = {
            typeKind: "reference",
            referencedType: operandType,
            isImplicitDeref: false,
          };
          expr.resolvedType = refType;
          return refType;
        }
        return undefined;
      }
      case "DrefExpression": {
        const operandType = this.resolveExprType(expr.operand, scope);
        if (operandType?.typeKind === "reference") {
          const derefType = (operandType as ReferenceType).referencedType;
          expr.resolvedType = derefType;
          return derefType;
        }
        return undefined;
      }
      case "NewExpression": {
        const allocType =
          ELEMENTARY_TYPES[expr.allocationType.name.toUpperCase()];
        if (allocType) {
          const refType: ReferenceType = {
            typeKind: "reference",
            referencedType: allocType,
            isImplicitDeref: false,
          };
          expr.resolvedType = refType;
          return refType;
        }
        return undefined;
      }
      case "ArrayLiteralExpression": {
        // Array literals don't have an inherent type — they get their type from the assignment target
        return undefined;
      }
      default:
        return undefined;
    }
  }

  /**
   * Infer type of a literal expression.
   */
  private inferLiteralType(expr: LiteralExpression): IECType | undefined {
    if (expr.typePrefix) {
      const prefixType = ELEMENTARY_TYPES[expr.typePrefix.toUpperCase()];
      if (prefixType) {
        expr.resolvedType = prefixType;
        return prefixType;
      }
    }
    let type: IECType | undefined;
    switch (expr.literalType) {
      case "BOOL":
        type = ELEMENTARY_TYPES["BOOL"];
        break;
      case "INT":
        type = ELEMENTARY_TYPES["INT"];
        break;
      case "REAL":
        type = ELEMENTARY_TYPES["REAL"];
        break;
      case "STRING":
        type = ELEMENTARY_TYPES["STRING"];
        break;
      case "WSTRING":
        type = ELEMENTARY_TYPES["WSTRING"];
        break;
      case "TIME":
        type = ELEMENTARY_TYPES["TIME"];
        break;
      case "LTIME":
        type = ELEMENTARY_TYPES["LTIME"];
        break;
      case "DATE":
        type = ELEMENTARY_TYPES["DATE"];
        break;
      case "TIME_OF_DAY":
        type = ELEMENTARY_TYPES["TIME_OF_DAY"];
        break;
      case "DATE_AND_TIME":
        type = ELEMENTARY_TYPES["DATE_AND_TIME"];
        break;
      case "LDATE":
        type = ELEMENTARY_TYPES["LDATE"];
        break;
      case "LTIME_OF_DAY":
        type = ELEMENTARY_TYPES["LTOD"];
        break;
      case "LDATE_AND_TIME":
        type = ELEMENTARY_TYPES["LDT"];
        break;
      case "CHAR":
        type = ELEMENTARY_TYPES["CHAR"];
        break;
      case "WCHAR":
        type = ELEMENTARY_TYPES["WCHAR"];
        break;
      case "NULL":
        return undefined;
      default:
        return undefined;
    }
    if (type) expr.resolvedType = type;
    return type;
  }

  /**
   * The enumeration an enumeration value belongs to: `E#M`, `E.M`, or a bare
   * member. A bare member of several enumerations has a type only once the
   * analyzer settled it from its context (`enumType`).
   */
  private enumValueType(
    expr: VariableExpression,
    symbol: AnySymbol,
  ): IECType | undefined {
    if (expr.subscripts.length > 0 || expr.isDereference) return undefined;
    const enumNamed = (name: string): EnumType | undefined => {
      const type = this.symbolTables.lookupType(name)?.resolvedType;
      return type?.typeKind === "enum" ? (type as EnumType) : undefined;
    };
    const hasMember = (type: EnumType, member: string): boolean =>
      type.values.some((v) => v.toUpperCase() === member.toUpperCase());
    if (symbol.kind === "type") {
      const type = enumNamed(symbol.name);
      return type !== undefined &&
        expr.fieldAccess.length === 1 &&
        hasMember(type, expr.fieldAccess[0]!)
        ? type
        : undefined;
    }
    if (symbol.kind !== "enumValue" || expr.fieldAccess.length > 0) {
      return undefined;
    }
    // Inside a property, its own name is the value it returns or receives.
    if (expr.name.toUpperCase() === this.currentPropertyName) return undefined;
    if (expr.enumType !== undefined) return enumNamed(expr.enumType);
    const owners = (this.ast?.types ?? []).filter(
      (t) =>
        t.definition.kind === "EnumDefinition" &&
        t.definition.members.some(
          (m) => m.name.toUpperCase() === expr.name.toUpperCase(),
        ),
    );
    return owners.length === 1 ? enumNamed(owners[0]!.name) : undefined;
  }

  /**
   * Infer type of a variable expression, including access chain resolution.
   */
  private inferVariableType(
    expr: VariableExpression,
    scope: Scope,
  ): IECType | undefined {
    this.refuseInheritedPrivateProperty(expr, scope);
    const symbol = scope.lookup(expr.name);
    if (symbol === undefined) {
      this.refuseSelfMember(expr);
      // Don't report error here — Pass 3 undeclared-variable check handles this
      return undefined;
    }

    const enumValueType = this.enumValueType(expr, symbol);
    if (enumValueType) return enumValueType;

    // `PRG_A.x`: a member of the program's one instance (feature program_methods)
    const programMember =
      symbol.kind === "program" &&
      this.features.has("program_methods") &&
      (expr.accessChain?.[0]?.kind === "field" ||
        (expr.accessChain === undefined && expr.fieldAccess.length > 0));
    if (
      symbol.kind !== "variable" &&
      symbol.kind !== "constant" &&
      !programMember
    ) {
      return undefined;
    }

    let currentType: IECType | undefined =
      symbol.kind === "program" ? undefined : symbol.type;
    let currentTypeName: string | undefined =
      symbol.kind === "program" ? symbol.name : undefined;

    if (currentType?.typeKind === "elementary") {
      currentTypeName = (currentType as ElementaryType).name;
    } else if (currentType && symbol.kind !== "program") {
      // For non-elementary types, use the declaration type name
      currentTypeName = symbol.declaration?.type?.name;
    }

    this.refuseReferenceToCaret(expr, symbol);

    // Whether the storage reached so far lies in a UNION (reset by a dereference).
    let inUnion = false;

    // Resolve access chain (accessChain is the preferred path)
    if (expr.accessChain && expr.accessChain.length > 0 && this.ast) {
      for (const step of expr.accessChain) {
        if (!currentTypeName) break;

        if (step.kind === "field") {
          if (this.isUnionStorageType(currentTypeName)) inUnion = true;
          // Resolve struct/FB field (local AST + dependency-library FB members)
          const fieldType = this.resolveFieldTypeAnywhere(
            currentTypeName,
            step.name,
          );
          this.refuseInternalMember(currentTypeName, step.name, expr);
          if (fieldType) {
            currentTypeName = fieldType;
            currentType = this.resolveNamedType(fieldType);
          } else {
            // Check if it's a numeric bit access (e.g., var.0)
            if (/^\d+$/.test(step.name)) {
              currentType = ELEMENTARY_TYPES["BOOL"];
              currentTypeName = "BOOL";
            } else {
              if (currentType?.typeKind !== "reference") {
                this.reportUnknownMember(
                  currentTypeName,
                  step.name,
                  expr,
                  scope,
                );
              }
              currentType = undefined;
              currentTypeName = undefined;
            }
          }
        } else if (step.kind === "subscript") {
          this.refuseStringIndexCount(
            currentTypeName,
            step.indices.length,
            expr,
          );
          // Resolve array element type
          const arrayElem = resolveArrayElementType(currentTypeName, this.ast);
          const stringElem =
            arrayElem === undefined
              ? this.stringElementType(currentTypeName, step.indices.length)
              : undefined;
          if (stringElem !== undefined) expr.stringElement = true;
          const elemType = arrayElem ?? stringElem;
          if (elemType) {
            currentTypeName = elemType;
            currentType = this.resolveNamedType(elemType);
          } else {
            currentType = undefined;
            currentTypeName = undefined;
          }
          // Also resolve the index expressions
          for (const idx of step.indices) {
            this.resolveExprType(idx, scope);
            this.refuseEnumIndex(idx);
          }
        } else if (step.kind === "dereference") {
          inUnion = false;
          if (currentType?.typeKind === "reference") {
            currentType = (currentType as ReferenceType).referencedType;
            if (currentType.typeKind === "elementary") {
              currentTypeName = (currentType as ElementaryType).name;
            }
          } else {
            currentType = undefined;
            currentTypeName = undefined;
          }
        }
      }
    } else if (this.ast) {
      // Fallback: use legacy fieldAccess + subscripts
      // Resolve subscripts (array indexing on the base variable)
      if (expr.subscripts.length > 0 && currentTypeName) {
        for (const sub of expr.subscripts) {
          this.resolveExprType(sub, scope);
          this.refuseEnumIndex(sub);
        }
        const arrayElem = resolveArrayElementType(currentTypeName, this.ast);
        const stringElem =
          arrayElem === undefined
            ? this.stringElementType(currentTypeName, expr.subscripts.length)
            : undefined;
        if (stringElem !== undefined) expr.stringElement = true;
        const elemType = arrayElem ?? stringElem;
        if (elemType) {
          currentTypeName = elemType;
          currentType = this.resolveNamedType(elemType);
        }
      }

      // Resolve field access chain
      if (expr.fieldAccess.length > 0 && currentTypeName) {
        for (const field of expr.fieldAccess) {
          if (!currentTypeName) break;

          if (/^\d+$/.test(field)) {
            // Bit access
            currentType = ELEMENTARY_TYPES["BOOL"];
            currentTypeName = "BOOL";
          } else {
            if (this.isUnionStorageType(currentTypeName)) inUnion = true;
            const fieldType = this.resolveFieldTypeAnywhere(
              currentTypeName,
              field,
            );
            this.refuseInternalMember(currentTypeName, field, expr);
            if (fieldType) {
              currentTypeName = fieldType;
              currentType = this.resolveNamedType(fieldType);
            } else {
              if (currentType?.typeKind !== "reference") {
                this.reportUnknownMember(currentTypeName, field, expr, scope);
              }
              currentType = undefined;
              currentTypeName = undefined;
            }
          }
        }
      }

      // Handle dereference
      if (expr.isDereference) inUnion = false;
      if (expr.isDereference && currentType?.typeKind === "reference") {
        currentType = (currentType as ReferenceType).referencedType;
      }
    }

    if (inUnion) expr.unionMember = true;
    else delete expr.unionMember;

    if (currentType) {
      expr.resolvedType = currentType;
    }
    return currentType;
  }

  /** Variables already checked by refuseReferenceToCaret. */
  private checkedReferenceCarets = new WeakSet<VariableExpression>();

  /**
   * `rr^` with `rr` a REFERENCE TO: the reference is dereferenced
   * implicitly, so `^` names nothing (the C++ has no such operator).
   */
  private refuseReferenceToCaret(
    expr: VariableExpression,
    symbol: AnySymbol,
  ): void {
    if (this.checkedReferenceCarets.has(expr)) return;
    this.checkedReferenceCarets.add(expr);
    if (symbol.kind !== "variable") return;
    const type = (symbol.declaration as VarDeclaration | undefined)?.type;
    if (
      type?.referenceKind !== "reference_to" ||
      (type.referenceChain?.length ?? 1) !== 1 ||
      type.arrayDimensions !== undefined
    ) {
      return;
    }
    const first = expr.accessChain?.[0];
    const caret =
      first !== undefined
        ? first.kind === "dereference"
        : expr.isDereference &&
          expr.fieldAccess.length === 0 &&
          expr.subscripts.length === 0;
    if (!caret) return;
    this.addError(
      `'${expr.name}' is a REFERENCE TO, dereferenced implicitly: '^' does not apply to it`,
      expr.sourceSpan.startLine,
      expr.sourceSpan.startCol,
      expr.sourceSpan.file,
    );
  }

  /**
   * Infer type of a binary expression.
   */
  private inferBinaryType(
    expr: BinaryExpression,
    scope: Scope,
  ): IECType | undefined {
    let leftType = this.resolveExprType(expr.left, scope);
    let rightType = this.resolveExprType(expr.right, scope);
    delete expr.comparesReferences;
    if (
      (expr.operator === "=" || expr.operator === "<>") &&
      (this.isReferenceItself(expr.left, scope) ||
        this.isReferenceItself(expr.right, scope))
    ) {
      expr.comparesReferences = true;
    }

    if (leftType === undefined || rightType === undefined) {
      return undefined;
    }

    // CHAR and WCHAR: compared only with their own type, no arithmetic.
    const leftChar = this.charTypeOf(leftType);
    const rightChar = this.charTypeOf(rightType);
    if (leftChar !== undefined || rightChar !== undefined) {
      if (this.adaptCharLiteral(expr.right, leftChar)) {
        rightType = expr.right.resolvedType!;
      } else if (this.adaptCharLiteral(expr.left, rightChar)) {
        leftType = expr.left.resolvedType!;
      }
      return this.inferCharBinaryType(expr, leftType, rightType);
    }

    if (this.strict && STRICT_ARITHMETIC_OPS.has(expr.operator)) {
      this.checkStrictArithmetic(expr, leftType, rightType);
    }
    // The result of arithmetic on an enumeration has no type to check further.
    if (this.checkEnumOperands(expr, leftType, rightType)) return undefined;
    if (expr.operator === "MOD") this.refuseRealMod(expr, leftType, rightType);

    let type: IECType | undefined;

    // Comparison operators always return BOOL
    if (["=", "<>", "<", ">", "<=", ">="].includes(expr.operator)) {
      type = ELEMENTARY_TYPES["BOOL"];
    }
    // Logical operators return BOOL
    else if (["AND", "OR", "XOR"].includes(expr.operator)) {
      type =
        this.bitwiseResultType(leftType, rightType) ?? ELEMENTARY_TYPES["BOOL"];
    }
    // IEC 61131-3 date/time arithmetic (table 30 of the standard).
    // Date types are int64_t aliases at the C++ level so the operator-
    // overload returns IECVar<int64_t>, but the *semantic* result type
    // depends on the operands:
    //   DT/DATE/TOD - DT/DATE/TOD = TIME   (duration between two instants)
    //   DT/DATE/TOD ± TIME       = DT/DATE/TOD (instant offset)
    // Without these rules the type checker collapses DT - DT to DT,
    // which then refuses assignment to a TIME variable (the natural use
    // of the difference). This breaks RTC-style code that captures an
    // offset between two datetimes — including the Additional Function
    // Blocks library's RTC FB and any user code doing date arithmetic.
    else if (
      ["+", "-"].includes(expr.operator) &&
      isDateTimeArithmetic(leftType, rightType, expr.operator)
    ) {
      type = resolveDateTimeArithmetic(leftType, rightType, expr.operator);
    }
    // Arithmetic operators return the "wider" type
    else if (["+", "-", "*", "/", "MOD", "**"].includes(expr.operator)) {
      type = getCommonType(leftType, rightType) ?? leftType;
    } else {
      type = leftType;
    }

    if (type) expr.resolvedType = type;
    return type;
  }

  /**
   * MAX, MIN, LIMIT, the comparison functions, SEL and MUX on CHAR or WCHAR:
   * a one-character literal is that character, and every compared argument
   * is the same character type (no implicit conversion to a number).
   */
  private checkCharStdArguments(expr: FunctionCallExpression): void {
    const name = expr.functionName.toUpperCase();
    const skip = CHAR_COMPARE_FUNCTIONS.get(name);
    if (skip === undefined || this.findUserFunction(name)) return;
    if (
      this.symbolTables.lookupFunction(name) !== undefined &&
      this.symbolTables.lookupFunction(name)?.libraryName !==
        STD_FUNCTIONS_LIBRARY
    ) {
      return;
    }
    const args = stripEnEno(expr.arguments).slice(skip);
    const charType = args
      .map((a) => this.charTypeOf(a.value.resolvedType))
      .find((t) => t !== undefined);
    if (charType === undefined) return;
    for (const arg of args) {
      this.adaptCharLiteral(arg.value, charType);
      const t = arg.value.resolvedType;
      if (
        t !== undefined &&
        this.charTypeOf(t) !== charType &&
        !this.reportedCharValues.has(arg.value)
      ) {
        this.reportedCharValues.add(arg.value);
        this.addError(
          `Argument of '${name}' is ${typeNameUtil(t)} where the others are ${charType}; ${charType} does not convert implicitly`,
          arg.value.sourceSpan.startLine,
          arg.value.sourceSpan.startCol,
          arg.value.sourceSpan.file,
        );
      }
    }
  }

  /**
   * A CHAR or WCHAR operand: comparison with the same character type only, and
   * no arithmetic or logic, as neither converts implicitly to a number.
   */
  private inferCharBinaryType(
    expr: BinaryExpression,
    leftType: IECType,
    rightType: IECType,
  ): IECType | undefined {
    const fail = (message: string): undefined => {
      this.addError(
        message,
        expr.sourceSpan.startLine,
        expr.sourceSpan.startCol,
        expr.sourceSpan.file,
      );
      return undefined;
    };
    const charType = this.charTypeOf(leftType) ?? this.charTypeOf(rightType)!;
    if (!COMPARISON_OPS.has(expr.operator)) {
      return fail(`Operator '${expr.operator}' does not apply to ${charType}`);
    }
    if (this.charTypeOf(leftType) !== this.charTypeOf(rightType)) {
      fail(
        `Cannot compare ${typeNameUtil(leftType)} with ${typeNameUtil(rightType)}`,
      );
    }
    const type = ELEMENTARY_TYPES["BOOL"]!;
    expr.resolvedType = type;
    return type;
  }

  /**
   * AND, OR or XOR with a bit-string operand (BYTE to LWORD): the wider
   * bit string of the two. Undefined otherwise (BOOL operands give BOOL).
   */
  private bitwiseResultType(
    leftType: IECType,
    rightType: IECType,
  ): IECType | undefined {
    const bits = [leftType, rightType].flatMap((t) => {
      if (t.typeKind !== "elementary") return [];
      const name = this.aliasBase((t as ElementaryType).name);
      return STRICT_BIT_STRINGS.has(name) ? [ELEMENTARY_TYPES[name]!] : [];
    });
    if (bits.length === 0) return undefined;
    return bits.reduce((a, b) => (b.sizeBits > a.sizeBits ? b : a));
  }

  /**
   * MOD takes integers (ANY_INT, IEC 61131-3 Table 29): a REAL or LREAL
   * operand is refused, in every mode, as the C++ build would fail.
   */
  private refuseRealMod(
    expr: BinaryExpression,
    leftType: IECType,
    rightType: IECType,
  ): void {
    for (const [operand, type] of [
      [expr.left, leftType],
      [expr.right, rightType],
    ] as const) {
      if (type.typeKind !== "elementary") continue;
      const name = this.aliasBase((type as ElementaryType).name);
      if (name !== "REAL" && name !== "LREAL") continue;
      this.addError(
        `MOD takes integers (ANY_INT, IEC 61131-3 Table 29), not ${name}`,
        operand.sourceSpan.startLine,
        operand.sourceSpan.startCol,
        operand.sourceSpan.file,
      );
      return;
    }
  }

  /**
   * An enumeration is not a number: it has no arithmetic or logic, and it
   * compares only with its own enumeration. A named type that may alias the
   * enumeration is left alone. True when an arithmetic or logic operator was
   * refused.
   */
  private checkEnumOperands(
    expr: BinaryExpression,
    leftType: IECType,
    rightType: IECType,
  ): boolean {
    const leftEnum = leftType.typeKind === "enum";
    const rightEnum = rightType.typeKind === "enum";
    if (!leftEnum && !rightEnum) return false;
    const fail = (message: string): void =>
      this.addError(
        message,
        expr.sourceSpan.startLine,
        expr.sourceSpan.startCol,
        expr.sourceSpan.file,
      );
    if (!COMPARISON_OPS.has(expr.operator)) {
      fail(enumOperatorMessage(expr.operator, leftEnum ? leftType : rightType));
      return true;
    }
    const other = leftEnum ? rightType : leftType;
    const differs =
      leftEnum && rightEnum
        ? typeNameUtil(leftType).toUpperCase() !==
          typeNameUtil(rightType).toUpperCase()
        : other.typeKind === "elementary" &&
          ELEMENTARY_TYPES[(other as ElementaryType).name.toUpperCase()] !==
            undefined;
    if (differs) {
      fail(
        `Cannot compare ${typeNameUtil(leftType)} with ${typeNameUtil(rightType)}`,
      );
    }
    return false;
  }

  /**
   * Infer type of a unary expression.
   */
  private inferUnaryType(
    expr: UnaryExpression,
    scope: Scope,
  ): IECType | undefined {
    const operandType = this.resolveExprType(expr.operand, scope);

    if (operandType === undefined) {
      return undefined;
    }

    if (operandType.typeKind === "enum" && expr.operator !== "+") {
      this.addError(
        enumOperatorMessage(expr.operator, operandType),
        expr.sourceSpan.startLine,
        expr.sourceSpan.startCol,
        expr.sourceSpan.file,
      );
      return undefined;
    }

    let type: IECType | undefined;
    if (expr.operator === "NOT") {
      // NOT preserves the operand type for bit types (NOT BYTE returns BYTE)
      type = operandType;
    } else {
      // Unary + and - preserve the operand type
      type = operandType;
    }

    if (type) expr.resolvedType = type;
    return type;
  }

  /**
   * Infer type of a function call expression. SEL, MUX, LIMIT, MAX and MIN
   * of CHAR (or WCHAR) arguments yield that type, not their generic result.
   */
  private inferFunctionCallType(
    expr: FunctionCallExpression,
    scope: Scope,
  ): IECType | undefined {
    const type = this.inferCallType(expr, scope);
    const charType = this.charSelectionType(expr);
    if (charType === undefined) return type;
    expr.resolvedType = ELEMENTARY_TYPES[charType]!;
    return expr.resolvedType;
  }

  private inferCallType(
    expr: FunctionCallExpression,
    scope: Scope,
  ): IECType | undefined {
    this.bindStdFunctionCallArguments(expr, scope);
    // Resolve argument expressions
    for (const arg of expr.arguments) {
      this.resolveExprType(arg.value, scope);
    }
    this.refuseNarrowAddressArguments(expr, scope);
    this.checkCharStdArguments(expr);
    this.adaptCharConversionArgument(expr);
    this.validateReferenceArguments(expr, scope);
    this.checkOutputBindings(expr, scope);
    this.checkDottedMethodCall(expr, scope);
    this.checkMethodCallArgumentNames(expr, scope);
    this.checkFunctionCallArgumentNames(expr, scope);
    const inputs =
      this.callInputs(expr, scope) ??
      this.dottedMethodInputs(expr.functionName, scope);
    this.adaptCharArguments(
      inputs ?? this.anyCallInputs(expr, scope),
      expr.arguments,
    );
    this.validateInterfaceArguments(inputs, expr.arguments);
    this.markPointerZeroArguments(inputs, expr.arguments);
    this.validateStructArguments(inputs, expr.arguments);
    this.validateEnumArguments(inputs, expr.arguments);
    this.validateReferenceToArguments(inputs, expr.arguments, scope);
    this.validateInOutArguments(
      inputs,
      expr.arguments,
      scope,
      this.isFBInstanceCall(expr, scope),
      expr,
    );
    if (this.strict) {
      this.checkStrictArguments(
        this.callInputs(expr, scope) ??
          this.dottedMethodInputs(expr.functionName, scope),
        expr.arguments,
        scope,
      );
    }

    const nameUpper = expr.functionName.toUpperCase();

    // `PRG_A.M(...)`: a method of a program's one instance (program_methods)
    const reachedMethod = this.reachedProgramMethod(expr.functionName, scope);
    if (reachedMethod) {
      const retType = this.methodReturnType(reachedMethod);
      if (retType) expr.resolvedType = retType;
      return retType;
    }

    // A bare call inside a PROGRAM to one of its own methods (the method
    // shadows a FUNCTION of the same name, as a C++ member does)
    const ownMethod = this.ownMethod(expr.functionName);
    if (ownMethod) {
      const retType = this.methodReturnType(ownMethod);
      if (retType) expr.resolvedType = retType;
      return retType;
    }

    // An FB instance in scope is invoked (no return value)
    if (!expr.instance && this.calledInstance(expr.functionName, scope)) {
      this.refuseInstanceCallValue(expr, scope);
      return undefined;
    }

    this.checkBoundDimension(expr, scope);

    // SEL / MUX of values of one enumeration yield that enumeration.
    const selected = this.selectionEnumResult(expr);
    if (selected !== undefined) {
      if (selected !== "refused") expr.resolvedType = selected;
      return selected === "refused" ? undefined : selected;
    }

    // A library FUNCTION named like a standard function, called with arguments
    // only its own signature takes (OSCAT's ROUND(IN, N)).
    const overload = this.libraryOverload(expr);
    if (overload) {
      expr.resolvedType = overload.returnType;
      return overload.returnType;
    }

    // Check user-defined functions in symbol tables
    const funcSymbol = this.symbolTables.lookupFunction(expr.functionName);
    if (funcSymbol !== undefined) {
      // A standard function listed by the std-function library keeps its constraints.
      if (funcSymbol.libraryName === STD_FUNCTIONS_LIBRARY) {
        this.validateFunctionCallArgs(expr, scope);
      }
      let returnType = funcSymbol.returnType;
      // Overloaded standard functions are published in the builtin stdlib
      // manifest with their generic return *constraint* (e.g. NOT -> ANY_BIT,
      // ADD -> ANY_NUM). When the IEC signature says the result type matches
      // the first argument, refine that generic to the concrete operand type
      // so downstream checks see a real type — e.g. NOT(BOOL) -> BOOL, which
      // the EN-input check (and bit/num operand rules) require.
      if (returnType && isGenericGroupType(returnType) && this.stdRegistry) {
        const desc = this.unboundStdFunctionCalls.has(expr)
          ? undefined
          : this.stdRegistry.lookup(nameUpper);
        if (desc && this.refuseEnumOrderingArguments(expr, desc.params)) {
          return undefined;
        }
        const userArgs = stripEnEno(expr.arguments);
        const firstArgType = userArgs[0]?.value.resolvedType;
        const mappedName =
          desc?.returnTypeFor &&
          firstArgType &&
          "name" in firstArgType &&
          desc.returnTypeFor(
            (firstArgType.name as string).toUpperCase(),
            this.features,
          );
        if (mappedName && ELEMENTARY_TYPES[mappedName]) {
          returnType = ELEMENTARY_TYPES[mappedName];
        } else if (desc?.returnMatchesFirstParam) {
          if (firstArgType) returnType = firstArgType;
        }
      }
      expr.resolvedType = returnType;
      return returnType;
    }

    // A built-in operator of a dialect feature (__ISVALIDREF, XSIZEOF).
    const vendorType = this.vendorOperatorCallType(expr, nameUpper, scope);
    if (vendorType !== undefined) return vendorType;

    // Validate standard function argument types (after resolving args)
    this.validateFunctionCallArgs(expr, scope);

    // Check standard function registry for return type
    if (this.stdRegistry) {
      // Check conversion functions (e.g., INT_TO_REAL → REAL)
      const conv = this.stdRegistry.resolveConversion(nameUpper);
      if (conv) {
        const retType = ELEMENTARY_TYPES[conv.toType.toUpperCase()];
        if (retType) {
          expr.resolvedType = retType;
          return retType;
        }
      }

      // Check standard functions (and typed truncation, TRUNC_INT)
      const desc =
        this.stdRegistry.lookup(nameUpper) ??
        this.stdRegistry.resolveTypedTrunc(nameUpper);
      if (desc && !this.unboundStdFunctionCalls.has(expr)) {
        // Specific return type
        if (desc.specificReturnType) {
          const retType =
            ELEMENTARY_TYPES[desc.specificReturnType.toUpperCase()];
          if (retType) {
            expr.resolvedType = retType;
            return retType;
          }
        }
        // Result type derived from the first argument's type (TRUNC).
        if (desc.returnTypeFor) {
          const first = stripEnEno(expr.arguments)[0]?.value.resolvedType;
          const name =
            first && "name" in first ? (first.name as string) : undefined;
          const mapped =
            name && desc.returnTypeFor(name.toUpperCase(), this.features);
          const retType = mapped ? ELEMENTARY_TYPES[mapped] : undefined;
          if (retType) {
            expr.resolvedType = retType;
            return retType;
          }
        }
        // Return matches first parameter (skipping EN/ENO — they're not part
        // of the declared signature).
        if (desc.returnMatchesFirstParam) {
          const userArgs = stripEnEno(expr.arguments);
          if (userArgs.length > 0) {
            const firstArgType = userArgs[0]!.value.resolvedType;
            if (firstArgType) {
              expr.resolvedType = firstArgType;
              return firstArgType;
            }
          }
        }
      }
    }

    // Could be a function block invocation (treated as statement, no return)
    const fbInstance = scope.lookup(expr.functionName);
    if (fbInstance?.kind === "variable") {
      return undefined;
    }

    // Check if it's a standard function even without the registry
    // (the function might be known via the symbol table from library loading)
    const globalSymbol = this.symbolTables.globalScope.lookup(
      expr.functionName,
    );
    if (globalSymbol?.kind === "functionBlock") {
      return undefined; // FB invocation, no direct return type
    }

    // Unknown function — don't error here, the undeclared-variable pass handles this
    return undefined;
  }

  /**
   * Infer type of a method call expression (e.g., fb.method(args)).
   */
  private inferMethodCallType(
    expr: MethodCallExpression,
    scope: Scope,
  ): IECType | undefined {
    // Resolve the object expression
    const objType = this.resolveExprType(expr.object, scope);

    // Resolve argument expressions
    for (const arg of expr.arguments) {
      this.resolveExprType(arg.value, scope);
    }

    if (
      expr.object.kind === "VariableExpression" &&
      this.isMemberChain(expr.object)
    ) {
      const owner = this.memberChainOwner(expr.object, scope);
      const method = this.checkMemberChainCall(expr, expr.object, owner);
      const chainInputs = this.methodInputsOf(owner?.name, expr.methodName);
      this.adaptCharArguments(chainInputs, expr.arguments);
      this.validateInterfaceArguments(chainInputs, expr.arguments);
      this.validateStructArguments(chainInputs, expr.arguments);
      this.validateEnumArguments(chainInputs, expr.arguments);
      this.validateReferenceToArguments(chainInputs, expr.arguments, scope);
      this.validateInOutArguments(
        chainInputs,
        expr.arguments,
        scope,
        false,
        expr,
      );
      if (this.strict) {
        this.checkStrictArguments(
          this.methodInputsOf(owner?.name, expr.methodName),
          expr.arguments,
          scope,
        );
      }
      const chainRet = method ? this.methodReturnType(method) : undefined;
      if (chainRet) expr.resolvedType = chainRet;
      return chainRet;
    }

    const methodInputs = this.methodInputs(objType, expr, scope);
    this.adaptCharArguments(
      methodInputs ??
        (objType?.typeKind === "elementary"
          ? this.interfaceMethodInputs(
              (objType as ElementaryType).name,
              expr.methodName,
            )
          : undefined),
      expr.arguments,
    );
    this.validateInterfaceArguments(methodInputs, expr.arguments);
    this.validateStructArguments(methodInputs, expr.arguments);
    this.validateEnumArguments(methodInputs, expr.arguments);
    this.validateReferenceToArguments(methodInputs, expr.arguments, scope);
    this.validateInOutArguments(
      methodInputs,
      expr.arguments,
      scope,
      false,
      expr,
    );
    if (this.strict) {
      this.checkStrictArguments(
        this.methodInputs(objType, expr, scope),
        expr.arguments,
        scope,
      );
    }

    if (!objType || !this.ast) return undefined;

    // Get the type name for the object
    let objTypeName: string | undefined;
    if (objType.typeKind === "elementary") {
      objTypeName = (objType as ElementaryType).name;
    } else if (expr.object.kind === "VariableExpression") {
      const sym = scope.lookup(expr.object.name);
      if (sym?.kind === "variable") {
        objTypeName = sym.declaration?.type?.name;
      }
    }

    if (!objTypeName) return undefined;

    // Find the FB (or program) declaration and the method
    const method = this.methodsOfType(objTypeName)?.find(
      (m) => m.name.toUpperCase() === expr.methodName.toUpperCase(),
    );
    const retType = method ? this.methodReturnType(method) : undefined;
    if (retType) expr.resolvedType = retType;
    return retType;
  }

  /** The object of `a.b.M()`, `arr[i].M()` or `THIS.f.M()`: a chain, not a bare name. */
  private isMemberChain(object: VariableExpression): boolean {
    const root = object.name.toUpperCase();
    return (
      (this.hasMemberAccess(object) && root !== "THIS" && root !== "SUPER") ||
      ((root === "THIS" || root === "SUPER") && object.fieldAccess.length > 0)
    );
  }

  /**
   * The declared type a member chain lands on, starting from the variable,
   * THIS (the enclosing FB) or SUPER (its base). A REFERENCE TO is used as its
   * target. Undefined when any step cannot be resolved.
   */
  private memberChainOwner(
    object: VariableExpression,
    scope: Scope,
  ): AccessType | undefined {
    const root = object.name.toUpperCase();
    let base: AccessType | undefined;
    if (root === "THIS" || root === "SUPER") {
      const fbName = this.currentFBName;
      const name =
        root === "THIS"
          ? fbName
          : this.ast?.functionBlocks.find(
              (f) => f.name.toUpperCase() === fbName?.toUpperCase(),
            )?.extends;
      base = name === undefined ? undefined : { name, referenceKind: "none" };
    } else {
      const sym = scope.lookup(object.name);
      base =
        sym?.kind === "variable"
          ? (sym.declaration as VarDeclaration | undefined)?.type
          : undefined;
    }
    if (!base) return undefined;
    const owner = resolveAccessType(base, object, this.accessLookup);
    if (owner?.referenceKind === "reference_to" && !owner.referenceChain) {
      return { name: owner.name, referenceKind: "none" };
    }
    return owner;
  }

  /** Dotted calls already checked, so an expression visited twice reports once. */
  private checkedDottedCalls = new WeakSet<FunctionCallExpression>();

  /**
   * Check `v.M(args)` on a variable: an instance of a function block or
   * interface of this compile must have the method (its own, a base's or an
   * action); a value that is no instance (elementary, STRING, STRUCT, enum,
   * array, POINTER TO, REF_TO) has no methods. A REFERENCE TO is checked as
   * its target. Library and unresolved types are not checked.
   */
  private checkDottedMethodCall(
    expr: FunctionCallExpression,
    scope: Scope,
  ): void {
    const parts = expr.functionName.split(".");
    if (parts.length !== 2 || !this.ast) return;
    if (this.checkedDottedCalls.has(expr)) return;
    this.checkedDottedCalls.add(expr);
    const [prefix, methodName] = parts as [string, string];
    const prefixUpper = prefix.toUpperCase();
    if (prefixUpper === "THIS" || prefixUpper === "SUPER") return;
    const sym = scope.lookup(prefix);
    if (sym?.kind !== "variable") return;
    const type = (sym.declaration as VarDeclaration | undefined)?.type;
    if (!type) return;
    const span = expr.sourceSpan;
    const notInstance = (): void =>
      this.addError(
        `Cannot call method '${methodName}' on '${prefix}': it is not a function block instance`,
        span.startLine,
        span.startCol,
        span.file,
      );
    const kind = this.callTargetKind(type);
    if (kind === undefined) {
      this.checkLibraryMethodCall(type, methodName, span);
      return;
    }
    const upper = this.aliasBase(type.name);
    if (
      kind !== "value" &&
      this.lookupChainMethod(upper, methodName) !== "missing"
    ) {
      return;
    }
    const direct =
      type.arrayDimensions === undefined &&
      (type.referenceKind === "none" || type.referenceKind === "reference_to");
    const member = direct ? this.lookupMember(upper, methodName) : undefined;
    if (member !== undefined) {
      // `inst.fb(...)` reaches the member: the same access rule as `inst.fb`.
      this.refuseInternalMember(upper, methodName, expr);
      if (this.callTargetKind(member.type) === "value") {
        this.addError(
          `Cannot call '${prefix}.${methodName}': it is a member that is not a function block instance, not a method`,
          span.startLine,
          span.startCol,
          span.file,
        );
      } else {
        this.checkFbCallArgumentNames(member.type, expr.arguments);
      }
      return;
    }
    if (kind === "value") {
      notInstance();
      return;
    }
    const isFb = kind === "fb";
    const owner =
      this.ast.functionBlocks.find((f) => f.name.toUpperCase() === upper)
        ?.name ??
      this.ast.interfaces.find((i) => i.name.toUpperCase() === upper)?.name ??
      upper;
    this.addError(
      `${isFb ? "Function block" : "Interface"} '${owner}' has no method '${methodName}'`,
      span.startLine,
      span.startCol,
      span.file,
    );
  }

  /**
   * `v.M()` on a library block whose archive lists all its members: M must be
   * a method or action of the block or of a base, or a member (an FB instance).
   */
  private checkLibraryMethodCall(
    type: VarDeclaration["type"],
    methodName: string,
    span: FunctionCallExpression["sourceSpan"],
  ): void {
    if (
      type.arrayDimensions !== undefined ||
      type.referenceChain !== undefined ||
      (type.referenceKind !== "none" && type.referenceKind !== "reference_to")
    ) {
      return;
    }
    const upper = this.aliasBase(type.name);
    if (
      this.ast?.functionBlocks.some((f) => f.name.toUpperCase() === upper) ===
      true
    ) {
      return;
    }
    if (this.resolveFieldTypeAnywhere(upper, methodName) !== undefined) return;
    const methodUpper = methodName.toUpperCase();
    const seen = new Set<string>();
    let current: string | undefined = upper;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const lib = this.symbolTables.lookupFunctionBlock(current);
      if (lib?.libraryMethodNames === undefined) return;
      if (lib.libraryMethodNames.some((m) => m.toUpperCase() === methodUpper)) {
        return;
      }
      current = lib.declaration.extends?.toUpperCase();
    }
    const owner = this.symbolTables.lookupFunctionBlock(upper)?.name ?? upper;
    this.addError(
      `Function block '${owner}' has no method '${methodName}'`,
      span.startLine,
      span.startCol,
      span.file,
    );
  }

  /**
   * What a declared type is as a call target: "value" when it surely has no
   * methods (elementary, STRING, STRUCT, enum, array, POINTER TO, REF_TO),
   * "fb" or "interface" when this compile declares it; undefined otherwise.
   * A REFERENCE TO is its target.
   */
  private callTargetKind(
    type: VarDeclaration["type"],
  ): "value" | "fb" | "interface" | undefined {
    if (!this.ast) return undefined;
    if (
      type.referenceKind === "pointer_to" ||
      type.referenceKind === "ref_to"
    ) {
      return "value";
    }
    if (type.referenceChain !== undefined) return undefined;
    if (type.arrayDimensions !== undefined) return "value";
    const upper = this.aliasBase(type.name);
    const def = this.ast.types.find(
      (td) => td.name.toUpperCase() === upper,
    )?.definition;
    if (
      ELEMENTARY_TYPES[upper] !== undefined ||
      upper === "STRING" ||
      upper === "WSTRING" ||
      (def !== undefined && def.kind !== "TypeReference")
    ) {
      return "value";
    }
    if (this.ast.functionBlocks.some((f) => f.name.toUpperCase() === upper)) {
      return "fb";
    }
    if (this.ast.interfaces.some((i) => i.name.toUpperCase() === upper)) {
      return "interface";
    }
    return undefined;
  }

  /** The named arguments of a call of `method` that name none of its parameters. */
  private unknownMethodArguments(
    method: MethodDeclaration,
    args: readonly Argument[],
  ): Argument[] {
    const params = new Set(
      method.varBlocks
        .filter(
          (b) =>
            b.blockType === "VAR_INPUT" ||
            b.blockType === "VAR_IN_OUT" ||
            b.blockType === "VAR_OUTPUT",
        )
        .flatMap((b) => b.declarations.flatMap((d) => d.names))
        .map((n) => n.toUpperCase()),
    );
    return stripEnEno([...args]).filter(
      (a) => a.name !== undefined && !params.has(a.name.toUpperCase()),
    );
  }

  /** Method calls whose argument names were already checked. */
  private checkedMethodCallNames = new WeakSet<FunctionCallExpression>();

  /**
   * `inst.M(name := v)`, `THIS.M(...)`, `SUPER.M(...)`, `PRG.M(...)` and a bare
   * `M(...)` of the enclosing block or program: each named argument must name
   * a parameter of the method, which the generated C++ binds by name and
   * would otherwise drop. Methods this compile does not declare are skipped.
   */
  private checkMethodCallArgumentNames(
    expr: FunctionCallExpression,
    scope: Scope,
  ): void {
    if (expr.instance || this.checkedMethodCallNames.has(expr)) return;
    this.checkedMethodCallNames.add(expr);
    if (!expr.arguments.some((a) => a.name !== undefined)) return;
    const parts = expr.functionName.split(".");
    const enclosing = this.currentFBName ?? this.currentProgram?.name;
    let owner: string | undefined;
    let methodName: string;
    if (parts.length === 1) {
      methodName = parts[0]!;
      // A FUNCTION or a variable (an FB instance) of that name is called
      // instead, unless the enclosing block has a method of that name.
      if (
        this.ownMethod(methodName) === undefined &&
        this.symbolTables.lookupFunction(methodName) !== undefined
      ) {
        return;
      }
      if (scope.lookup(methodName)?.kind === "variable") return;
      if (this.calledInstance(methodName, scope)) return;
      owner = enclosing;
    } else if (parts.length === 2) {
      methodName = parts[1]!;
      const prefix = parts[0]!.toUpperCase();
      if (prefix === "THIS") {
        owner = enclosing;
      } else if (prefix === "SUPER") {
        owner =
          this.currentFBName === undefined
            ? undefined
            : this.ast?.functionBlocks.find(
                (f) =>
                  f.name.toUpperCase() === this.currentFBName!.toUpperCase(),
              )?.extends;
      } else {
        const sym = scope.lookup(parts[0]!);
        if (sym?.kind === "program") {
          owner = sym.name;
        } else if (sym?.kind === "variable") {
          const type = (sym.declaration as VarDeclaration | undefined)?.type;
          if (
            type !== undefined &&
            type.arrayDimensions === undefined &&
            (type.referenceKind === "none" ||
              type.referenceKind === "reference_to")
          ) {
            owner = this.aliasBase(type.name);
          }
        }
      }
    } else {
      return;
    }
    if (owner === undefined) return;
    const ownerUpper = owner.toUpperCase();
    const isProgram =
      this.ast?.programs.some((p) => p.name.toUpperCase() === ownerUpper) ===
      true;
    const found = isProgram
      ? this.methodsOfType(owner)?.find(
          (m) => m.name.toUpperCase() === methodName.toUpperCase(),
        )
      : this.lookupChainMethod(owner, methodName);
    if (found === undefined || typeof found === "string") return;
    const ownerName =
      [
        ...(this.ast?.functionBlocks ?? []),
        ...(this.ast?.programs ?? []),
        ...(this.ast?.interfaces ?? []),
      ].find((d) => d.name.toUpperCase() === ownerUpper)?.name ?? owner;
    for (const arg of this.unknownMethodArguments(found, expr.arguments)) {
      this.addError(
        `Method '${found.name}' of '${ownerName}' has no parameter named '${arg.name ?? ""}'`,
        arg.sourceSpan.startLine,
        arg.sourceSpan.startCol,
        arg.sourceSpan.file,
      );
    }
  }

  /** Calls of a standard function's name resolved to a library FUNCTION of it. */
  private libraryOverloads = new WeakMap<
    FunctionCallExpression,
    FunctionSymbol | null
  >();

  /** The library FUNCTION this call resolves to instead of the standard one. */
  private libraryOverload(
    expr: FunctionCallExpression,
  ): FunctionSymbol | undefined {
    let found = this.libraryOverloads.get(expr);
    if (found === undefined) {
      found =
        (this.findUserFunction(expr.functionName)
          ? undefined
          : libraryOverloadFor(expr, this.symbolTables, this.stdRegistry)) ??
        null;
      this.libraryOverloads.set(expr, found);
      if (found?.libraryName !== undefined) {
        expr.libraryFunction = found.libraryName;
      }
    }
    return found ?? undefined;
  }

  /** Standard function calls whose arguments were already bound. */
  private boundStdFunctionCalls = new WeakSet<FunctionCallExpression>();
  /** Standard function calls whose named arguments could not be bound. */
  private unboundStdFunctionCalls = new WeakSet<FunctionCallExpression>();
  /** Calls whose enumeration ordering arguments were checked, and whether one was refused. */
  private enumOrderingChecked = new WeakMap<FunctionCallExpression, boolean>();

  /**
   * A standard function call with named arguments: put its arguments in the
   * IEC parameter order every later pass and the C++ call rely on, and refuse
   * names the function does not declare. A user FUNCTION of the name, an FB
   * instance or an own program method is not a standard function call.
   */
  private bindStdFunctionCallArguments(
    expr: FunctionCallExpression,
    scope: Scope,
  ): void {
    if (!this.stdRegistry || expr.instance) return;
    if (this.boundStdFunctionCalls.has(expr)) return;
    this.boundStdFunctionCalls.add(expr);
    const name = expr.functionName;
    if (name.includes(".") || this.findUserFunction(name)) return;
    if (scope.lookup(name)?.kind === "variable") return;
    if (this.calledInstance(name, scope)) return;
    if (this.ownMethod(name)) return;
    if (this.libraryOverload(expr)) return;
    const upper = name.toUpperCase();
    const desc = this.stdRegistry.lookup(upper);
    let params = desc?.params;
    let variadic = desc?.isVariadic === true;
    if (!params && this.stdRegistry.resolveConversion(upper)) {
      params = [{ name: "IN", constraint: "ANY", isByRef: false }];
      variadic = false;
    }
    if (!params && this.symbolTables.lookupFunction(upper) === undefined) {
      params = this.stdRegistry.resolveTypedTrunc(upper)?.params;
    }
    if (!params) return;
    const binding = bindStdFunctionArguments(
      desc?.name ?? upper,
      params,
      variadic,
      expr.arguments,
    );
    for (const issue of binding.issues) {
      const span = issue.argument?.sourceSpan ?? expr.sourceSpan;
      if (issue.severity === "error") {
        this.addError(issue.message, span.startLine, span.startCol, span.file);
      } else {
        this.addWarning(
          issue.message,
          span.startLine,
          span.startCol,
          span.file,
        );
      }
    }
    if (binding.ordered) expr.arguments = binding.ordered;
    if (binding.failed) this.unboundStdFunctionCalls.add(expr);
  }

  /** Function calls whose argument names were already checked. */
  private checkedFunctionCallNames = new WeakSet<FunctionCallExpression>();

  /**
   * `F(name := v)` of a user or library FUNCTION: each named argument must
   * name a VAR_INPUT, VAR_IN_OUT or VAR_OUTPUT of F, which the generated C++
   * binds by name and would otherwise drop. Standard functions, FB instances
   * and the enclosing program's methods are bound elsewhere and skipped.
   */
  private checkFunctionCallArgumentNames(
    expr: FunctionCallExpression,
    scope: Scope,
  ): void {
    if (expr.instance || this.checkedFunctionCallNames.has(expr)) return;
    this.checkedFunctionCallNames.add(expr);
    if (!expr.arguments.some((a) => a.name !== undefined)) return;
    const name = expr.functionName;
    if (name.includes(".")) return;
    if (scope.lookup(name)?.kind === "variable") return;
    if (this.calledInstance(name, scope)) return;
    if (this.ownMethod(name)) return;
    let declaredName: string;
    let params: string[];
    const userFn = this.findUserFunction(name);
    if (userFn) {
      declaredName = userFn.name;
      params = userFn.varBlocks
        .filter(
          (b) =>
            b.blockType === "VAR_INPUT" ||
            b.blockType === "VAR_IN_OUT" ||
            b.blockType === "VAR_OUTPUT",
        )
        .flatMap((b) => b.declarations.flatMap((d) => d.names));
    } else {
      const upper = name.toUpperCase();
      const overload = this.libraryOverload(expr);
      if (
        overload === undefined &&
        (this.stdRegistry?.lookup(upper) !== undefined ||
          this.stdRegistry?.resolveConversion(upper) !== undefined)
      ) {
        return;
      }
      const libFn = overload ?? this.symbolTables.lookupFunction(name);
      if (libFn === undefined) return;
      declaredName = libFn.name;
      params = libFn.parameters.map((p) => p.name);
    }
    const known = new Set(params.map((p) => p.toUpperCase()));
    for (const arg of stripEnEno([...expr.arguments])) {
      if (arg.name === undefined || known.has(arg.name.toUpperCase())) continue;
      this.addError(
        `Function '${declaredName}' has no parameter named '${arg.name}'`,
        arg.sourceSpan.startLine,
        arg.sourceSpan.startCol,
        arg.sourceSpan.file,
      );
    }
  }

  /** Member-chain calls already checked, so an expression visited twice reports once. */
  private checkedChainCalls = new WeakSet<MethodCallExpression>();

  /**
   * Check `a.b.M(args)` against the type the chain lands on: it must be a
   * function block (or interface) instance that has the method, and named or
   * positional arguments must fit its parameters. Nothing is reported for a
   * type this compile does not declare. Returns the method when found.
   */
  private checkMemberChainCall(
    expr: MethodCallExpression,
    object: VariableExpression,
    owner: AccessType | undefined,
  ): MethodDeclaration | undefined {
    if (!owner || !this.ast) return undefined;
    const report = !this.checkedChainCalls.has(expr);
    this.checkedChainCalls.add(expr);
    const error = (message: string, span: SourceSpan): void => {
      if (report) {
        this.addError(message, span.startLine, span.startCol, span.file);
      }
    };
    const upper = owner.name.toUpperCase();
    const member =
      owner.referenceKind === "none"
        ? this.lookupMember(owner.name, expr.methodName)
        : undefined;
    // `a.b.fb(args)`: invoking a function block instance held in a member
    if (
      member !== undefined &&
      member.type.referenceKind === "none" &&
      member.type.arrayDimensions === undefined &&
      (this.callTargetKind(member.type) === "fb" ||
        this.symbolTables.lookupFunctionBlock(member.type.name) !== undefined)
    ) {
      expr.fbInstanceCall = true;
      if (report) this.checkFbCallArgumentNames(member.type, expr.arguments);
      return undefined;
    }
    if (member !== undefined) {
      error(
        `'${this.chainText(object)}.${expr.methodName}' is a member that is not a function block instance, not a method`,
        expr.methodNameSpan ?? expr.sourceSpan,
      );
      return undefined;
    }
    const isFb = this.ast.functionBlocks.some(
      (f) => f.name.toUpperCase() === upper,
    );
    const isInterface = this.ast.interfaces.some(
      (i) => i.name.toUpperCase() === upper,
    );
    const isPlainValue =
      owner.referenceKind !== "none" ||
      owner.arrayDimensions !== undefined ||
      ELEMENTARY_TYPES[upper] !== undefined ||
      this.ast.types.some((t) => t.name.toUpperCase() === upper);
    if ((!isFb && !isInterface) || isPlainValue) {
      if (isPlainValue) {
        error(
          `Cannot call method '${expr.methodName}' on '${this.chainText(object)}': it is not a function block instance`,
          object.sourceSpan,
        );
      }
      return undefined;
    }

    const found = this.lookupChainMethod(upper, expr.methodName);
    if (found === "missing") {
      error(
        `${isFb ? "Function block" : "Interface"} '${owner.name}' has no method '${expr.methodName}'`,
        expr.methodNameSpan ?? expr.sourceSpan,
      );
      return undefined;
    }
    if (found === undefined || found === "action") return undefined;
    this.checkChainMethodAccess(found, expr.sourceSpan, error);

    const params = found.varBlocks
      .filter(
        (b) =>
          b.blockType === "VAR_INPUT" ||
          b.blockType === "VAR_IN_OUT" ||
          b.blockType === "VAR_OUTPUT",
      )
      .flatMap((b) => b.declarations)
      .flatMap((d) => d.names.map((n) => n.toUpperCase()));
    const args = stripEnEno(expr.arguments);
    for (const arg of this.unknownMethodArguments(found, args)) {
      error(
        `Method '${found.name}' of '${owner.name}' has no parameter named '${arg.name ?? ""}'`,
        arg.sourceSpan,
      );
    }
    const positional = args.filter((a) => a.name === undefined);
    const extra = positional[params.length];
    if (extra) {
      error(
        `Method '${found.name}' of '${owner.name}' takes ${params.length} argument${params.length === 1 ? "" : "s"}, got ${positional.length}`,
        extra.sourceSpan,
      );
    }
    return found;
  }

  /**
   * A PRIVATE or PROTECTED method reached through a member chain is called on
   * another instance, which only the declaring function block may do (a
   * derived block may not; the C++ would not build). Same messages as `inst.M()`.
   */
  private checkChainMethodAccess(
    method: MethodDeclaration,
    span: SourceSpan,
    error: (message: string, span: SourceSpan) => void,
  ): void {
    if (method.visibility === "PUBLIC" || !this.ast) return;
    const declaring = this.ast.functionBlocks.find((f) =>
      f.methods.includes(method),
    );
    if (!declaring) return;
    if (this.currentFBName?.toUpperCase() === declaring.name.toUpperCase()) {
      return;
    }
    error(
      method.visibility === "PRIVATE"
        ? `Cannot call PRIVATE method '${method.name}' of '${declaring.name}' from outside '${declaring.name}'.`
        : `Cannot call PROTECTED method '${method.name}' of '${declaring.name}' from '${this.currentFBName ?? "PROGRAM"}'.`,
      span,
    );
  }

  /**
   * A method or action of a function block or interface this compile
   * declares, base types included: "missing" when every type on the way is
   * declared here and none has it, undefined when a base is not declared here.
   */
  private lookupChainMethod(
    typeName: string,
    methodName: string,
    depth = 0,
  ): MethodDeclaration | "action" | "missing" | undefined {
    if (!this.ast || depth >= 32) return undefined;
    const upper = typeName.toUpperCase();
    const methodUpper = methodName.toUpperCase();
    const fb = this.ast.functionBlocks.find(
      (f) => f.name.toUpperCase() === upper,
    );
    if (fb) {
      const own = fb.methods.find((m) => m.name.toUpperCase() === methodUpper);
      if (own) return own;
      if (fb.actions.some((a) => a.name.toUpperCase() === methodUpper)) {
        return "action";
      }
      return fb.extends === undefined
        ? "missing"
        : this.lookupChainMethod(fb.extends, methodName, depth + 1);
    }
    const itf = this.ast.interfaces.find((i) => i.name.toUpperCase() === upper);
    if (!itf) return undefined;
    const own = itf.methods.find((m) => m.name.toUpperCase() === methodUpper);
    if (own) return own;
    let unknownBase = false;
    for (const base of itf.extends ?? []) {
      const found = this.lookupChainMethod(base, methodName, depth + 1);
      if (found === undefined) unknownBase = true;
      else if (found !== "missing") return found;
    }
    return unknownBase ? undefined : "missing";
  }

  /** `a.b[...].c^` as written, for messages. */
  private chainText(object: VariableExpression): string {
    const steps = object.accessChain ?? [
      ...(object.subscripts.length > 0
        ? [{ kind: "subscript" as const, indices: object.subscripts }]
        : []),
      ...object.fieldAccess.map((name) => ({ kind: "field" as const, name })),
    ];
    return (
      object.name +
      steps
        .map((step) =>
          step.kind === "field"
            ? `.${step.name}`
            : step.kind === "subscript"
              ? "[...]"
              : "^",
        )
        .join("")
    );
  }

  /** The methods of the FB or PROGRAM named `typeName` (not inherited ones). */
  private methodsOfType(typeName: string): MethodDeclaration[] | undefined {
    const upper = typeName.toUpperCase();
    return (
      this.ast?.functionBlocks.find((f) => f.name.toUpperCase() === upper)
        ?.methods ??
      this.ast?.programs.find((p) => p.name.toUpperCase() === upper)?.methods
    );
  }

  /** The method `PRG_A.M` names when `PRG_A` is a program (feature program_methods). */
  private reachedProgramMethod(
    name: string,
    scope: Scope,
  ): MethodDeclaration | undefined {
    const parts = name.split(".");
    if (parts.length !== 2 || !this.features.has("program_methods")) {
      return undefined;
    }
    const sym = scope.lookup(parts[0]!);
    if (sym?.kind !== "program") return undefined;
    const upper = parts[1]!.toUpperCase();
    return this.methodsOfType(sym.name)?.find(
      (m) => m.name.toUpperCase() === upper,
    );
  }

  /**
   * `__ISVALIDREF` and `XSIZEOF` in a top-level or CONFIGURATION global's
   * initial value; an initial value that is such a call is checked as an
   * assignment to the global.
   */
  private markGlobalVendorOperators(ast: CompilationUnit): void {
    const scopes: Array<{ blocks: VarBlock[]; scope: Scope }> = [
      { blocks: ast.globalVarBlocks, scope: this.symbolTables.globalScope },
      ...ast.configurations.map((c) => ({
        blocks: c.varBlocks,
        scope: this.configurationGlobalScope(c.varBlocks),
      })),
    ];
    for (const { blocks, scope } of scopes) {
      for (const block of blocks) {
        for (const decl of block.declarations) {
          const value = decl.initialValue;
          if (!value) continue;
          walkAST(value, (node) => {
            if (node.kind !== "FunctionCallExpression") return;
            const call = node as FunctionCallExpression;
            this.vendorOperatorCallType(
              call,
              call.functionName.toUpperCase(),
              scope,
            );
          });
          const targetType = ELEMENTARY_TYPES[decl.type.name.toUpperCase()];
          if (
            value.kind === "FunctionCallExpression" &&
            value.vendorOperator !== undefined &&
            value.resolvedType !== undefined &&
            targetType !== undefined &&
            (decl.type.referenceKind ?? "none") === "none"
          ) {
            this.validateAssignment(
              targetType,
              value.resolvedType,
              {
                kind: "VariableExpression",
                sourceSpan: decl.sourceSpan,
                name: decl.names[0] ?? "<unnamed>",
                fieldAccess: [],
                subscripts: [],
                isDereference: false,
              },
              value,
            );
          }
        }
      }
    }
  }

  /** A scope holding a CONFIGURATION's globals, over the global scope. */
  private configurationGlobalScope(blocks: readonly VarBlock[]): Scope {
    const scope = new SymbolScope(
      "configuration",
      this.symbolTables.globalScope,
    );
    for (const block of blocks) {
      for (const decl of block.declarations) {
        for (const name of decl.names) {
          try {
            scope.define({
              name,
              kind: "variable",
              declaration: decl,
              isInput: false,
              isOutput: false,
              isInOut: false,
              isExternal: false,
              isGlobal: true,
              isRetain: block.isRetain,
            });
          } catch {
            // A duplicate is reported by the analyzer.
          }
        }
      }
    }
    return scope;
  }

  /**
   * The result type of a call of a built-in operator whose feature is on and
   * whose name nothing in scope declares; marks the call for codegen.
   */
  private vendorOperatorCallType(
    expr: FunctionCallExpression,
    nameUpper: string,
    scope: Scope,
  ): IECType | undefined {
    const op = vendorOperatorNamed(nameUpper);
    if (op === undefined || !this.features.has(vendorOperatorFeature(op))) {
      return undefined;
    }
    if (expr.instance || scope.lookup(nameUpper) !== undefined) {
      return undefined;
    }
    expr.vendorOperator = op;
    const error = vendorOperatorArgumentError(expr, op, (arg) => {
      const value = arg.value;
      if (value.kind !== "VariableExpression")
        return "an expression is not one";
      const name = [value.name, ...value.fieldAccess].join(".").toUpperCase();
      // `THIS.r` / `THIS^.r`: a member of the enclosing FB.
      if (this.isSelfMember(value)) {
        const type = resolveAccessType(
          { name: this.currentFBName!, referenceKind: "none" },
          value,
          this.accessLookup,
        );
        if (
          type?.referenceKind === "reference_to" &&
          (type.referenceChain?.length ?? 1) === 1
        ) {
          return true;
        }
        return type === undefined
          ? `'${name}' is not a variable here`
          : `'${name}' is declared ${describeReferenceShape(referenceShapeOf(type as TypeReference) ?? { chain: [], base: type.name })}`;
      }
      const shape = this.declaredReferenceShape(value, scope);
      if (shape?.chain.length === 1 && shape.chain[0] === "reference_to") {
        return true;
      }
      return shape === undefined
        ? `'${name}' is not a variable here`
        : `'${name}' is declared ${describeReferenceShape(shape)}`;
    });
    if (error !== undefined) {
      this.addError(
        error,
        expr.sourceSpan.startLine,
        expr.sourceSpan.startCol,
        expr.sourceSpan.file,
      );
    }
    const type = ELEMENTARY_TYPES[vendorOperatorResultType(op)]!;
    expr.resolvedType = type;
    return type;
  }

  /**
   * A bare `Name(...)` inside a PROGRAM or FUNCTION_BLOCK that names one of
   * its methods, inherited ones included. The method is called, as the C++
   * member shadows a FUNCTION or standard function of the same name.
   */
  private ownMethod(name: string): MethodDeclaration | undefined {
    if (name.includes(".")) return undefined;
    const upper = name.toUpperCase();
    if (this.currentFBName !== undefined) {
      const found = this.lookupChainMethod(this.currentFBName, name);
      return typeof found === "object" ? found : undefined;
    }
    return this.currentProgram?.methods.find(
      (m) => m.name.toUpperCase() === upper,
    );
  }

  /**
   * A bare `name(...)` that invokes a PROGRAM, or a variable in scope of a
   * FUNCTION_BLOCK or PROGRAM type: it shadows a FUNCTION or standard
   * function of its name, as the C++ member does.
   */
  private calledInstance(name: string, scope: Scope): boolean {
    if (name.includes(".")) return false;
    const sym = scope.lookup(name);
    if (sym?.kind === "program") return true;
    const type =
      sym?.kind === "variable"
        ? (sym.declaration as VarDeclaration | undefined)?.type
        : this.inheritedMemberType(name);
    if (type === undefined || type.arrayDimensions !== undefined) return false;
    const upper = this.aliasBase(type.name).toUpperCase();
    return (
      this.ast?.functionBlocks.some((f) => f.name.toUpperCase() === upper) ===
        true ||
      this.ast?.programs.some((p) => p.name.toUpperCase() === upper) === true ||
      this.symbolTables.lookupFunctionBlock(upper) !== undefined
    );
  }

  /** The declared type of a member the enclosing FB inherits from a base. */
  private inheritedMemberType(name: string): TypeReference | undefined {
    const upper = name.toUpperCase();
    const seen = new Set<string>();
    let current = this.ast?.functionBlocks.find(
      (f) => f.name.toUpperCase() === this.currentFBName?.toUpperCase(),
    )?.extends;
    while (current !== undefined && !seen.has(current.toUpperCase())) {
      const base = current.toUpperCase();
      seen.add(base);
      const fb = this.ast?.functionBlocks.find(
        (f) => f.name.toUpperCase() === base,
      );
      if (!fb) return undefined;
      for (const block of fb.varBlocks) {
        for (const d of block.declarations) {
          if (d.names.some((n) => n.toUpperCase() === upper)) return d.type;
        }
      }
      current = fb.extends;
    }
    return undefined;
  }

  /** The declared return type of a method, or undefined when it has none. */
  private methodReturnType(method: MethodDeclaration): IECType | undefined {
    if (!method.returnType) return undefined;
    return (
      ELEMENTARY_TYPES[method.returnType.name.toUpperCase()] ??
      ({
        typeKind: "elementary",
        name: method.returnType.name,
        sizeBits: 0,
      } as ElementaryType)
    );
  }

  // ===========================================================================
  // Statement Type Validation (Sub-Phase C)
  // ===========================================================================

  /**
   * Walk variable declarations and validate every initialiser against the
   * declared type. Without this pass, nonsense like `WSTRING := 'foo'`
   * (STRING literal into a WSTRING variable) reaches codegen unchecked,
   * surfacing as a confusing C++ "no matching function for call to
   * IECWStringVar(const char[N])" instead of a proper IEC type error
   * pointing at the declaration.
   *
   * The check delegates to the same `validateAssignment` used for
   * assignment statements — no separate compatibility rules — so anything
   * the standard considers an implicit assignment also passes here.
   */
  /**
   * Globals are created in dependency order (see global-order.ts), so only
   * initial values that depend on each other cannot be created.
   */
  private checkGlobalInitialCycles(ast: CompilationUnit): void {
    for (const ordered of [
      orderGlobals(ast),
      ...ast.configurations.map(orderConfigurationGlobals),
    ]) {
      this.reportGlobalInitialCycles(ordered);
    }
  }

  /** Report each cycle of `ordered`, at its first global. */
  private reportGlobalInitialCycles({ cycles, order }: GlobalOrder): void {
    for (const cycle of cycles) {
      const quoted = cycle.map((n) => `'${n}'`);
      const list =
        quoted.length > 1
          ? `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]!}`
          : quoted[0]!;
      const span = order.find((i) => i.name.toUpperCase() === cycle[0])?.decl
        .sourceSpan;
      this.addError(
        `The initial values of the globals ${list} depend on each other (${[...cycle, cycle[0]!].join(" -> ")})`,
        span?.startLine ?? 0,
        span?.startCol ?? 0,
        span?.file,
      );
    }
  }

  /**
   * A POINTER TO, REF_TO or REFERENCE TO field of a STRUCT takes no address
   * or reference as its default: the type is created before any variable, and a copy of the
   * STRUCT would keep the address of the instance it was copied from.
   */
  private checkStructReferenceDefaults(ast: CompilationUnit): void {
    for (const type of ast.types) {
      if (type.definition.kind !== "StructDefinition") continue;
      for (const field of type.definition.fields) {
        const value = field.initialValue;
        const kind = field.type.referenceChain?.[0] ?? field.type.referenceKind;
        const spelled = {
          pointer_to: "POINTER TO",
          ref_to: "REF_TO",
          reference_to: "REFERENCE TO",
        }[kind as "pointer_to" | "ref_to" | "reference_to"] as
          | string
          | undefined;
        if (
          value === undefined ||
          spelled === undefined ||
          (kind !== "reference_to" && isNullInitializer(value))
        ) {
          continue;
        }
        this.addError(
          `${spelled} initializers are not supported in a STRUCT; assign '${type.name.toUpperCase()}.${(field.names[0] ?? "").toUpperCase()}' in the body instead`,
          value.sourceSpan.startLine,
          value.sourceSpan.startCol,
          value.sourceSpan.file,
        );
      }
    }
  }

  /**
   * Where variables are created one after another (the locals of a FUNCTION
   * or METHOD), `p : POINTER TO T := ADR(x);` cannot take the address of a
   * variable of the same blocks declared after `p`. Parameters exist before
   * any local. Members of a PROGRAM or FB are not checked: a member's address
   * is known before the member is initialised. Globals are ordered instead.
   */
  private checkAddressInitialOrder(blocks: readonly VarBlock[]): void {
    const declared = new Set<string>();
    const created = new Set<string>();
    for (const block of blocks) {
      const parameter =
        block.blockType === "VAR_INPUT" ||
        block.blockType === "VAR_OUTPUT" ||
        block.blockType === "VAR_IN_OUT";
      for (const decl of block.declarations) {
        for (const name of decl.names) {
          declared.add(name.toUpperCase());
          if (parameter) created.add(name.toUpperCase());
        }
      }
    }
    for (const block of blocks) {
      for (const decl of block.declarations) {
        const value = decl.initialValue;
        const operand =
          value !== undefined &&
          decl.type.referenceKind === "pointer_to" &&
          isAddressOf(value)
            ? value.arguments[0]?.value
            : undefined;
        const target =
          operand?.kind === "VariableExpression"
            ? operand.name.toUpperCase()
            : undefined;
        if (
          target !== undefined &&
          operand !== undefined &&
          declared.has(target) &&
          !created.has(target)
        ) {
          const name = (decl.names[0] ?? "").toUpperCase();
          this.addError(
            `The initial value of '${name}' takes the address of '${target}', which is declared after it; declare '${target}' first or assign '${name}' in the body`,
            operand.sourceSpan.startLine,
            operand.sourceSpan.startCol,
            operand.sourceSpan.file,
          );
        }
        for (const name of decl.names) created.add(name.toUpperCase());
      }
    }
  }

  private checkVarBlocks(
    blocks: VarBlock[],
    scope: Scope,
    /** Where init arguments resolve, when not `scope` (an FB's members). */
    argumentScope: Scope = scope,
  ): void {
    for (const block of blocks) {
      for (const decl of block.declarations) {
        if (decl.fbInitArguments) {
          this.checkFbInitArguments(decl, argumentScope);
        }
        if (!decl.initialValue) continue;
        const outerKind = decl.type.referenceKind;
        if (
          (outerKind === "ref_to" || outerKind === "pointer_to") &&
          !isNullInitializer(decl.initialValue) &&
          !(outerKind === "pointer_to" && isAddressOf(decl.initialValue))
        ) {
          const kindText = outerKind === "ref_to" ? "REF_TO" : "POINTER TO";
          this.addError(
            `${kindText} initializers are not supported; assign '${decl.names[0] ?? ""}' in the body instead`,
            decl.initialValue.sourceSpan.startLine,
            decl.initialValue.sourceSpan.startCol,
            decl.initialValue.sourceSpan.file,
          );
          continue;
        }
        // An address does not fit an integer narrower than the address width.
        if (
          (outerKind ?? "none") === "none" &&
          isAddressOf(decl.initialValue) &&
          this.refuseNarrowAddress(decl.type.name, decl.initialValue)
        ) {
          continue;
        }
        // `p : POINTER TO T := ADR(x);` takes an address of any target type.
        if (outerKind === "pointer_to" && isAddressOf(decl.initialValue)) {
          this.resolveExprType(decl.initialValue, scope);
          continue;
        }
        if (
          this.isInterfaceDeclType(decl.type) &&
          isUntypedZero(decl.initialValue)
        ) {
          this.checkInterfaceZero(decl.type.name, decl.initialValue);
          continue;
        }
        if (
          this.isInterfaceDeclType(decl.type) &&
          !(
            decl.initialValue.kind === "LiteralExpression" &&
            decl.initialValue.literalType === "NULL"
          )
        ) {
          this.addError(
            `Interface initializers other than NULL are not supported; assign '${decl.names[0] ?? ""}' in the body instead`,
            decl.initialValue.sourceSpan.startLine,
            decl.initialValue.sourceSpan.startCol,
            decl.initialValue.sourceSpan.file,
          );
          continue;
        }
        const targetType = ELEMENTARY_TYPES[decl.type.name.toUpperCase()];
        if (!targetType) continue; // Non-elementary types — handled elsewhere
        // A CHAR initial value refused already (checkCharInitialValue).
        if (this.reportedCharValues.has(decl.initialValue)) continue;
        const valueType = this.resolveExprType(decl.initialValue, scope);
        if (!valueType) continue;
        this.validateAssignment(
          targetType,
          valueType,
          // Synthetic VariableExpression for the diagnostic anchor: gives
          // validateAssignment a target.name to mention in the error.
          {
            kind: "VariableExpression",
            sourceSpan: decl.sourceSpan,
            name: decl.names[0] ?? "<unnamed>",
            fieldAccess: [],
            subscripts: [],
            isDereference: false,
          },
          decl.initialValue,
        );
      }
    }
  }

  /**
   * `ADR(x)` stored in an integer narrower than the 64-bit address width (an
   * initial value, a FUNCTION or METHOD argument) would lose the address's
   * high bits. True when it was refused.
   */
  private refuseNarrowAddress(
    typeName: string,
    value: FunctionCallExpression,
  ): boolean {
    const type = ELEMENTARY_TYPES[typeName.toUpperCase()];
    if (
      type === undefined ||
      !("sizeBits" in type) ||
      typeof type.sizeBits !== "number" ||
      type.sizeBits >= 64 ||
      !isIntegerOrBitStringName(typeName)
    ) {
      return false;
    }
    this.addError(
      `ADR gives a 64-bit address, which ${typeName.toUpperCase()} cannot hold; use __XWORD, LWORD or ULINT`,
      value.sourceSpan.startLine,
      value.sourceSpan.startCol,
      value.sourceSpan.file,
    );
    return true;
  }

  /** `F(ADR(x))` and `fb.M(ADR(x))` into an input narrower than an address. */
  private refuseNarrowAddressArguments(
    expr: FunctionCallExpression,
    scope: Scope,
  ): void {
    if (this.isFBInstanceCall(expr, scope)) return;
    const inputs =
      this.callInputs(expr, scope) ??
      this.dottedMethodInputs(expr.functionName, scope);
    if (!inputs) return;
    stripEnEno(expr.arguments).forEach((arg, i) => {
      if (arg.isOutput || !isAddressOf(arg.value)) return;
      const argName = arg.name?.toUpperCase();
      const input =
        argName === undefined
          ? inputs[i]
          : inputs.find((p) => p.name.toUpperCase() === argName);
      if (input === undefined || input.type.referenceKind !== "none") return;
      this.refuseNarrowAddress(input.type.name, arg.value);
    });
  }

  /**
   * Resolve each named init argument of an FB instance (feature fb_init) and
   * check it against every FB_init input of that name in the chain; the
   * other init argument rules are the analyzer's (fb-init.ts).
   */
  private checkFbInitArguments(decl: VarDeclaration, scope: Scope): void {
    if (!this.features.has("fb_init") || !this.ast) return;
    const stored = storedInstance(this.ast, decl.type);
    const inits = stored ? fbInitChain(fbIndex(this.ast), stored.name) : [];
    for (const arg of decl.fbInitArguments ?? []) {
      const valueType = this.resolveExprType(arg.value, scope);
      if (arg.name === undefined || arg.isOutput || !valueType) continue;
      const name = arg.name.toUpperCase();
      for (const { method } of inits) {
        const input = fbInitInput(method, name);
        if (!input) continue;
        const target =
          ELEMENTARY_TYPES[input.type.name.toUpperCase()] ??
          this.symbolTables.lookupType(input.type.name)?.resolvedType;
        this.validateAssignment(
          target,
          valueType,
          {
            kind: "VariableExpression",
            sourceSpan: arg.sourceSpan,
            name,
            fieldAccess: [],
            subscripts: [],
            isDereference: false,
          },
          arg.value,
        );
      }
    }
  }

  /**
   * Walk statements, resolve all sub-expressions, and validate type rules.
   */
  private checkStatements(stmts: Statement[], scope: Scope): void {
    for (const stmt of stmts) {
      this.checkStatement(stmt, scope);
    }
  }

  /** Nesting depth of FOR/WHILE/REPEAT bodies (for CONTINUE). */
  private loopDepth = 0;

  private checkLoopBody(stmts: Statement[], scope: Scope): void {
    this.loopDepth++;
    try {
      this.checkStatements(stmts, scope);
    } finally {
      this.loopDepth--;
    }
  }

  private checkStatement(stmt: Statement, scope: Scope): void {
    switch (stmt.kind) {
      case "AssignmentStatement": {
        let targetType = this.resolveExprType(stmt.target, scope);
        const valueType = this.resolveExprType(stmt.value, scope);
        if (
          this.strict &&
          targetType === undefined &&
          this.currentReturn !== undefined &&
          stmt.target.kind === "VariableExpression" &&
          stmt.target.fieldAccess.length === 0 &&
          stmt.target.subscripts.length === 0 &&
          stmt.target.name.toUpperCase() ===
            this.currentReturn.name.toUpperCase()
        ) {
          // Assigning the return value: `Fn := x;` is checked against the declared type.
          targetType =
            ELEMENTARY_TYPES[this.currentReturn.type.name.toUpperCase()];
        }
        // `F := 'A'` in a FUNCTION returning CHAR: the literal is a CHAR.
        if (
          targetType === undefined &&
          this.currentReturn !== undefined &&
          stmt.target.kind === "VariableExpression" &&
          stmt.target.name.toUpperCase() ===
            this.currentReturn.name.toUpperCase()
        ) {
          this.adaptCharLiteral(
            stmt.value,
            this.charTypeOf(
              this.resolveNamedType(this.currentReturn.type.name),
            ),
          );
        }
        this.validateInOutMemberWrite(stmt.target, scope);
        if (this.isAddressIntoPointer(stmt.target, valueType, scope)) break;
        if (this.isZeroIntoPointer(stmt.target, stmt.value, scope)) break;
        if (this.checkArrayScalarAssignment(stmt.target, stmt.value, scope)) {
          break;
        }
        if (this.isTimerPresetTakingLtime(stmt.target, valueType, scope)) {
          break;
        }
        const errorsBefore = this.errors.length;
        this.validateAssignment(targetType, valueType, stmt.target, stmt.value);
        // One error per mistake: the REF_TO check only adds what the general one missed.
        if (this.errors.length === errorsBefore) {
          this.validateReferenceAssignment(stmt.target, stmt.value, scope);
        }
        break;
      }

      case "RefAssignStatement": {
        this.resolveExprType(stmt.target, scope);
        this.resolveExprType(stmt.source, scope);
        // REF= rebinds a reference, so the target must be declared
        // REF_TO / REFERENCE TO. Catch `plainVar REF= x` here with a clear
        // message rather than letting it fall through to a confusing C++
        // error (e.g. `IEC_INT` has no member `bind`).
        if (stmt.target.kind === "VariableExpression") {
          const sym = scope.lookup(stmt.target.name);
          // A member or element target is checked by its own declaration; one
          // that cannot be resolved falls back to the variable holding it.
          const base =
            sym?.kind === "variable"
              ? (sym.declaration as VarDeclaration | undefined)?.type
              : undefined;
          const declared = this.isSelfMember(stmt.target)
            ? resolveAccessType(
                { name: this.currentFBName!, referenceKind: "none" },
                stmt.target,
                this.accessLookup,
              )
            : base === undefined || !this.hasMemberAccess(stmt.target)
              ? base
              : (resolveAccessType(base, stmt.target, this.accessLookup) ??
                base);
          if (stmt.source.kind === "VariableExpression") {
            delete stmt.source.aliasReferenceBinding;
          }
          const targetShape = declared ? referenceShapeOf(declared) : undefined;
          const sourceShape = this.declaredReferenceShape(stmt.source, scope);
          if (
            targetShape?.chain.length === 1 &&
            targetShape.chain[0] === "reference_to" &&
            sourceShape !== undefined &&
            stmt.source.kind === "VariableExpression"
          ) {
            this.markAliasReferenceBinding(
              targetShape,
              sourceShape,
              stmt.source,
            );
          }
          if (
            targetShape?.chain.length === 1 &&
            (targetShape.chain[0] === "ref_to" ||
              targetShape.chain[0] === "reference_to") &&
            sourceShape !== undefined &&
            stmt.source.kind === "VariableExpression"
          ) {
            const mismatch = this.referenceBindingMismatch(
              targetShape,
              sourceShape,
              stmt.source,
            );
            if (mismatch !== undefined) {
              this.addError(
                mismatch,
                stmt.source.sourceSpan.startLine,
                stmt.source.sourceSpan.startCol,
                stmt.source.sourceSpan.file,
              );
            }
          }
          if (declared) {
            const refKind = declared.referenceKind;
            if (refKind !== "ref_to" && refKind !== "reference_to") {
              this.addError(
                `REF= requires a REF_TO or REFERENCE TO target; '${[stmt.target.name, ...stmt.target.fieldAccess].join(".")}' is not a reference`,
                stmt.target.sourceSpan.startLine,
                stmt.target.sourceSpan.startCol,
                stmt.target.sourceSpan.file,
              );
            }
          }
        }
        break;
      }

      case "IfStatement": {
        this.checkStrictTerminator(stmt);
        const condType = this.resolveExprType(stmt.condition, scope);
        this.validateCondition(condType, stmt.condition);
        this.checkStatements(stmt.thenStatements, scope);
        for (const clause of stmt.elsifClauses) {
          const clauseCondType = this.resolveExprType(clause.condition, scope);
          this.validateCondition(clauseCondType, clause.condition);
          this.checkStatements(clause.statements, scope);
        }
        this.checkStatements(stmt.elseStatements, scope);
        break;
      }

      case "CaseStatement": {
        this.checkStrictTerminator(stmt);
        const selectorType = this.resolveExprType(stmt.selector, scope);
        if (selectorType) {
          this.validateCaseSelector(selectorType, stmt.selector);
        }
        for (const c of stmt.cases) {
          const selectorChar = this.charTypeOf(selectorType);
          for (const label of c.labels) {
            this.resolveExprType(label.start, scope);
            if (label.end) this.resolveExprType(label.end, scope);
            // A CHAR selector takes 'a' and CHAR#'a' labels, of its own type only.
            if (selectorChar !== undefined) {
              for (const bound of label.end
                ? [label.start, label.end]
                : [label.start]) {
                this.adaptCharLiteral(bound, selectorChar);
                if (this.charTypeOf(bound.resolvedType) !== selectorChar) {
                  this.addError(
                    `CASE label of type ${bound.resolvedType ? typeNameUtil(bound.resolvedType) : "?"} does not match the selector of type ${selectorChar}`,
                    bound.sourceSpan.startLine,
                    bound.sourceSpan.startCol,
                    bound.sourceSpan.file,
                  );
                }
              }
              continue;
            }
            this.validateCaseLabelType(selectorType, label.start);
            if (label.end) this.validateCaseLabelType(selectorType, label.end);
          }
          this.checkStatements(c.statements, scope);
        }
        if (this.strict) this.checkStrictDuplicateLabels(stmt, scope);
        this.checkStatements(stmt.elseStatements, scope);
        break;
      }

      case "ForStatement": {
        this.checkStrictTerminator(stmt);
        // An empty statement (`DO ; END_FOR`) is a body; no statement is not.
        if (
          this.strict &&
          stmt.body.length === 0 &&
          stmt.emptyStatementBody !== true
        ) {
          this.addStrictErrorAt("A FOR loop must have a body", stmt.sourceSpan);
        }
        const startType = this.resolveExprType(stmt.start, scope);
        const endType = this.resolveExprType(stmt.end, scope);
        const stepType = stmt.step
          ? this.resolveExprType(stmt.step, scope)
          : undefined;
        // An enumeration bound does not fit the integer control variable.
        const bounds: Array<[Expression | undefined, IECType | undefined]> = [
          [stmt.start, startType],
          [stmt.end, endType],
          [stmt.step, stepType],
        ];
        for (const [bound, boundType] of bounds) {
          if (bound === undefined || boundType?.typeKind !== "enum") continue;
          const control = scope.lookup(stmt.controlVariable);
          const controlType =
            control?.kind === "variable" || control?.kind === "constant"
              ? control.type
              : undefined;
          this.addError(
            `Cannot assign ${typeNameUtil(boundType)} to ${controlType ? typeNameUtil(controlType) : "the control variable"}`,
            bound.sourceSpan.startLine,
            bound.sourceSpan.startCol,
            bound.sourceSpan.file,
          );
        }

        // Validate control variable type
        const controlSym = scope.lookup(stmt.controlVariable);
        if (
          controlSym?.kind === "variable" ||
          controlSym?.kind === "constant"
        ) {
          const ctrlType = controlSym.type;
          if (ctrlType && !_isTypeInCategory(ctrlType, "ANY_INT")) {
            this.addError(
              `FOR control variable '${stmt.controlVariable}' must be an integer type, got ${typeNameUtil(ctrlType)}`,
              stmt.sourceSpan.startLine,
              stmt.sourceSpan.startCol,
              stmt.sourceSpan.file,
            );
          }
          // Validate start/end compatibility with control variable
          // Use warnings instead of errors — CODESYS is lenient with FOR bounds
          if (
            ctrlType &&
            startType &&
            !this.isUntypedNumericLiteral(stmt.start)
          ) {
            if (
              ctrlType.typeKind === "elementary" &&
              startType.typeKind === "elementary" &&
              !_isAssignable(ctrlType, startType)
            ) {
              this.addWarning(
                `FOR start value type ${typeNameUtil(startType)} is not compatible with control variable type ${typeNameUtil(ctrlType)}`,
                stmt.start.sourceSpan.startLine,
                stmt.start.sourceSpan.startCol,
                stmt.start.sourceSpan.file,
              );
            }
          }
          if (ctrlType && endType && !this.isUntypedNumericLiteral(stmt.end)) {
            if (
              ctrlType.typeKind === "elementary" &&
              endType.typeKind === "elementary" &&
              !_isAssignable(ctrlType, endType)
            ) {
              this.addWarning(
                `FOR end value type ${typeNameUtil(endType)} is not compatible with control variable type ${typeNameUtil(ctrlType)}`,
                stmt.end.sourceSpan.startLine,
                stmt.end.sourceSpan.startCol,
                stmt.end.sourceSpan.file,
              );
            }
          }
        }
        this.checkLoopBody(stmt.body, scope);
        break;
      }

      case "WhileStatement": {
        this.checkStrictTerminator(stmt);
        const condType = this.resolveExprType(stmt.condition, scope);
        this.validateCondition(condType, stmt.condition);
        this.checkLoopBody(stmt.body, scope);
        break;
      }

      case "RepeatStatement": {
        this.checkStrictTerminator(stmt);
        this.checkLoopBody(stmt.body, scope);
        const condType = this.resolveExprType(stmt.condition, scope);
        this.validateCondition(condType, stmt.condition);
        break;
      }

      case "FunctionCallStatement": {
        if (stmt.call.kind === "FunctionCallExpression") {
          this.statementCalls.add(stmt.call);
        }
        // resolveExprType already validates function call args
        this.resolveExprType(stmt.call, scope);
        if (this.strict && stmt.call.kind === "FunctionCallExpression") {
          this.checkStrictDiscardedResult(stmt.call, scope);
          this.checkStrictFbParameters(stmt.call, scope);
        }
        if (stmt.call.kind === "FunctionCallExpression") {
          this.checkFbInstanceCallNames(stmt.call, scope);
        }
        break;
      }

      case "ContinueStatement":
        if (this.loopDepth === 0) {
          this.addError(
            "CONTINUE must be inside a FOR, WHILE or REPEAT loop",
            stmt.sourceSpan.startLine,
            stmt.sourceSpan.startCol,
            stmt.sourceSpan.file,
          );
        }
        break;

      case "ReturnStatement":
      case "ExitStatement":
      case "ExternalCodePragma":
        // No expressions to validate
        break;

      case "DeleteStatement": {
        this.resolveExprType(stmt.pointer, scope);
        break;
      }

      case "AssertCall": {
        // Assert calls may have conditions
        break;
      }
    }
  }

  // ===========================================================================
  // Validation Helpers
  // ===========================================================================

  private validateAssignment(
    targetType: IECType | undefined,
    valueType: IECType | undefined,
    target: Expression,
    value: Expression,
  ): void {
    if (this.adaptCharLiteral(value, this.charTypeOf(targetType))) {
      valueType = value.resolvedType;
    }
    const targetInterface = this.interfaceTypeOf(targetType);
    if (targetInterface !== undefined) {
      this.checkInterfaceValue(targetInterface, valueType, value);
      return;
    }
    if (!targetType || !valueType) return;

    const related = this.structRelation(
      typeNameUtil(targetType),
      typeNameUtil(valueType),
    );
    if (related !== undefined) {
      this.addError(
        `Cannot assign ${typeNameUtil(valueType)} to ${typeNameUtil(targetType)}: ${related}`,
        value.sourceSpan.startLine,
        value.sourceSpan.startCol,
        value.sourceSpan.file,
      );
      return;
    }

    if (this.isSameStructuredType(targetType, valueType)) return;

    if (this.strict && this.checkStrictConversion(targetType, value)) return;

    // Integer/real/bool literals without explicit type prefix are polymorphic:
    // they can be assigned to any compatible numeric or bit type.
    if (this.isUntypedNumericLiteral(value)) {
      if (targetType.typeKind === "elementary") {
        // INT/REAL literals → any numeric or bit type
        if (
          _isTypeInCategory(targetType, "ANY_NUM") ||
          _isTypeInCategory(targetType, "ANY_BIT")
        ) {
          return;
        }
      }
    }

    // Check assignment compatibility
    if (!_isAssignable(targetType, valueType)) {
      // Check if it's a function name assignment (return value)
      if (target.kind === "VariableExpression") {
        const funcSym = this.symbolTables.lookupFunction(target.name);
        if (funcSym) return; // Function return assignment
      }

      // Allow reference/pointer assignments to non-reference types (CODESYS pattern)
      if (
        valueType.typeKind === "reference" ||
        targetType.typeKind === "reference"
      ) {
        return;
      }

      // For elementary types, check if this is narrowing (warning) vs truly incompatible (error)
      if (
        targetType.typeKind === "elementary" &&
        valueType.typeKind === "elementary"
      ) {
        const tName = (targetType as ElementaryType).name;
        const vName = (valueType as ElementaryType).name;

        // If either side is a FB or struct type, it's definitely incompatible
        // with a scalar type — fall through to the error report.
        // Otherwise, skip validation for user-defined type aliases we can't
        // fully resolve (e.g. MyInt := INT where MyInt is an alias for INT).
        const tIsFbOrStruct = this.isKnownCompositeType(tName);
        const vIsFbOrStruct = this.isKnownCompositeType(vName);
        if (!tIsFbOrStruct && !vIsFbOrStruct) {
          if (
            !ELEMENTARY_TYPES[tName] ||
            !ELEMENTARY_TYPES[vName] ||
            this.isUserTypeOfEd3Name(tName) ||
            this.isUserTypeOfEd3Name(vName)
          ) {
            return;
          }
        }

        // Narrowing conversions are warnings, not errors
        if (isNarrowingConversion(tName, vName)) {
          this.addWarning(
            `Implicit narrowing conversion from ${vName} to ${tName}`,
            value.sourceSpan.startLine,
            value.sourceSpan.startCol,
            value.sourceSpan.file,
          );
          return;
        }
      }

      this.addError(
        `Cannot assign ${typeNameUtil(valueType)} to ${typeNameUtil(targetType)}`,
        value.sourceSpan.startLine,
        value.sourceSpan.startCol,
        value.sourceSpan.file,
      );
      return;
    }
  }

  /** The interface this compile declares under `name`. */
  private interfaceNamed(name: string): InterfaceDeclaration | undefined {
    const upper = name.toUpperCase();
    return this.ast?.interfaces.find((i) => i.name.toUpperCase() === upper);
  }

  /** The interface name when `type` is a plain interface type (not a reference or array). */
  private interfaceTypeOf(type: IECType | undefined): string | undefined {
    if (type?.typeKind !== "elementary") return undefined;
    const name = (type as ElementaryType).name;
    return this.interfaceNamed(name) ? name : undefined;
  }

  /** A declared type that is a plain interface: the variable refers to an instance. */
  private isInterfaceDeclType(type: AccessType): boolean {
    return (
      (type.referenceKind === undefined || type.referenceKind === "none") &&
      type.arrayDimensions === undefined &&
      this.interfaceNamed(type.name) !== undefined
    );
  }

  /**
   * Interface `source` is `target` or extends it, directly or through a base.
   * Undefined when an interface on the way is not declared in this compile.
   */
  private interfaceExtends(
    source: string,
    target: string,
    depth = 0,
  ): boolean | undefined {
    if (source.toUpperCase() === target.toUpperCase()) return true;
    const itf = this.interfaceNamed(source);
    if (!itf || depth >= 32) return undefined;
    let unknown = false;
    for (const base of itf.extends ?? []) {
      const found = this.interfaceExtends(base, target, depth + 1);
      if (found === true) return true;
      if (found === undefined) unknown = true;
    }
    return unknown ? undefined : false;
  }

  /**
   * Function block `fbName`, or a base it extends, implements `target` or an
   * interface extending it. Undefined when a type on the way is not declared here.
   */
  private fbImplements(fbName: string, target: string): boolean | undefined {
    let current: string | undefined = fbName.toUpperCase();
    let unknown = false;
    for (let depth = 0; current !== undefined && depth < 32; depth++) {
      const upper: string = current;
      const fb = this.ast?.functionBlocks.find(
        (f) => f.name.toUpperCase() === upper,
      );
      if (!fb) return undefined;
      for (const itf of fb.implements ?? []) {
        const found = this.interfaceExtends(itf, target);
        if (found === true) return true;
        if (found === undefined) unknown = true;
      }
      current = fb.extends?.toUpperCase();
    }
    return unknown || current !== undefined ? undefined : false;
  }

  /**
   * A value stored in a variable of interface `target`: NULL, an instance of
   * an implementing FB (THIS included) or a variable of the same or an
   * extending interface. Anything this compile cannot resolve passes.
   */
  private checkInterfaceValue(
    target: string,
    valueType: IECType | undefined,
    value: Expression,
  ): void {
    if (isUntypedZero(value)) {
      this.checkInterfaceZero(target, value);
      return;
    }
    let source: string | undefined;
    if (valueType === undefined) {
      const bareThis =
        value.kind === "VariableExpression" &&
        value.name.toUpperCase() === "THIS" &&
        value.fieldAccess.length === 0 &&
        (value.accessChain === undefined || value.accessChain.length === 0);
      if (!bareThis || this.currentFBName === undefined) return;
      source = this.currentFBName;
    } else if (valueType.typeKind === "reference") {
      return;
    } else {
      source = typeNameUtil(valueType);
    }
    const fail = (detail: string): void => {
      this.addError(
        `Cannot assign ${source} to ${target}${detail}`,
        value.sourceSpan.startLine,
        value.sourceSpan.startCol,
        value.sourceSpan.file,
      );
    };
    const upper = source.toUpperCase();
    if (this.interfaceNamed(source)) {
      if (this.interfaceExtends(source, target) === false) {
        fail(`: ${source} does not extend ${target}`);
      }
      return;
    }
    if (this.ast?.functionBlocks.some((f) => f.name.toUpperCase() === upper)) {
      if (this.fbImplements(source, target) === false) {
        fail(`: ${source} does not implement ${target}`);
      }
      return;
    }
    const isStruct =
      this.ast?.types.some(
        (t) =>
          t.name.toUpperCase() === upper &&
          t.definition.kind === "StructDefinition",
      ) ?? false;
    if (ELEMENTARY_TYPES[upper] !== undefined || isStruct) fail("");
  }

  /**
   * A `0` stored in interface `target`: NULL with the feature interface_zero
   * (marked for codegen), else refused naming the feature.
   */
  private checkInterfaceZero(target: string, value: LiteralExpression): void {
    if (this.features.has("interface_zero")) {
      value.asNull = true;
      return;
    }
    this.addError(
      this.featureMessage(
        "interface_zero",
        `Assigning 0 to interface ${target}`,
      ),
      value.sourceSpan.startLine,
      value.sourceSpan.startCol,
      value.sourceSpan.file,
    );
  }

  /**
   * Why a value of STRUCT `source` cannot be stored in STRUCT `target` when one
   * extends the other (IEC 61131-3 6.4.4.6: only the same type); else undefined.
   */
  private structRelation(
    targetName: string,
    sourceName: string,
  ): string | undefined {
    // Through aliases: `TYPE AB : ST_B;` relates as ST_B does.
    const target = this.aliasTarget(targetName);
    const source = this.aliasTarget(sourceName);
    if (!this.ast || target.toUpperCase() === source.toUpperCase()) {
      return undefined;
    }
    const pair = structExtends(this.ast, source, target)
      ? `${source} EXTENDS ${target}`
      : structExtends(this.ast, target, source)
        ? `${target} EXTENDS ${source}`
        : undefined;
    return pair === undefined
      ? undefined
      : `a structured variable is assignment-compatible only with the same type (${pair})`;
  }

  /** A UNION TYPE of this unit (feature union). */
  private isUnionType(name: string): boolean {
    const upper = name.toUpperCase();
    return (
      this.ast?.types.some(
        (t) =>
          t.name.toUpperCase() === upper &&
          t.definition.kind === "StructDefinition" &&
          t.definition.isUnion === true,
      ) ?? false
    );
  }

  /**
   * A UNION, also through aliases or from a library: its members live in the
   * UNION's storage, so code generation reads and writes them through it.
   */
  private isUnionStorageType(name: string): boolean {
    const target = this.aliasTarget(name);
    if (this.isUnionType(target)) return true;
    const def = this.symbolTables.lookupType(target)?.declaration?.definition;
    return def?.kind === "StructDefinition" && def.isUnion === true;
  }

  /**
   * A UNION is assignment-compatible only with the same UNION: an argument of
   * another type for a UNION input, or a UNION for an elementary or STRUCT one.
   * Generic inputs (ANY...) are left alone. Names are known to differ.
   */
  private isUnionArgumentMismatch(
    sourceName: string,
    targetName: string,
  ): boolean {
    const source = this.aliasTarget(sourceName);
    const target = this.aliasTarget(targetName);
    if (source.toUpperCase() === target.toUpperCase()) return false;
    if (this.isUnionType(target)) return true;
    if (!this.isUnionType(source)) return false;
    return (
      ELEMENTARY_TYPES[target.toUpperCase()] !== undefined ||
      this.isStructType(target)
    );
  }

  /**
   * Two names for one STRUCT or UNION: an alias (`TYPE T_A : ST_A;`, also
   * chained) names the same type, so either side may stand for the other.
   */
  private isSameStructuredType(a: IECType, b: IECType): boolean {
    const target = this.aliasTarget(typeNameUtil(a));
    if (
      target.toUpperCase() !== this.aliasTarget(typeNameUtil(b)).toUpperCase()
    )
      return false;
    return this.isStructType(target);
  }

  /** {@link isSameStructuredType} for two declared types without reference levels. */
  private isSameStructuredAccess(a: AccessType, b: AccessType): boolean {
    if ((referenceShapeOf(a)?.chain ?? []).length > 0) return false;
    if ((referenceShapeOf(b)?.chain ?? []).length > 0) return false;
    const target = this.aliasTarget(a.name);
    if (target.toUpperCase() !== this.aliasTarget(b.name).toUpperCase())
      return false;
    return this.isStructType(target);
  }

  /** The type a chain of plain aliases (`TYPE T : U;`) of this unit ends on. */
  private aliasTarget(name: string): string {
    const seen = new Set<string>();
    let current = name;
    for (;;) {
      const upper = current.toUpperCase();
      if (seen.has(upper)) return current;
      seen.add(upper);
      const def = this.ast?.types.find(
        (t) => t.name.toUpperCase() === upper,
      )?.definition;
      if (
        def?.kind !== "TypeReference" ||
        def.arrayDimensions !== undefined ||
        (def.referenceKind ?? "none") !== "none"
      ) {
        return current;
      }
      current = def.name;
    }
  }

  /** A STRUCT (or UNION) TYPE of this unit. */
  private isStructType(name: string): boolean {
    const upper = name.toUpperCase();
    return (
      this.ast?.types.some(
        (t) =>
          t.name.toUpperCase() === upper &&
          t.definition.kind === "StructDefinition",
      ) ?? false
    );
  }

  /**
   * An argument of one STRUCT type bound to a VAR_INPUT or VAR_IN_OUT of
   * another (aliases name the same type). Only STRUCTs this compile declares.
   */
  /**
   * An enumeration value bound to an input of another type (an integer, or
   * another enumeration), or a value of another type bound to an enumeration
   * input: the C++ enum class converts neither way.
   */
  private validateEnumArguments(
    inputs: CallInput[] | undefined,
    args: readonly Argument[],
  ): void {
    if (!inputs) return;
    stripEnEno([...args]).forEach((arg, i) => {
      if (arg.isOutput) return;
      const argName = arg.name?.toUpperCase();
      const input =
        argName === undefined
          ? inputs[i]
          : inputs.find((p) => p.name.toUpperCase() === argName);
      if (!input || input.inOut) return;
      const refKind = input.type.referenceKind;
      if (refKind !== undefined && refKind !== "none") return;
      if (input.type.arrayDimensions !== undefined) return;
      const valueType = arg.value.resolvedType;
      if (valueType === undefined) return;
      const paramType = this.resolveNamedType(input.type.name);
      if (paramType === undefined) return;
      const argEnum = valueType.typeKind === "enum";
      const paramEnum = paramType.typeKind === "enum";
      if (!argEnum && !paramEnum) return;
      if (
        argEnum &&
        paramEnum &&
        typeNameUtil(valueType).toUpperCase() ===
          typeNameUtil(paramType).toUpperCase()
      ) {
        return;
      }
      // Only an elementary value against an enumeration, or the reverse.
      const other = argEnum ? paramType : valueType;
      if (other.typeKind !== "enum" && other.typeKind !== "elementary") return;
      this.addError(
        `Cannot assign ${typeNameUtil(valueType)} to parameter '${input.name}' of type ${typeNameUtil(paramType)}`,
        arg.value.sourceSpan.startLine,
        arg.value.sourceSpan.startCol,
        arg.value.sourceSpan.file,
      );
    });
  }

  private validateStructArguments(
    inputs: CallInput[] | undefined,
    args: readonly Argument[],
  ): void {
    if (!inputs) return;
    stripEnEno([...args]).forEach((arg, i) => {
      if (arg.isOutput) return;
      const argName = arg.name?.toUpperCase();
      const input =
        argName === undefined
          ? inputs[i]
          : inputs.find((p) => p.name.toUpperCase() === argName);
      const valueType = arg.value.resolvedType;
      if (!input || !valueType) return;
      const refKind = input.type.referenceKind;
      if (refKind !== undefined && refKind !== "none") return;
      if (input.type.arrayDimensions !== undefined) return;
      const source = typeNameUtil(valueType);
      const target = input.type.name;
      if (source.toUpperCase() === target.toUpperCase()) return;
      if (this.isUnionArgumentMismatch(source, target)) {
        this.addError(
          `Cannot assign ${source} to parameter '${input.name}' of type ${target}`,
          arg.value.sourceSpan.startLine,
          arg.value.sourceSpan.startCol,
          arg.value.sourceSpan.file,
        );
        return;
      }
      if (
        this.aliasTarget(source).toUpperCase() ===
        this.aliasTarget(target).toUpperCase()
      ) {
        return;
      }
      if (
        !this.isStructType(this.aliasTarget(source)) ||
        !this.isStructType(this.aliasTarget(target))
      ) {
        return;
      }
      const related = this.structRelation(target, source);
      this.addError(
        `Cannot assign ${source} to parameter '${input.name}' of type ${target}${related === undefined ? "" : `: ${related}`}`,
        arg.value.sourceSpan.startLine,
        arg.value.sourceSpan.startCol,
        arg.value.sourceSpan.file,
      );
    });
  }

  /**
   * An argument bound to a REFERENCE TO input becomes what the input refers
   * to, so it must be a variable (not an expression or a constant) of exactly
   * the referenced type, or a REFERENCE TO that type. Types are compared by
   * name, so an alias or subrange of INT is not INT. Only types this compile
   * knows are compared; an array or an unresolved argument is left alone.
   */
  private validateReferenceToArguments(
    inputs: CallInput[] | undefined,
    args: readonly Argument[],
    scope: Scope,
  ): void {
    if (!inputs) return;
    stripEnEno([...args]).forEach((arg, i) => {
      if (arg.isOutput) return;
      const argName = arg.name?.toUpperCase();
      const input =
        argName === undefined
          ? inputs[i]
          : inputs.find((p) => p.name.toUpperCase() === argName);
      if (!input || input.inOut) return;
      const target = referenceShapeOf(input.type);
      if (target?.chain.length !== 1 || target.chain[0] !== "reference_to") {
        return;
      }
      const value = arg.value;
      if (value.kind === "VariableExpression") {
        delete value.aliasReferenceBinding;
      }
      const fail = (message: string): void =>
        this.addError(
          message,
          value.sourceSpan.startLine,
          value.sourceSpan.startCol,
          value.sourceSpan.file,
        );
      if (value.kind !== "VariableExpression") {
        fail(
          `REFERENCE TO input '${input.name}' needs a variable to refer to, not an expression`,
        );
        return;
      }
      if (scope.lookup(value.name)?.kind === "constant") {
        fail(
          `REFERENCE TO input '${input.name}' needs a variable to refer to, not a constant`,
        );
        return;
      }
      const source = this.declaredReferenceShape(value, scope);
      if (!source) return;
      const mismatch = this.referenceBindingMismatch(target, source, value);
      if (mismatch !== undefined) fail(mismatch);
    });
  }

  /**
   * Why a REF_TO or REFERENCE TO (one level, `target`) cannot refer to the
   * variable `value` of shape `source` (a plain variable or a REFERENCE TO,
   * which refers on): another type, or another STRING length. Undefined
   * when it can or the types are not known here; an alias source is marked.
   */
  private referenceBindingMismatch(
    target: ReferenceShape,
    source: ReferenceShape,
    value: VariableExpression,
  ): string | undefined {
    const levelsOk =
      source.chain.length === 0 ||
      (source.chain.length === 1 && source.chain[0] === "reference_to");
    if (levelsOk) {
      if (
        !this.isReferableType(target.base) ||
        !this.isReferableType(source.base)
      ) {
        return undefined;
      }
      if (
        canonicalElementaryName(this.aliasBase(target.base)) ===
        canonicalElementaryName(this.aliasBase(source.base))
      ) {
        const t = this.stringAliasResolved(target);
        const v = this.stringAliasResolved(source);
        if (isStringBase(t.base) && stringLengthsDiffer(t, v)) {
          return `${describeReferenceShape(t)} cannot refer to a ${stringText(v)} variable`;
        }
        if (target.chain[0] === "reference_to") {
          this.markAliasReferenceBinding(target, source, value);
        }
        return undefined;
      }
    }
    return `${describeReferenceShape(target)} cannot refer to a ${describeReferenceShape(source)} variable${levelsOk ? this.referenceMismatchReason(this.aliasBase(source.base)) : ""}`;
  }

  /**
   * `shape` with an alias of STRING(n) / WSTRING(n) (chained) as its base
   * replaced by the string type and its length; any other shape unchanged.
   */
  private stringAliasResolved(shape: ReferenceShape): ReferenceShape {
    let base = shape.base.toUpperCase();
    let length = shape.length;
    for (let i = 0; i < 32; i++) {
      const upper = base;
      const def = this.ast?.types.find(
        (td) => td.name.toUpperCase() === upper,
      )?.definition;
      if (
        def?.kind !== "TypeReference" ||
        def.arrayDimensions !== undefined ||
        (def.referenceKind !== undefined && def.referenceKind !== "none")
      ) {
        break;
      }
      base = def.name.toUpperCase();
      length ??= def.maxLength;
    }
    if (!isStringBase(base) || base === shape.base.toUpperCase()) return shape;
    return {
      ...shape,
      base,
      ...(length !== undefined ? { length } : {}),
    };
  }

  /** A call of a function-block instance (`fb(...)`, `arr[i](...)`). */
  private isFBInstanceCall(
    expr: FunctionCallExpression,
    scope: Scope,
  ): boolean {
    if (expr.instance !== undefined) return true;
    if (this.ownMethod(expr.functionName)) return false;
    if (this.calledInstance(expr.functionName, scope)) return true;
    if (this.findUserFunction(expr.functionName)) return false;
    return scope.lookup(expr.functionName)?.kind === "variable";
  }

  /**
   * A binding form IEC forbids but that compiles: an error under the IEC
   * profile, else a warning that says what the generated code does instead.
   */
  private inOutDiagnostic(
    message: string,
    fallback: string,
    node: { sourceSpan: SourceSpan },
  ): void {
    const span = node.sourceSpan;
    if (this.inOutErrors) {
      this.addError(message, span.startLine, span.startCol, span.file);
    } else {
      this.addWarning(
        `${message}; ${fallback}`,
        span.startLine,
        span.startCol,
        span.file,
      );
    }
  }

  /**
   * Arguments bound to VAR_IN_OUT parameters (IEC 61131-3 6.6.1.4.1 rule 2,
   * 6.6.1.6): each in-out is assigned in the call, to a writable variable of
   * its own type. A non-variable (expression, literal, bit of a variable)
   * cannot be referred to and is always an error. The other forms compile
   * (by copy, or with the previous binding) and are diagnosed by
   * inOutDiagnostic.
   */
  private validateInOutArguments(
    inputs: CallInput[] | undefined,
    args: readonly Argument[],
    scope: Scope,
    fbCall: boolean,
    call: { sourceSpan: SourceSpan },
  ): void {
    if (inputs?.some((p) => p.inOut) !== true) return;
    const userArgs = stripEnEno([...args]);
    const bound = new Set<string>();
    userArgs.forEach((arg, i) => {
      const argName = arg.name?.toUpperCase();
      const input =
        argName === undefined
          ? inputs[i]
          : inputs.find((p) => p.name.toUpperCase() === argName);
      if (!input) return;
      bound.add(input.name.toUpperCase());
      if (!input.inOut || arg.isOutput) return;
      if (
        this.refuseStringElement(
          arg.value,
          `VAR_IN_OUT '${input.name}' cannot be bound to`,
        )
      ) {
        return;
      }
      this.validateInOutArgument(input, arg, scope);
    });
    for (const input of inputs) {
      if (!input.inOut || bound.has(input.name.toUpperCase())) continue;
      this.inOutDiagnostic(
        `VAR_IN_OUT '${input.name}' is not assigned in this call`,
        fbCall
          ? "the call keeps the binding of the previous call"
          : "a temporary is passed in its place",
        call,
      );
    }
  }

  /** One argument bound to an in-out (see validateInOutArguments). */
  private validateInOutArgument(
    input: CallInput,
    arg: Argument,
    scope: Scope,
  ): void {
    delete arg.inOutCopy;
    const value = arg.value;
    const fail = (what: string): void =>
      this.addError(
        `VAR_IN_OUT '${input.name}' must be bound to a variable, not ${what}`,
        value.sourceSpan.startLine,
        value.sourceSpan.startCol,
        value.sourceSpan.file,
      );
    if (value.kind !== "VariableExpression") {
      fail(value.kind === "LiteralExpression" ? "a literal" : "an expression");
      return;
    }
    const steps =
      value.accessChain?.map((s) => (s.kind === "field" ? s.name : "")) ??
      value.fieldAccess;
    if (/^\d+$/.test(steps[steps.length - 1] ?? "")) {
      fail("a bit of a variable");
      return;
    }
    const upper = value.name.toUpperCase();
    if (upper === "THIS" || upper === "SUPER") return;
    const sym = scope.lookup(value.name);
    if (!sym) {
      if (value.resolvedType?.typeKind === "enum") fail("an enumeration value");
      return;
    }
    if (sym.kind === "constant") {
      fail(
        (sym.declaration as VarDeclaration | undefined) !== undefined
          ? `the constant '${value.name}'`
          : "a constant value",
      );
      return;
    }
    if (sym.kind !== "variable") return;
    if (
      sym.isInput &&
      !sym.isGlobal &&
      !sym.isExternal &&
      (sym.declaration as VarDeclaration | undefined)?.type.referenceKind !==
        "reference_to"
    ) {
      this.inOutDiagnostic(
        `VAR_IN_OUT '${input.name}' is bound to the input '${value.name}', which this POU may not modify`,
        "the callee writes the input",
        value,
      );
    }
    const declared = sym.declaration as VarDeclaration | undefined;
    if (!declared) return;
    const argType = this.hasMemberAccess(value)
      ? resolveAccessType(declared.type, value, this.accessLookup)
      : declared.type;
    if (!argType) return;
    if (this.stringElementLengthsDiffer(input.type, argType)) {
      // Another C++ element type: passed by copy, as before lengths were kept.
      arg.inOutCopy = true;
      return;
    }
    const mismatch = this.inOutTypeMismatch(input.type, argType);
    if (mismatch === undefined) return;
    this.inOutDiagnostic(
      `VAR_IN_OUT '${input.name}' of type ${mismatch.param} is bound to a variable of type ${mismatch.arg}`,
      "it is passed by copy-in / copy-out, not by reference",
      value,
    );
    arg.inOutCopy = true;
  }

  /**
   * The two type names when an in-out of type `param` cannot refer to a
   * variable of type `arg`: elementary, STRING / WSTRING (with length), enum
   * and alias types compared by name, reference levels included. Arrays,
   * STRUCTs, FBs, interfaces and types this unit cannot see are left alone.
   */
  private inOutTypeMismatch(
    param: AccessType,
    arg: AccessType,
  ): { param: string; arg: string } | undefined {
    if (
      param.arrayDimensions !== undefined ||
      arg.arrayDimensions !== undefined
    ) {
      return undefined;
    }
    const simple = (t: AccessType): boolean => {
      const upper = t.name.toUpperCase();
      if (ELEMENTARY_TYPES[canonicalElementaryName(upper)]) return true;
      const def = this.ast?.types.find(
        (td) => td.name.toUpperCase() === upper,
      )?.definition;
      return (
        def?.kind === "EnumDefinition" ||
        (def?.kind === "TypeReference" && def.arrayDimensions === undefined) ||
        def?.kind === "SubrangeDefinition"
      );
    };
    if (!simple(param) || !simple(arg)) return undefined;
    if (this.isSameStructuredAccess(param, arg)) return undefined;
    const describe = (t: AccessType): string => {
      const levels = referenceShapeOf(t)?.chain ?? [];
      const length = (t as { maxLength?: number | string }).maxLength;
      const base =
        length !== undefined ? `${t.name}(${String(length)})` : t.name;
      return describeReferenceShape({ chain: levels, base });
    };
    const key = (t: AccessType): string =>
      describe({ ...t, name: canonicalElementaryName(t.name.toUpperCase()) });
    if (key(param) === key(arg)) return undefined;
    return {
      param: describe(param).toUpperCase(),
      arg: describe(arg).toUpperCase(),
    };
  }

  /**
   * Two ARRAYs of STRING (or of WSTRING) whose elements differ only in length:
   * distinct C++ types, so an in-out between them is passed by copy.
   */
  private stringElementLengthsDiffer(a: AccessType, b: AccessType): boolean {
    const element = (
      t: AccessType,
    ): { name: string; length: string } | undefined => {
      if (t.referenceKind !== undefined && t.referenceKind !== "none") {
        return undefined;
      }
      let name: string | undefined;
      let length: number | string | undefined;
      if (t.arrayDimensions !== undefined) {
        if (t.elementReferenceChain !== undefined) return undefined;
        name = t.elementTypeName;
        length = t.elementMaxLength;
      } else {
        const upper = t.name.toUpperCase();
        const def = this.ast?.types.find(
          (td) => td.name.toUpperCase() === upper,
        )?.definition;
        if (def?.kind !== "ArrayDefinition") return undefined;
        if (
          def.elementType.referenceKind !== undefined &&
          def.elementType.referenceKind !== "none"
        ) {
          return undefined;
        }
        name = def.elementType.name;
        length = def.elementType.maxLength;
      }
      const upper = name?.toUpperCase();
      if (upper !== "STRING" && upper !== "WSTRING") return undefined;
      return { name: upper, length: String(length ?? 254).toUpperCase() };
    };
    const x = element(a);
    const y = element(b);
    return (
      x !== undefined &&
      y !== undefined &&
      x.name === y.name &&
      x.length !== y.length
    );
  }

  /**
   * `inst.x := v` where `x` is a VAR_IN_OUT of the instance's block: written
   * from outside the block (IEC 61131-3 Figure 13, 6b).
   */
  private validateInOutMemberWrite(target: Expression, scope: Scope): void {
    if (target.kind !== "VariableExpression") return;
    const upper = target.name.toUpperCase();
    if (upper === "THIS" || upper === "SUPER") return;
    const sym = scope.lookup(target.name);
    if (sym?.kind !== "variable") return;
    const declared = sym.declaration as VarDeclaration | undefined;
    if (!declared) return;
    const steps: AccessStep[] = target.accessChain ?? [
      ...(target.subscripts.length > 0
        ? [{ kind: "subscript" as const, indices: target.subscripts }]
        : []),
      ...target.fieldAccess.map((name) => ({ kind: "field" as const, name })),
    ];
    let current: AccessType | undefined = declared.type;
    for (const step of steps) {
      if (current === undefined) return;
      if (step.kind === "field") {
        if (this.isInOutMemberOf(current.name, step.name)) {
          // From outside the block it is refused as an access (refuseInternalMember).
          const inside =
            this.currentFBName !== undefined &&
            this.fbLineage(this.currentFBName).has(current.name.toUpperCase());
          if (!inside) return;
          this.inOutDiagnostic(
            `'${step.name}' is a VAR_IN_OUT of '${current.name}' and cannot be written from outside the function block`,
            "the write goes to the variable the last call bound",
            target,
          );
          return;
        }
        current = this.accessLookup.field(current.name, step.name)?.type;
      } else if (step.kind === "subscript") {
        current =
          this.accessLookup.arrayElement(current.name) ??
          (current.elementTypeName !== undefined
            ? { name: current.elementTypeName, referenceKind: "none" }
            : undefined);
      } else {
        return;
      }
    }
  }

  /** `field` is declared VAR_IN_OUT by function block `typeName` or a base of it. */
  private isInOutMemberOf(typeName: string, field: string): boolean {
    const upper = field.toUpperCase();
    let current: string | undefined = typeName.toUpperCase();
    for (let depth = 0; current !== undefined && depth < 32; depth++) {
      const owner: string = current;
      const fb = this.ast?.functionBlocks.find(
        (f) => f.name.toUpperCase() === owner,
      );
      if (!fb) {
        const lib = this.symbolTables.lookupFunctionBlock(owner);
        return lib?.inouts.some((m) => m.name.toUpperCase() === upper) ?? false;
      }
      for (const block of fb.varBlocks) {
        for (const decl of block.declarations) {
          if (decl.names.some((n) => n.toUpperCase() === upper)) {
            return block.blockType === "VAR_IN_OUT";
          }
        }
      }
      current = fb.extends?.toUpperCase();
    }
    return false;
  }

  /**
   * The type an alias chain (`TYPE A : B; END_TYPE`, plain, no reference or
   * array) ends at, upper case; `name` itself when it is not an alias.
   */
  /**
   * A user TYPE named like an elementary type Ed. 3 added (`LTIME_OF_DAY`),
   * which programs declared before the type existed: the user's type stays.
   */
  private isUserTypeOfEd3Name(name: string): boolean {
    const upper = name.toUpperCase();
    return (
      ED3_ELEMENTARY_NAMES.has(upper) &&
      this.ast?.types.some((t) => t.name.toUpperCase() === upper) === true
    );
  }

  /**
   * `x.PT := ltimeValue` on a TP, TON or TOF of the standard library, held in
   * a variable, an array element or a member: Table 46 overloads those timers
   * on TIME and LTIME, and both have one representation.
   */
  private isTimerPresetTakingLtime(
    target: Expression,
    valueType: IECType | undefined,
    scope: Scope,
  ): boolean {
    if (
      valueType === undefined ||
      target.kind !== "VariableExpression" ||
      valueType.typeKind !== "elementary" ||
      (valueType as ElementaryType).name.toUpperCase() !== "LTIME"
    ) {
      return false;
    }
    const v = target;
    const chain = v.accessChain ?? [];
    const last = chain[chain.length - 1];
    const lastField =
      last !== undefined
        ? last.kind === "field"
          ? last.name
          : undefined
        : v.subscripts.length === 0
          ? v.fieldAccess[v.fieldAccess.length - 1]
          : undefined;
    if (lastField?.toUpperCase() !== "PT") return false;
    // The type holding PT: the target without its last step, typed silently.
    const owner: VariableExpression = {
      ...v,
      fieldAccess: v.fieldAccess.slice(0, -1),
    };
    if (chain.length > 0) owner.accessChain = chain.slice(0, -1);
    else delete owner.accessChain;
    const errors = this.errors.length;
    const warnings = this.warnings.length;
    const ownerType = this.inferType(owner, scope);
    this.errors.length = errors;
    this.warnings.length = warnings;
    const typeName =
      ownerType !== undefined
        ? typeNameUtil(ownerType).toUpperCase()
        : undefined;
    if (typeName !== "TP" && typeName !== "TON" && typeName !== "TOF") {
      return false;
    }
    return (
      this.symbolTables.lookupFunctionBlock(typeName)?.libraryName ===
      "iec-standard-fb"
    );
  }

  /**
   * `s[i]` is a character of a string, not a variable: it cannot be bound to
   * an in/out or referenced. True when it was refused.
   */
  private refuseStringElement(expr: Expression, what: string): boolean {
    let e = expr;
    while (e.kind === "ParenthesizedExpression") e = e.expression;
    if (e.kind !== "VariableExpression" || e.stringElement !== true) {
      return false;
    }
    this.addError(
      `${what} a character of a string (${e.name}[...]); assign it to a CHAR or WCHAR variable first`,
      e.sourceSpan.startLine,
      e.sourceSpan.startCol,
      e.sourceSpan.file,
    );
    return true;
  }

  /** `CHAR_TO_INT('A')`: the literal source of a CHAR or WCHAR conversion is that character. */
  private adaptCharConversionArgument(expr: FunctionCallExpression): void {
    const name = expr.functionName.toUpperCase();
    const from = /^(W?CHAR)_TO_/.exec(name)?.[1] as
      | "CHAR"
      | "WCHAR"
      | undefined;
    if (from === undefined || this.findUserFunction(name)) return;
    const arg = stripEnEno(expr.arguments)[0];
    if (arg !== undefined) this.adaptCharLiteral(arg.value, from);
  }

  /** CHAR or WCHAR when the named type is one of them, through aliases. */
  private charTypeOfName(name: string): "CHAR" | "WCHAR" | undefined {
    const base = this.aliasBase(name);
    return base === "CHAR" || base === "WCHAR" ? base : undefined;
  }

  /**
   * The initial value of a CHAR or WCHAR (through aliases, as an array element
   * or STRUCT field too): a one-character literal is that character, and a
   * literal of any other type is refused, as its assignment is.
   */
  private checkCharInitialValue(typeName: string, value: Expression): void {
    const charType = this.charTypeOfName(typeName);
    if (charType === undefined || this.adaptCharLiteral(value, charType)) {
      return;
    }
    if (value.kind !== "LiteralExpression") return;
    const literalType = this.charLiteralSourceType(value);
    if (literalType === charType || this.reportedCharValues.has(value)) return;
    this.reportedCharValues.add(value);
    this.addError(
      `Cannot assign ${literalType} to ${typeName.toUpperCase()}`,
      value.sourceSpan.startLine,
      value.sourceSpan.startCol,
      value.sourceSpan.file,
    );
  }

  /** The type a literal names: its prefix when typed, else its literal type. */
  private charLiteralSourceType(lit: LiteralExpression): string {
    return lit.typePrefix !== undefined && lit.typePrefix !== ""
      ? lit.typePrefix.toUpperCase()
      : lit.literalType;
  }

  /** A one-character literal passed to a CHAR or WCHAR input is that character. */
  private adaptCharArguments(
    inputs: CallInput[] | undefined,
    args: readonly Argument[],
  ): void {
    if (!inputs) return;
    stripEnEno([...args]).forEach((arg, i) => {
      if (arg.isOutput) return;
      const argName = arg.name?.toUpperCase();
      const input =
        argName === undefined
          ? inputs[i]
          : inputs.find((p) => p.name.toUpperCase() === argName);
      if (!input || input.inOut || input.type.arrayDimensions !== undefined) {
        return;
      }
      const refKind = input.type.referenceKind;
      if (refKind !== undefined && refKind !== "none") return;
      const charType = this.charTypeOfName(input.type.name);
      if (charType === undefined) return;
      this.adaptCharLiteral(arg.value, charType);
      const value = arg.value;
      // A member inherited from a base FB is not typed on the expression.
      const inherited =
        value.resolvedType === undefined &&
        value.kind === "VariableExpression" &&
        !this.hasMemberAccess(value)
          ? this.inheritedMemberType(value.name)
          : undefined;
      const valueType =
        inherited !== undefined &&
        inherited.arrayDimensions === undefined &&
        (inherited.referenceKind ?? "none") === "none"
          ? this.resolveNamedType(inherited.name)
          : value.resolvedType;
      if (
        valueType === undefined ||
        isGenericGroupType(valueType) ||
        this.charTypeOf(valueType) === charType
      ) {
        return;
      }
      this.addError(
        `Cannot assign ${typeNameUtil(valueType)} to parameter '${input.name}' of type ${input.type.name.toUpperCase()}`,
        arg.value.sourceSpan.startLine,
        arg.value.sourceSpan.startCol,
        arg.value.sourceSpan.file,
      );
    });
  }

  /**
   * The CHAR or WCHAR a standard SEL, MUX, LIMIT, MAX or MIN call yields when
   * its compared or selected arguments are all of that type.
   */
  private charSelectionType(
    expr: FunctionCallExpression,
  ): "CHAR" | "WCHAR" | undefined {
    const name = expr.functionName.toUpperCase();
    if (!CHAR_SELECTION_FUNCTIONS.has(name) || !this.isStdCharFunction(name)) {
      return undefined;
    }
    const args = stripEnEno(expr.arguments).slice(
      CHAR_COMPARE_FUNCTIONS.get(name) ?? 0,
    );
    const first = this.charTypeOf(args[0]?.value.resolvedType);
    if (first === undefined) return undefined;
    return args.every((a) => this.charTypeOf(a.value.resolvedType) === first)
      ? first
      : undefined;
  }

  /** True when `name` is the standard function, not a user or library one. */
  private isStdCharFunction(name: string): boolean {
    if (this.findUserFunction(name)) return false;
    const fn = this.symbolTables.lookupFunction(name);
    return fn === undefined || fn.libraryName === STD_FUNCTIONS_LIBRARY;
  }

  /** CHAR or WCHAR when the type is one of them, through aliases. */
  private charTypeOf(type: IECType | undefined): "CHAR" | "WCHAR" | undefined {
    if (type?.typeKind !== "elementary") return undefined;
    const base = this.aliasBase((type as ElementaryType).name);
    return base === "CHAR" || base === "WCHAR" ? base : undefined;
  }

  /**
   * A one-character string literal where a CHAR (`'A'`) or WCHAR (`"A"`) is
   * expected is that character (Ed. 3 Table 6). True when it was adapted.
   */
  private adaptCharLiteral(
    expr: Expression,
    charType: "CHAR" | "WCHAR" | undefined,
  ): boolean {
    if (charType === undefined) return false;
    if (expr.kind === "ParenthesizedExpression") {
      if (!this.adaptCharLiteral(expr.expression, charType)) return false;
      expr.resolvedType = ELEMENTARY_TYPES[charType]!;
      return true;
    }
    if (expr.kind === "FunctionCallExpression") {
      const name = expr.functionName.toUpperCase();
      if (!CHAR_SELECTION_FUNCTIONS.has(name)) return false;
      if (!this.isStdCharFunction(name)) return false;
      const args = stripEnEno(expr.arguments).slice(
        CHAR_COMPARE_FUNCTIONS.get(name) ?? 0,
      );
      for (const a of args) this.adaptCharLiteral(a.value, charType);
      if (this.charSelectionType(expr) !== charType) {
        this.checkCharStdArguments(expr);
        return false;
      }
      expr.resolvedType = ELEMENTARY_TYPES[charType]!;
      return true;
    }
    if (expr.kind !== "LiteralExpression") return false;
    const lit = expr;
    const want = charType === "CHAR" ? "STRING" : "WSTRING";
    if (lit.literalType !== want || (lit.typePrefix ?? "") !== "") return false;
    const raw = `${charType}#${lit.rawValue}`;
    if (charLiteralUnits(raw).units.length !== 1) return false;
    lit.literalType = charType;
    lit.rawValue = raw;
    lit.value = raw;
    lit.resolvedType = ELEMENTARY_TYPES[charType]!;
    return true;
  }

  /** A STRING or WSTRING (not an ARRAY of them) takes exactly one index. */
  private refuseStringIndexCount(
    typeName: string,
    indexCount: number,
    expr: VariableExpression,
  ): void {
    if (indexCount === 1 || !this.ast) return;
    if (resolveArrayElementType(typeName, this.ast) !== undefined) return;
    const base = this.aliasBase(typeName);
    if (base !== "STRING" && base !== "WSTRING") return;
    this.addError(
      `A ${base} takes one index (a character position), not ${indexCount}`,
      expr.sourceSpan.startLine,
      expr.sourceSpan.startCol,
      expr.sourceSpan.file,
    );
  }

  /** CHAR or WCHAR for one index into a STRING or WSTRING (Ed. 3 `s[i]`). */
  private stringElementType(
    typeName: string,
    indexCount: number,
  ): string | undefined {
    if (indexCount !== 1) return undefined;
    const base = this.aliasBase(typeName);
    return base === "STRING"
      ? "CHAR"
      : base === "WSTRING"
        ? "WCHAR"
        : undefined;
  }

  /**
   * `F(o => v)` or `F(a, v)` binding F's VAR_OUTPUT `o` to the variable `v`:
   * checked as the assignment `v := o`, and copied out through a temporary of
   * the output's type where the two C++ types differ (USINT into INT, or an
   * alias variable, which is not stored as its base type).
   */
  private checkOutputBindings(
    expr: FunctionCallExpression,
    scope: Scope,
  ): void {
    if (this.strict) this.checkStrictFbOutputs(expr, scope);
    if (expr.instance || expr.functionName.includes(".")) return;
    if (this.calledInstance(expr.functionName, scope)) return;
    const params = this.calledFunctionParameters(expr.functionName);
    if (params === undefined || !params.some((p) => p.output)) return;
    const claimed = new Set(
      expr.arguments.flatMap((a) =>
        a.name === undefined ? [] : [a.name.toUpperCase()],
      ),
    );
    const free = params.filter((p) => !claimed.has(p.name.toUpperCase()));
    let positional = 0;
    for (const arg of expr.arguments) {
      const param =
        arg.name === undefined
          ? free[positional++]
          : params.find(
              (p) => p.name.toUpperCase() === arg.name!.toUpperCase(),
            );
      if (param?.output !== true) continue;
      if (arg.name !== undefined && !arg.isOutput) continue;
      this.checkOutputBinding(param.type, arg, scope);
    }
  }

  /** VAR_INPUT, VAR_IN_OUT and VAR_OUTPUT of a user or library FUNCTION, in order. */
  private calledFunctionParameters(
    name: string,
  ): Array<{ name: string; type: AccessType; output: boolean }> | undefined {
    // A bare call of a method of this FB, its bases or this PROGRAM reaches
    // the method, not a FUNCTION of its name.
    const userFn = this.ownMethod(name) ?? this.findUserFunction(name);
    if (userFn) {
      return userFn.varBlocks
        .filter(
          (b) =>
            b.blockType === "VAR_INPUT" ||
            b.blockType === "VAR_IN_OUT" ||
            b.blockType === "VAR_OUTPUT",
        )
        .flatMap((b) =>
          b.declarations.flatMap((d) =>
            d.names.map((n) => ({
              name: n,
              type: d.type as AccessType,
              output: b.blockType === "VAR_OUTPUT",
            })),
          ),
        );
    }
    const fn = this.symbolTables.lookupFunction(name);
    if (fn === undefined || fn.libraryName === STD_FUNCTIONS_LIBRARY) {
      return undefined;
    }
    const params: Array<{ name: string; type: AccessType; output: boolean }> =
      [];
    for (const p of fn.parameters) {
      const type = (p.declaration as VarDeclaration | undefined)?.type;
      if (type === undefined) return undefined;
      params.push({
        name: p.name,
        type,
        output: p.isOutput && !p.isInput && !p.isInOut,
      });
    }
    return params;
  }

  /** One output binding (see checkOutputBindings). */
  private checkOutputBinding(
    param: AccessType,
    arg: Argument,
    scope: Scope,
  ): void {
    const value = arg.value;
    if (value.kind !== "VariableExpression") return;
    if (
      param.arrayDimensions !== undefined ||
      (param.referenceKind !== undefined && param.referenceKind !== "none")
    ) {
      return;
    }
    const sym = scope.lookup(value.name);
    if (sym?.kind === "constant") {
      this.addError(
        `Cannot assign to CONSTANT variable '${value.name}'`,
        value.sourceSpan.startLine,
        value.sourceSpan.startCol,
        value.sourceSpan.file,
      );
      return;
    }
    // A bit, a dereference or a REFERENCE TO cannot bind the output's reference.
    const steps =
      value.accessChain?.map((st) => (st.kind === "field" ? st.name : "")) ??
      value.fieldAccess;
    const indirect =
      /^\d+$/.test(steps[steps.length - 1] ?? "") ||
      value.isDereference ||
      value.accessChain?.some((st) => st.kind === "dereference") === true ||
      (sym?.kind === "variable" &&
        !this.hasMemberAccess(value) &&
        (sym.declaration as VarDeclaration | undefined)?.type.referenceKind ===
          "reference_to");
    const bound = indirect ? undefined : this.boundAccessType(value, scope);
    const boundName = bound?.name;
    const paramType = this.resolveNamedType(param.name);
    const boundType =
      boundName === undefined
        ? value.resolvedType
        : this.resolveNamedType(boundName);
    if (indirect) arg.inOutCopy = true;
    if (boundType === undefined) return;
    this.validateAssignment(boundType, paramType, value, {
      kind: "VariableExpression",
      sourceSpan: value.sourceSpan,
      name: param.name,
      fieldAccess: [],
      subscripts: [],
      isDereference: false,
      resolvedType: paramType,
    });
    if (bound === undefined || boundName === undefined) return;
    const paramKey = this.storageKey(param.name);
    const boundKey = this.storageKey(boundName);
    if (
      (paramKey !== undefined &&
        boundKey !== undefined &&
        paramKey !== boundKey) ||
      this.defaultStringIntoSized(param, bound)
    ) {
      arg.inOutCopy = true;
    }
  }

  /** A STRING or WSTRING output of the default length bound to one declared with a length. */
  private defaultStringIntoSized(
    param: AccessType,
    bound: AccessType,
  ): boolean {
    const p = this.aliasBase(param.name);
    if ((p !== "STRING" && p !== "WSTRING") || param.maxLength !== undefined) {
      return false;
    }
    return (
      this.aliasBase(bound.name) === p &&
      bound.maxLength !== undefined &&
      String(bound.maxLength) !== "254"
    );
  }

  /** The declared type of a bound variable, a member or THIS.x one. */
  private boundAccessType(
    value: VariableExpression,
    scope: Scope,
  ): AccessType | undefined {
    const root = value.name.toUpperCase();
    if (root === "THIS" || root === "SUPER") {
      const field = value.fieldAccess[0];
      if (
        this.currentFBName === undefined ||
        value.fieldAccess.length !== 1 ||
        field === undefined ||
        value.subscripts.length > 0 ||
        value.accessChain?.some((s) => s.kind !== "field") === true
      ) {
        return undefined;
      }
      const owner =
        root === "THIS"
          ? this.currentFBName
          : this.ast?.functionBlocks.find(
              (f) => f.name.toUpperCase() === this.currentFBName!.toUpperCase(),
            )?.extends;
      const name =
        owner === undefined
          ? undefined
          : this.resolveFieldTypeAnywhere(this.aliasBase(owner), field);
      return name === undefined ? undefined : { name, referenceKind: "none" };
    }
    const sym = scope.lookup(value.name);
    if (sym?.kind !== "variable") return undefined;
    const declared = sym.declaration as VarDeclaration | undefined;
    if (!declared) return undefined;
    const type = this.hasMemberAccess(value)
      ? resolveAccessType(declared.type, value, this.accessLookup)
      : declared.type;
    if (
      type === undefined ||
      type.arrayDimensions !== undefined ||
      (type.referenceKind !== undefined && type.referenceKind !== "none")
    ) {
      return undefined;
    }
    return type;
  }

  /**
   * The C++ storage of an elementary type, or undefined for any other (a
   * STRING keeps its own copy rule): an alias is stored as its base's raw
   * value, not as the base's IEC variable type.
   */
  private storageKey(name: string): string | undefined {
    const base = this.aliasBase(name);
    if (ELEMENTARY_TYPES[base] === undefined) {
      // A type a library declares (`TYPE LU : USINT` of a -L library): its
      // manifest gives no base, so it is its own storage.
      const resolved = this.symbolTables.lookupType(base)?.resolvedType;
      return resolved?.typeKind === "elementary" ? `lib:${base}` : undefined;
    }
    if (base === "STRING" || base === "WSTRING") return undefined;
    const storage = INTEGER_STORAGE[base] ?? TEMPORAL_STORAGE[base] ?? base;
    return `${base === name.toUpperCase() ? "iec" : "raw"}:${storage}`;
  }

  private aliasBase(name: string): string {
    let upper = name.toUpperCase();
    for (let i = 0; i < 32; i++) {
      const current = upper;
      const def = this.ast?.types.find(
        (td) => td.name.toUpperCase() === current,
      )?.definition;
      if (
        def?.kind !== "TypeReference" ||
        def.arrayDimensions !== undefined ||
        (def.referenceKind !== undefined && def.referenceKind !== "none")
      ) {
        return upper;
      }
      upper = def.name.toUpperCase();
    }
    return upper;
  }

  /**
   * An alias-typed variable is not stored as its base type, so compile cannot
   * bind a REFERENCE TO to it yet: mark it for compile to refuse (analysis accepts).
   */
  private markAliasReferenceBinding(
    target: { chain: string[]; base: string },
    source: { chain: string[]; base: string },
    value: VariableExpression,
  ): void {
    if (source.chain.length !== 0) return;
    const alias = source.base.toUpperCase();
    if (this.aliasBase(alias) === alias) return;
    value.aliasReferenceBinding = `binding a ${describeReferenceShape(target)} to a variable of alias type '${alias}' is not supported yet`;
  }

  /** Why a variable of declared type `name` cannot back a REFERENCE TO of another name. */
  private referenceMismatchReason(name: string): string {
    const upper = name.toUpperCase();
    const def = this.ast?.types.find(
      (td) => td.name.toUpperCase() === upper,
    )?.definition;
    if (def?.kind === "SubrangeDefinition") {
      return ": writes through the reference would not be checked against the subrange";
    }
    return "";
  }

  /** A type a REFERENCE TO argument check can compare: known, or a TYPE declared here. */
  private isReferableType(name: string): boolean {
    if (this.isExactlyKnownType(name)) return true;
    const upper = name.toUpperCase();
    return (
      this.ast?.types.some((td) => td.name.toUpperCase() === upper) ?? false
    );
  }

  /** Arguments bound to an interface-typed input are checked like an assignment. */
  private validateInterfaceArguments(
    inputs: CallInput[] | undefined,
    args: readonly Argument[],
  ): void {
    if (!inputs) return;
    stripEnEno([...args]).forEach((arg, i) => {
      if (arg.isOutput) return;
      const argName = arg.name?.toUpperCase();
      const input =
        argName === undefined
          ? inputs[i]
          : inputs.find((p) => p.name.toUpperCase() === argName);
      if (!input || input.inOut || !this.isInterfaceDeclType(input.type)) {
        return;
      }
      this.checkInterfaceValue(
        input.type.name,
        arg.value.resolvedType,
        arg.value,
      );
    });
  }

  /**
   * Check if an expression is an untyped numeric literal (no explicit type prefix).
   * These are polymorphic and can be assigned to any compatible numeric type.
   */
  private isUntypedNumericLiteral(expr: Expression): boolean {
    if (expr.kind !== "LiteralExpression") return false;
    // If there's an explicit type prefix (e.g., DINT#42), it's not polymorphic
    if (expr.typePrefix) return false;
    return (
      expr.literalType === "INT" ||
      expr.literalType === "REAL" ||
      expr.literalType === "BOOL"
    );
  }

  /**
   * A REF_TO T holds only a reference to a T (IEC 61131-3), so the declared
   * reference levels and target type must match exactly.
   *
   * Only a REF_TO target is checked, and only when both sides are fully known:
   * POINTER TO keeps its CODESYS cross-type assignment, REFERENCE TO assigns
   * through the reference, and an alias or unknown type is left to the
   * general check.
   */
  private validateReferenceAssignment(
    target: Expression,
    value: Expression,
    scope: Scope,
  ): void {
    const t = this.declaredReferenceShape(target, scope);
    if (t) this.validateReferenceValue(t, value, scope);
  }

  /**
   * `p := ADR(x)`: an address (__XWORD) into a POINTER TO of any target type.
   * The checker types `p` as its target type, which a STRUCT, UNION or FB
   * target would refuse; an elementary one already accepts __XWORD.
   */
  private isAddressIntoPointer(
    target: Expression,
    valueType: IECType | undefined,
    scope: Scope,
  ): boolean {
    if (valueType?.typeKind !== "elementary") return false;
    if ((valueType as ElementaryType).name.toUpperCase() !== "__XWORD") {
      return false;
    }
    return (
      this.declaredReferenceShape(target, scope)?.chain[0] === "pointer_to"
    );
  }

  /** Whether `expr` denotes a POINTER TO or REF_TO variable, not its target. */
  private isReferenceItself(expr: Expression, scope: Scope): boolean {
    if (expr.kind !== "VariableExpression") return false;
    const outer = this.declaredReferenceShape(expr, scope)?.chain[0];
    return outer === "pointer_to" || outer === "ref_to";
  }

  /** Mark an untyped `0` bound to a POINTER TO input as NULL. */
  private markPointerZeroArguments(
    inputs: CallInput[] | undefined,
    args: readonly Argument[],
  ): void {
    if (!inputs) return;
    stripEnEno([...args]).forEach((arg, i) => {
      if (arg.isOutput) return;
      const argName = arg.name?.toUpperCase();
      const input =
        argName === undefined
          ? inputs[i]
          : inputs.find((p) => p.name.toUpperCase() === argName);
      if (!input || input.inOut) return;
      if (referenceShapeOf(input.type)?.chain[0] !== "pointer_to") return;
      if (isUntypedZero(arg.value)) arg.value.asNull = true;
    });
  }

  /**
   * `p := 0`: the untyped literal 0 stored in a POINTER TO of any target type
   * is NULL, as it already is for an elementary target.
   */
  private isZeroIntoPointer(
    target: Expression,
    value: Expression,
    scope: Scope,
  ): boolean {
    if (!isUntypedZero(value)) return false;
    if (this.declaredReferenceShape(target, scope)?.chain[0] !== "pointer_to") {
      return false;
    }
    value.asNull = true;
    return true;
  }

  /** Report `value` when it cannot be held by a target of shape `t`. */
  private validateReferenceValue(
    declaredTarget: ReferenceShape,
    value: Expression,
    scope: Scope,
  ): void {
    let t = declaredTarget;
    if (t.chain[0] !== "ref_to") return;
    const declaredValue = this.declaredReferenceShape(value, scope);
    if (!declaredValue || declaredValue.chain.length === 0) return;
    // An alias of a STRING(n) is that STRING(n).
    t = this.stringAliasResolved(t);
    const v = this.stringAliasResolved(declaredValue);
    if (!this.isExactlyKnownType(t.base) || !this.isExactlyKnownType(v.base)) {
      return;
    }
    const sameLevels =
      t.chain.length === v.chain.length &&
      t.chain.every((kind, i) => kind === v.chain[i]);
    const sameBase =
      canonicalElementaryName(t.base.toUpperCase()) ===
      canonicalElementaryName(v.base.toUpperCase());
    if (sameLevels && sameBase && !stringLengthsDiffer(t, v)) return;
    this.addError(
      `Cannot assign ${describeReferenceShape(v)} to ${describeReferenceShape(t)}: a REF_TO can only hold a reference to its declared type`,
      value.sourceSpan.startLine,
      value.sourceSpan.startCol,
      value.sourceSpan.file,
    );
  }

  /**
   * The declared reference levels and target type of a plain variable, or of
   * `REF(variable)`, which adds a REF_TO level. Undefined for anything else.
   */
  private declaredReferenceShape(
    expr: Expression,
    scope: Scope,
  ): ReferenceShape | undefined {
    if (expr.kind === "RefExpression") {
      const inner = this.declaredReferenceShape(expr.operand, scope);
      return inner
        ? { ...inner, chain: ["ref_to", ...inner.chain] }
        : undefined;
    }
    if (expr.kind === "FunctionCallExpression") {
      const fn = this.findUserFunction(expr.functionName);
      return fn ? referenceShapeOf(fn.returnType) : undefined;
    }
    if (expr.kind !== "VariableExpression") return undefined;
    const sym = scope.lookup(expr.name);
    if (!sym || (sym.kind !== "variable" && sym.kind !== "constant")) {
      return undefined;
    }
    // A member (`s.r`) is shaped by its own declaration.
    // Some symbols (a method's return variable) carry no declaration.
    const declared = sym.declaration as VarDeclaration | undefined;
    if (!declared) return undefined;
    const type = this.hasMemberAccess(expr)
      ? resolveAccessType(declared.type, expr, this.accessLookup)
      : declared.type;
    const shape = type ? referenceShapeOf(type) : undefined;
    // An element of an array declared here (`a[i]`) has its string length;
    // one reached through any other path may not carry it.
    if (
      shape &&
      this.hasSubscript(expr) &&
      !this.isDirectElementOfDeclaredArray(expr, declared.type)
    ) {
      shape.lengthUnknown = true;
    }
    return shape;
  }

  /**
   * `a[i]`: one subscript straight on a variable of an inline ARRAY or an
   * ARRAY type declared in this compile, whose element carries its length.
   */
  private isDirectElementOfDeclaredArray(
    expr: VariableExpression,
    type: TypeReference,
  ): boolean {
    const steps = expr.accessChain ?? [
      ...(expr.subscripts.length > 0
        ? [{ kind: "subscript" as const, indices: expr.subscripts }]
        : []),
      ...expr.fieldAccess.map((name) => ({ kind: "field" as const, name })),
    ];
    if (steps.length !== 1 || steps[0]!.kind !== "subscript") return false;
    if (type.referenceKind !== undefined && type.referenceKind !== "none") {
      return false;
    }
    if (type.arrayDimensions !== undefined) return true;
    const upper = type.name.toUpperCase();
    return (
      this.ast?.types.some(
        (t) =>
          t.name.toUpperCase() === upper &&
          t.definition.kind === "ArrayDefinition",
      ) === true
    );
  }

  /** Whether an access path indexes an array anywhere. */
  private hasSubscript(expr: VariableExpression): boolean {
    return (
      expr.subscripts.length > 0 ||
      (expr.accessChain?.some((step) => step.kind === "subscript") ?? false)
    );
  }

  private findUserFunction(name: string): FunctionDeclaration | undefined {
    const upper = name.toUpperCase();
    return this.ast?.functions.find((f) => f.name.toUpperCase() === upper);
  }

  /**
   * The inputs of a user function or FB instance call, in declaration order,
   * with an FB's inherited inputs first. Undefined when the callee is unknown.
   */
  private callInputs(
    expr: FunctionCallExpression,
    scope: Scope,
  ): CallInput[] | undefined {
    const fromBlocks = (blocks: readonly VarBlock[]): CallInput[] =>
      blocks
        .filter(
          (b) => b.blockType === "VAR_INPUT" || b.blockType === "VAR_IN_OUT",
        )
        .flatMap((b) =>
          b.declarations.flatMap((d) =>
            d.names.map((name) => ({
              name,
              type: d.type,
              inOut: b.blockType === "VAR_IN_OUT",
            })),
          ),
        );
    const ownMethod = this.ownMethod(expr.functionName);
    if (ownMethod) return fromBlocks(ownMethod.varBlocks);
    const fn = this.calledInstance(expr.functionName, scope)
      ? undefined
      : this.findUserFunction(expr.functionName);
    if (fn) return fromBlocks(fn.varBlocks);
    const libraryInputs = this.libraryReferenceFunctionInputs(expr, scope);
    if (libraryInputs) return libraryInputs;
    const sym = scope.lookup(expr.functionName);
    if (sym?.kind !== "variable" || expr.instance) return undefined;
    const declared = sym.declaration as VarDeclaration | undefined;
    if (!declared) return undefined;
    return this.fbInputsOf(declared.type.name);
  }

  /**
   * `--strict`: an FB call's `o => v` follows the strict conversion rules of
   * `v := o`, as a FUNCTION's output does (checkOutputBindings).
   */
  private checkStrictFbOutputs(
    expr: FunctionCallExpression,
    scope: Scope,
  ): void {
    if (!expr.arguments.some((a) => a.isOutput)) return;
    const fbType = this.calledFbType(expr, scope);
    if (fbType === undefined) return;
    const outputs = this.fbOutputsOf(fbType);
    for (const arg of expr.arguments) {
      if (!arg.isOutput || arg.name === undefined) continue;
      if (arg.value.kind !== "VariableExpression") continue;
      const upper = arg.name.toUpperCase();
      if (upper === "ENO") continue;
      const out = outputs.find((o) => o.name.toUpperCase() === upper);
      if (
        out === undefined ||
        out.arrayDimensions !== undefined ||
        (out.referenceKind ?? "none") !== "none"
      ) {
        continue;
      }
      const bound = this.boundAccessType(arg.value, scope);
      const boundType =
        bound === undefined
          ? arg.value.resolvedType
          : this.resolveNamedType(bound.name);
      if (boundType === undefined) continue;
      const outType = this.resolveNamedType(out.typeName);
      this.checkStrictConversion(boundType, {
        kind: "VariableExpression",
        sourceSpan: arg.value.sourceSpan,
        name: out.name,
        fieldAccess: [],
        subscripts: [],
        isDereference: false,
        resolvedType: outType,
      });
    }
  }

  /** The FB type an instance call invokes: `fb(...)`, `arr[i](...)`, `s.f(...)`. */
  private calledFbType(
    expr: FunctionCallExpression,
    scope: Scope,
  ): string | undefined {
    if (expr.instance !== undefined) {
      const t = this.resolveExprType(expr.instance, scope);
      return t?.typeKind === "elementary"
        ? (t as ElementaryType).name
        : undefined;
    }
    const parts = expr.functionName.split(".");
    if (parts.length === 1) {
      if (!this.calledInstance(expr.functionName, scope)) return undefined;
      const sym = scope.lookup(expr.functionName);
      return sym?.kind === "variable"
        ? (sym.declaration as VarDeclaration | undefined)?.type.name
        : this.inheritedMemberType(expr.functionName)?.name;
    }
    if (parts.length !== 2) return undefined;
    const owner = this.callOwnerType(parts[0]!, scope);
    return owner === undefined
      ? undefined
      : this.resolveFieldTypeAnywhere(this.aliasBase(owner), parts[1]!);
  }

  /** The VAR_OUTPUTs of a function block type and its bases, a library's too. */
  private fbOutputsOf(fbTypeName: string): Array<{
    name: string;
    typeName: string;
    arrayDimensions?: unknown;
    referenceKind?: string;
  }> {
    const upper = this.aliasBase(fbTypeName).toUpperCase();
    const out: Array<{
      name: string;
      typeName: string;
      arrayDimensions?: unknown;
      referenceKind?: string;
    }> = [];
    let current: string | undefined = upper;
    for (let depth = 0; current !== undefined && depth < 32; depth++) {
      const name: string = current;
      const fb = this.ast?.functionBlocks.find(
        (f) => f.name.toUpperCase() === name,
      );
      if (!fb) {
        const lib = this.symbolTables.lookupFunctionBlock(name);
        for (const m of lib?.outputs ?? []) {
          const t = m.declaration.type;
          out.push({
            name: m.name,
            typeName: t.name,
            arrayDimensions: t.arrayDimensions,
            referenceKind: t.referenceKind,
          });
        }
        break;
      }
      for (const b of fb.varBlocks) {
        if (b.blockType !== "VAR_OUTPUT") continue;
        for (const d of b.declarations) {
          for (const n of d.names) {
            out.push({
              name: n,
              typeName: d.type.name,
              arrayDimensions: d.type.arrayDimensions,
              referenceKind: d.type.referenceKind,
            });
          }
        }
      }
      current = fb.extends?.toUpperCase();
    }
    return out;
  }

  /** The VAR_INPUT and VAR_IN_OUT of a function block type, its bases' first; a library's too. */
  private fbInputsOf(fbTypeName: string): CallInput[] | undefined {
    const fromBlocks = (blocks: readonly VarBlock[]): CallInput[] =>
      blocks
        .filter(
          (b) => b.blockType === "VAR_INPUT" || b.blockType === "VAR_IN_OUT",
        )
        .flatMap((b) =>
          b.declarations.flatMap((d) =>
            d.names.map((name) => ({
              name,
              type: d.type,
              inOut: b.blockType === "VAR_IN_OUT",
            })),
          ),
        );
    const typeName = this.aliasBase(fbTypeName).toUpperCase();
    const chain: FunctionBlockDeclaration[] = [];
    let current: string | undefined = typeName;
    while (current !== undefined && chain.length < 32) {
      const upper: string = current;
      const fb = this.ast?.functionBlocks.find(
        (f) => f.name.toUpperCase() === upper,
      );
      if (!fb) break;
      chain.unshift(fb);
      current = fb.extends?.toUpperCase();
    }
    if (chain.length > 0)
      return chain.flatMap((fb) => fromBlocks(fb.varBlocks));
    const libraryFb = this.symbolTables.lookupFunctionBlock(typeName);
    if (!libraryFb) return undefined;
    return [
      ...libraryFb.inputs.map((m) => ({ m, inOut: false })),
      ...libraryFb.inouts.map((m) => ({ m, inOut: true })),
    ].map(({ m, inOut }) => ({
      name: m.name,
      type: m.declaration.type,
      inOut,
    }));
  }

  /**
   * The inputs and in/outs of a library FUNCTION that has a REFERENCE TO
   * input (an archive that records it), so its arguments are checked as a
   * user function's are. Undefined for any other callee.
   */
  private libraryReferenceFunctionInputs(
    expr: FunctionCallExpression,
    scope: Scope,
  ): CallInput[] | undefined {
    const name = expr.functionName;
    if (expr.instance || name.includes(".")) return undefined;
    if (this.calledInstance(name, scope) || this.ownMethod(name)) {
      return undefined;
    }
    const fn = this.symbolTables.lookupFunction(name);
    if (fn === undefined || this.findUserFunction(name)) return undefined;
    const params = fn.parameters.filter((p) => p.isInput || p.isInOut);
    if (
      !params.some(
        (p) =>
          (p.declaration as VarDeclaration | undefined)?.type.referenceKind ===
          "reference_to",
      )
    ) {
      return undefined;
    }
    return params.flatMap((p) => {
      const type = (p.declaration as VarDeclaration | undefined)?.type;
      return type ? [{ name: p.name, type, inOut: p.isInOut }] : [];
    });
  }

  /** The REF_TO check for each argument passed to a REF_TO input. */
  private validateReferenceArguments(
    expr: FunctionCallExpression,
    scope: Scope,
  ): void {
    const inputs = this.callInputs(expr, scope);
    if (!inputs) return;
    stripEnEno(expr.arguments).forEach((arg, i) => {
      if (arg.isOutput) return;
      const argName = arg.name?.toUpperCase();
      const input =
        argName === undefined
          ? inputs[i]
          : inputs.find((p) => p.name.toUpperCase() === argName);
      if (!input) return;
      const shape = referenceShapeOf(input.type);
      if (shape) this.validateReferenceValue(shape, arg.value, scope);
    });
  }

  /**
   * One member of a struct, FB or program: from this compile's AST, or from a
   * library function block, whose members the symbol tables carry.
   */
  private readonly accessLookup: AccessLookup = {
    field: (typeName, fieldName) => this.lookupMember(typeName, fieldName),
    arrayElement: (typeName) =>
      this.ast ? resolveArrayElementAccessType(typeName, this.ast) : undefined,
  };

  private readonly lookupMember = (
    typeName: string,
    fieldName: string,
  ): VarDeclaration | undefined => {
    const local = this.ast
      ? resolveFieldDeclaration(typeName, fieldName, this.ast)
      : undefined;
    if (local) return local;
    const fb = this.symbolTables.lookupFunctionBlock(typeName);
    if (!fb) return undefined;
    const upper = fieldName.toUpperCase();
    return [...fb.inputs, ...fb.outputs, ...fb.inouts, ...fb.locals].find(
      (m) => m.name.toUpperCase() === upper,
    )?.declaration;
  };

  /** `THIS.member` (or `THIS^.member`) inside a function block. */
  private isSelfMember(expr: VariableExpression): boolean {
    return (
      expr.name.toUpperCase() === "THIS" &&
      expr.fieldAccess.length > 0 &&
      this.currentFBName !== undefined
    );
  }

  /** The expression reaches into a member: `s.r`, `a[1]`, `p^`. */
  private hasMemberAccess(expr: VariableExpression): boolean {
    return (
      expr.subscripts.length > 0 ||
      expr.fieldAccess.length > 0 ||
      expr.isDereference ||
      (expr.accessChain !== undefined && expr.accessChain.length > 0)
    );
  }

  /** An elementary type, or a struct, FB or enum this compile declares. */
  private isExactlyKnownType(name: string): boolean {
    if (ELEMENTARY_TYPES[canonicalElementaryName(name.toUpperCase())]) {
      return true;
    }
    if (this.isKnownCompositeType(name)) return true;
    const upper = name.toUpperCase();
    return (
      this.ast?.types.some(
        (td) =>
          td.name.toUpperCase() === upper &&
          td.definition.kind === "EnumDefinition",
      ) ?? false
    );
  }

  /**
   * Check if a type name refers to a known function block or struct type.
   */
  private isKnownCompositeType(name: string): boolean {
    if (!this.ast) return false;
    const upper = name.toUpperCase();
    if (this.ast.functionBlocks.some((fb) => fb.name.toUpperCase() === upper)) {
      return true;
    }
    if (
      this.ast.types.some(
        (td) =>
          td.name.toUpperCase() === upper &&
          td.definition.kind === "StructDefinition",
      )
    ) {
      return true;
    }
    // Also check library FBs via symbol tables
    if (this.symbolTables.lookupFunctionBlock(name)) {
      return true;
    }
    return false;
  }

  private validateCondition(
    condType: IECType | undefined,
    condExpr: Expression,
  ): void {
    if (!condType) return;

    // Conditions must be ANY_BIT (BOOL, BYTE, WORD, etc.)
    if (!_isTypeInCategory(condType, "ANY_BIT")) {
      this.addError(
        `Condition must be a boolean or bit type, got ${typeNameUtil(condType)}`,
        condExpr.sourceSpan.startLine,
        condExpr.sourceSpan.startCol,
        condExpr.sourceSpan.file,
      );
    }
  }

  /** Calls written as statements (their value, if any, is discarded). */
  private statementCalls = new WeakSet<FunctionCallExpression>();
  /** Calls already checked by refuseInstanceCallValue. */
  private checkedInstanceCallValues = new WeakSet<FunctionCallExpression>();

  /**
   * `x := fb(...)`: a FUNCTION_BLOCK instance call used as a value, which it
   * has none of (also where a FUNCTION of its name exists, which the
   * instance hides).
   */
  private refuseInstanceCallValue(
    expr: FunctionCallExpression,
    scope: Scope,
  ): void {
    if (this.statementCalls.has(expr)) return;
    if (this.checkedInstanceCallValues.has(expr)) return;
    this.checkedInstanceCallValues.add(expr);
    const sym = scope.lookup(expr.functionName);
    if (sym?.kind === "program") return;
    this.addError(
      `'${expr.functionName}' is a FUNCTION_BLOCK instance: its call has no value`,
      expr.sourceSpan.startLine,
      expr.sourceSpan.startCol,
      expr.sourceSpan.file,
    );
  }

  /** Calls already checked by checkBoundDimension. */
  private checkedBoundDimensions = new WeakSet<FunctionCallExpression>();

  /**
   * LOWER_BOUND / UPPER_BOUND (arr, dim) of a fixed array of two or three
   * dimensions with a literal `dim` it does not have. (A one-dimensional
   * array answers any dim, so it is left alone.)
   */
  private checkBoundDimension(
    expr: FunctionCallExpression,
    scope: Scope,
  ): void {
    const upper = expr.functionName.toUpperCase();
    if (upper !== "LOWER_BOUND" && upper !== "UPPER_BOUND") return;
    if (expr.instance || this.findUserFunction(upper)) return;
    if (this.checkedBoundDimensions.has(expr)) return;
    this.checkedBoundDimensions.add(expr);
    const [arr, dim] = stripEnEno([...expr.arguments]);
    if (arr?.value.kind !== "VariableExpression" || dim === undefined) return;
    if (
      dim.value.kind !== "LiteralExpression" ||
      typeof dim.value.value !== "number"
    ) {
      return;
    }
    const sym = scope.lookup(arr.value.name);
    if (sym?.kind !== "variable") return;
    const declared = (sym.declaration as VarDeclaration | undefined)?.type;
    if (declared === undefined) return;
    const type = this.hasMemberAccess(arr.value)
      ? resolveAccessType(declared, arr.value, this.accessLookup)
      : declared;
    if (type === undefined) return;
    let rank = type.arrayDimensions?.length;
    if (rank === undefined && (type.referenceKind ?? "none") === "none") {
      const named = type.name.toUpperCase();
      const def = this.ast?.types.find(
        (t) => t.name.toUpperCase() === named,
      )?.definition;
      if (def?.kind === "ArrayDefinition") rank = def.dimensions.length;
    }
    if (rank === undefined || rank < 2 || rank > 3) return;
    const value = dim.value.value;
    if (Number.isInteger(value) && value >= 1 && value <= rank) return;
    this.addError(
      `${upper} has no dimension ${String(value)}: the array has ${rank}`,
      dim.value.sourceSpan.startLine,
      dim.value.sourceSpan.startCol,
      dim.value.sourceSpan.file,
    );
  }

  /**
   * The result of the standard SEL or MUX when any selected input is an
   * enumeration: that enumeration when every one is of it (aliases are the
   * enumeration), else "refused" after an error. Undefined otherwise.
   */
  private selectionEnumResult(
    expr: FunctionCallExpression,
  ): IECType | "refused" | undefined {
    const upper = expr.functionName.toUpperCase();
    if (upper !== "SEL" && upper !== "MUX") return undefined;
    if (expr.instance || this.findUserFunction(upper)) return undefined;
    if (this.ownMethod(upper)) return undefined;
    if (this.unboundStdFunctionCalls.has(expr)) return undefined;
    const values = stripEnEno([...expr.arguments]).slice(1);
    const types = values.map((a) => a.value.resolvedType);
    const enumType = types.find((t) => t?.typeKind === "enum");
    if (enumType === undefined) return undefined;
    const name = typeNameUtil(enumType).toUpperCase();
    const at = types.findIndex(
      (t) =>
        t !== undefined &&
        (t.typeKind !== "enum" || typeNameUtil(t).toUpperCase() !== name),
    );
    const other = values[at];
    if (other === undefined) return enumType;
    this.addError(
      `The inputs of ${upper} must be of one type: got ${typeNameUtil(enumType)} and ${typeNameUtil(other.value.resolvedType!)}`,
      other.value.sourceSpan.startLine,
      other.value.sourceSpan.startCol,
      other.value.sourceSpan.file,
    );
    return "refused";
  }

  /** Indices already checked by refuseEnumIndex. */
  private checkedEnumIndices = new WeakSet<Expression>();

  /** An enumeration value as an array index: the C++ enum class is no index. */
  private refuseEnumIndex(index: Expression): void {
    if (this.checkedEnumIndices.has(index)) return;
    this.checkedEnumIndices.add(index);
    const type = index.resolvedType;
    if (type?.typeKind !== "enum") return;
    this.addError(
      `Array index must be an integer, got ${typeNameUtil(type)}`,
      index.sourceSpan.startLine,
      index.sourceSpan.startCol,
      index.sourceSpan.file,
    );
  }

  /**
   * A CASE label of another type than an enumeration selector, or an
   * enumeration label of an integer selector: never equal in the C++.
   */
  private validateCaseLabelType(
    selectorType: IECType | undefined,
    label: Expression,
  ): void {
    const labelType = label.resolvedType;
    if (selectorType === undefined || labelType === undefined) return;
    const selectorEnum = selectorType.typeKind === "enum";
    const labelEnum = labelType.typeKind === "enum";
    if (!selectorEnum && !labelEnum) return;
    if (
      selectorEnum &&
      labelEnum &&
      typeNameUtil(selectorType).toUpperCase() ===
        typeNameUtil(labelType).toUpperCase()
    ) {
      return;
    }
    const other = selectorEnum ? labelType : selectorType;
    if (other.typeKind !== "enum" && other.typeKind !== "elementary") return;
    this.addError(
      `CASE label of type ${typeNameUtil(labelType)} does not match the selector of type ${typeNameUtil(selectorType)}`,
      label.sourceSpan.startLine,
      label.sourceSpan.startCol,
      label.sourceSpan.file,
    );
  }

  private validateCaseSelector(
    selectorType: IECType,
    selectorExpr: Expression,
  ): void {
    // CASE selector must be ANY_INT, ANY_BIT, or enum (IEC 61131-3: ordinal types)
    if (
      !_isTypeInCategory(selectorType, "ANY_INT") &&
      !_isTypeInCategory(selectorType, "ANY_BIT") &&
      selectorType.typeKind !== "enum" &&
      this.charTypeOf(selectorType) === undefined
    ) {
      this.addError(
        `CASE selector must be an integer, bit, or enum type, got ${typeNameUtil(selectorType)}`,
        selectorExpr.sourceSpan.startLine,
        selectorExpr.sourceSpan.startCol,
        selectorExpr.sourceSpan.file,
      );
    }
  }

  /**
   * MAX, MIN and LIMIT order numbers, strings and times, not enumerations.
   * True when an enumeration argument was refused.
   */
  private refuseEnumOrderingArguments(
    expr: FunctionCallExpression,
    params: ReadonlyArray<{ name: string; constraint: string }>,
  ): boolean {
    const known = this.enumOrderingChecked.get(expr);
    if (known !== undefined) return known;
    let refused = false;
    stripEnEno(expr.arguments).forEach((arg, i) => {
      const param = params[i];
      const argType = arg.value.resolvedType;
      if (
        param?.constraint !== "ANY_ELEMENTARY" ||
        argType?.typeKind !== "enum"
      ) {
        return;
      }
      refused = true;
      this.addError(
        `Argument '${param.name}' of '${expr.functionName.toUpperCase()}' expects ${param.constraint}, got ${typeNameUtil(argType)}`,
        arg.value.sourceSpan.startLine,
        arg.value.sourceSpan.startCol,
        arg.value.sourceSpan.file,
      );
    });
    this.enumOrderingChecked.set(expr, refused);
    return refused;
  }

  private validateFunctionCallArgs(
    expr: FunctionCallExpression,
    _scope: Scope,
  ): void {
    if (!this.stdRegistry) return;

    const nameUpper = expr.functionName.toUpperCase();
    const desc =
      this.stdRegistry.lookup(nameUpper) ??
      this.stdRegistry.resolveTypedTrunc(nameUpper);
    if (!desc) return; // User-defined or unknown — skip constraint checking
    // Already refused: the arguments are in no parameter order.
    if (this.unboundStdFunctionCalls.has(expr)) return;
    this.refuseEnumOrderingArguments(expr, desc.params);

    // Validate argument types against parameter constraints. Strip EN/ENO
    // first — they're handled by the codegen wrapper and don't map onto the
    // declared signature, so leaving them in would shift positional indices
    // and the param at slot 0 would be type-checked against EN's BOOL.
    const userArgs = stripEnEno(expr.arguments);
    for (let i = 0; i < userArgs.length && i < desc.params.length; i++) {
      const arg = userArgs[i]!;
      const param = desc.params[i]!;
      const argType = arg.value.resolvedType;

      // A generic result left unrefined (ANY_ELEMENTARY) is not checked.
      if (
        !argType ||
        argType.typeKind !== "elementary" ||
        isGenericGroupType(argType)
      ) {
        continue;
      }

      // An alias (`TYPE TS : STRING(20)`) is checked as its base type.
      const argDisplay = (argType as ElementaryType).name;
      const argTypeName = this.aliasBase(argDisplay);

      // Check specific type constraint
      if (param.constraint === "specific" && param.specificType) {
        const specUpper = param.specificType.toUpperCase();
        if (argTypeName.toUpperCase() !== specUpper) {
          const specType = ELEMENTARY_TYPES[specUpper];
          // Allow implicit widening to the specific type
          if (specType && !_isAssignable(specType, argType)) {
            // Check if it's a narrowing (warning) vs truly incompatible (error)
            if (specType && isNarrowingConversion(specUpper, argTypeName)) {
              if (this.strict) {
                this.addStrictError(
                  strictConversionMessage(argTypeName, specUpper),
                  arg.value,
                );
                continue;
              }
              this.addWarning(
                `Argument '${param.name}' of '${nameUpper}' expects ${param.specificType}, got ${argDisplay} (narrowing)`,
                arg.value.sourceSpan.startLine,
                arg.value.sourceSpan.startCol,
                arg.value.sourceSpan.file,
              );
            } else {
              this.addError(
                `Argument '${param.name}' of '${nameUpper}' expects ${param.specificType}, got ${argDisplay}`,
                arg.value.sourceSpan.startLine,
                arg.value.sourceSpan.startCol,
                arg.value.sourceSpan.file,
              );
            }
          }
        }
      } else if (!matchesConstraint(argTypeName, param.constraint)) {
        // Allow implicit widening: INT→REAL for ANY_REAL constraints, etc.
        // Check if the argument type can be implicitly widened to a type in the constraint category
        const canWiden = this.canWidenToConstraint(
          argTypeName,
          param.constraint,
        );
        if (!canWiden) {
          this.addError(
            `Argument '${param.name}' of '${nameUpper}' expects ${param.constraint}, got ${argDisplay}`,
            arg.value.sourceSpan.startLine,
            arg.value.sourceSpan.startCol,
            arg.value.sourceSpan.file,
          );
        }
      }
    }
  }

  /**
   * Check if a type can be implicitly widened to match a constraint.
   * E.g., INT can match ANY_REAL because INT→REAL is a valid widening.
   */
  private canWidenToConstraint(
    typeName: string,
    constraint: import("./std-function-registry.js").TypeConstraint,
  ): boolean {
    const upper = typeName.toUpperCase();
    // ANY_REAL: integer types can be implicitly promoted to REAL
    if (constraint === "ANY_REAL") {
      const elemType: ElementaryType = ELEMENTARY_TYPES[upper] ?? {
        typeKind: "elementary" as const,
        name: upper,
        sizeBits: 0,
      };
      return _isTypeInCategory(elemType, "ANY_INT");
    }
    // ANY_NUM: bit types can be promoted to numeric
    if (constraint === "ANY_NUM") {
      const elemType: ElementaryType = ELEMENTARY_TYPES[upper] ?? {
        typeKind: "elementary" as const,
        name: upper,
        sizeBits: 0,
      };
      return _isTypeInCategory(elemType, "ANY_BIT");
    }
    // ANY_BIT: integer types can be used in bit operations (CODESYS compat)
    if (constraint === "ANY_BIT") {
      const elemType: ElementaryType = ELEMENTARY_TYPES[upper] ?? {
        typeKind: "elementary" as const,
        name: upper,
        sizeBits: 0,
      };
      return _isTypeInCategory(elemType, "ANY_INT");
    }
    return false;
  }

  // ===========================================================================
  // Strict mode (--strict)
  // ===========================================================================

  /** The function or method whose body is being checked (strict return values). */
  private currentReturn: { name: string; type: TypeReference } | undefined;

  /** The FUNCTION_BLOCK whose body, method or property is being checked (`THIS.member`). */
  private currentFBName: string | undefined;
  /** CHAR initial values already refused (a declaration is visited more than once). */
  private reportedCharValues = new Set<Expression>();
  /** The default values declared on types (`TYPE T : ... := value`). */
  private typeDefaults: ReadonlySet<Expression> = new Set();
  /** The property whose GET or SET body is being checked, upper-cased. */
  private currentPropertyName: string | undefined;

  /** The PROGRAM whose body or method is being checked (bare method calls). */
  private currentProgram: ProgramDeclaration | undefined;

  /**
   * `--strict`: a CASE label value may appear once; ranges are compared by their
   * bounds. The C++ switch would otherwise fail with "duplicate case value".
   * Labels that are not integer literals or enum values are not compared.
   */
  private checkStrictDuplicateLabels(
    stmt: Extract<Statement, { kind: "CaseStatement" }>,
    scope: Scope,
  ): void {
    const enums = new Set<string>();
    const ranges: Array<{ lo: number; hi: number }> = [];
    for (const c of stmt.cases) {
      for (const label of c.labels) {
        const lo = this.caseLabelValue(label.start, scope);
        const hi = label.end ? this.caseLabelValue(label.end, scope) : lo;
        let duplicate = false;
        let text = "";
        if (typeof lo === "string" && lo === hi) {
          duplicate = enums.has(lo);
          enums.add(lo);
          text = lo;
        } else if (typeof lo === "number" && typeof hi === "number") {
          if (hi < lo) continue;
          duplicate = ranges.some((r) => lo <= r.hi && r.lo <= hi);
          ranges.push({ lo, hi });
          text = lo === hi ? String(lo) : `${lo}..${hi}`;
        }
        if (duplicate) {
          this.addStrictErrorAt(
            `Duplicate CASE label ${text}`,
            label.sourceSpan,
          );
        }
      }
    }
  }

  /** An integer (number) or an enum value (its upper-case name), else undefined. */
  private caseLabelValue(
    expr: Expression,
    scope: Scope,
  ): number | string | undefined {
    switch (expr.kind) {
      case "ParenthesizedExpression":
        return this.caseLabelValue(expr.expression, scope);
      case "LiteralExpression":
        return expr.literalType === "INT" && typeof expr.value === "number"
          ? expr.value
          : undefined;
      case "UnaryExpression": {
        const v = this.caseLabelValue(expr.operand, scope);
        if (typeof v !== "number") return undefined;
        return expr.operator === "-"
          ? -v
          : expr.operator === "+"
            ? v
            : undefined;
      }
      case "VariableExpression": {
        if (expr.subscripts.length > 0 || expr.isDereference) return undefined;
        if (expr.fieldAccess.length === 0) {
          return scope.lookup(expr.name)?.kind === "enumValue"
            ? expr.name.toUpperCase()
            : undefined;
        }
        return expr.fieldAccess.length === 1 &&
          this.symbolTables.globalScope.lookup(expr.name)?.kind === "type"
          ? expr.fieldAccess[0]!.toUpperCase()
          : undefined;
      }
      default:
        return undefined;
    }
  }

  /**
   * `--strict`: END_IF, END_CASE, END_FOR, END_WHILE and END_REPEAT need a `;`,
   * unless the feature end_semicolon_optional relaxes the check.
   */
  private checkStrictTerminator(stmt: {
    unterminated?: UnterminatedEnd;
  }): void {
    if (!this.strict || !stmt.unterminated) return;
    if (this.features.has("end_semicolon_optional")) return;
    this.addStrictErrorAt(
      `Missing ';' after ${stmt.unterminated.keyword}`,
      stmt.unterminated.sourceSpan,
    );
  }

  /** `--strict`: a function with a return type may not be called as a statement. */
  private checkStrictDiscardedResult(
    call: FunctionCallExpression,
    scope: Scope,
  ): void {
    if (call.instance) return;
    if (scope.lookup(call.functionName)?.kind === "variable") return;
    if (this.calledInstance(call.functionName, scope)) return;
    const fn = this.symbolTables.lookupFunction(call.functionName);
    if (!fn?.returnType) return;
    this.addStrictErrorAt(
      `The result of ${call.functionName} is not used; assign it or use it in an expression`,
      call.sourceSpan,
    );
  }

  /** `--strict`: an FB call may only name parameters the FB has. */
  private checkStrictFbParameters(
    call: FunctionCallExpression,
    scope: Scope,
  ): void {
    if (call.instance) return;
    const sym = scope.lookup(call.functionName);
    if (sym?.kind !== "variable") return;
    const declared = sym.declaration as VarDeclaration | undefined;
    if (!declared) return;
    const typeName = declared.type.name;
    const known = this.fbParameterNames(typeName);
    if (!known) return;
    for (const arg of call.arguments) {
      if (arg.name === undefined) continue;
      const upper = arg.name.toUpperCase();
      if (upper === "EN" || upper === "ENO" || known.has(upper)) continue;
      this.addStrictErrorAt(
        `${typeName} has no input or output named ${arg.name}`,
        arg.sourceSpan,
      );
    }
  }

  /** `inst(name := v)` on a variable: the name must be a member of the FB. */
  private checkFbInstanceCallNames(
    call: FunctionCallExpression,
    scope: Scope,
  ): void {
    if (call.instance || call.functionName.includes(".")) return;
    const sym = scope.lookup(call.functionName);
    if (sym?.kind !== "variable") return;
    const declared = sym.declaration as VarDeclaration | undefined;
    if (declared) this.checkFbCallArgumentNames(declared.type, call.arguments);
  }

  /**
   * Named arguments of a call on an instance of `type`, a function block this
   * compile declares, that name no input, output or in/out of it. The C++
   * assigns `inst.NAME`: for an unknown name, a method, a property or a
   * VAR_EXTERNAL it does not build, and a VAR, VAR_TEMP or CONSTANT local is
   * not part of the call interface.
   */
  private checkFbCallArgumentNames(
    type: VarDeclaration["type"],
    args: readonly Argument[],
  ): void {
    if (type.referenceKind !== "none" || type.arrayDimensions !== undefined) {
      return;
    }
    if (!this.fbMemberNames(type.name)) return;
    const known = this.fbParameterNames(type.name);
    if (!known) return;
    for (const arg of args) {
      if (arg.name === undefined) continue;
      const upper = arg.name.toUpperCase();
      if (upper === "EN" || upper === "ENO" || known.has(upper)) continue;
      this.addStrictErrorAt(
        `${type.name} has no input or output named ${arg.name}`,
        arg.sourceSpan,
      );
    }
  }

  /**
   * The upper-cased names of every variable, method, property and action of a
   * function block this compile declares, bases included. Undefined when the
   * type or a base is not declared here (a library block, say).
   */
  private fbMemberNames(typeName: string): Set<string> | undefined {
    const names = new Set<string>();
    let current: string | undefined = typeName.toUpperCase();
    for (let depth = 0; current !== undefined; depth++) {
      if (depth >= 32) return undefined;
      const upper: string = current;
      const fb = this.ast?.functionBlocks.find(
        (f) => f.name.toUpperCase() === upper,
      );
      if (!fb) return undefined;
      for (const block of fb.varBlocks) {
        for (const d of block.declarations) {
          for (const n of d.names) names.add(n.toUpperCase());
        }
      }
      for (const m of fb.methods) names.add(m.name.toUpperCase());
      for (const p of fb.properties) names.add(p.name.toUpperCase());
      for (const a of fb.actions) names.add(a.name.toUpperCase());
      current = fb.extends?.toUpperCase();
    }
    return names;
  }

  /**
   * The upper-cased names of every input, output and in/out of an FB type,
   * inherited ones included. Undefined when the type is not a known FB.
   */
  private fbParameterNames(typeName: string): Set<string> | undefined {
    const names = new Set<string>();
    const isParam = (b: VarBlock): boolean =>
      b.blockType === "VAR_INPUT" ||
      b.blockType === "VAR_OUTPUT" ||
      b.blockType === "VAR_IN_OUT";
    let current: string | undefined = typeName.toUpperCase();
    let found = false;
    for (let depth = 0; current !== undefined && depth < 32; depth++) {
      const upper: string = current;
      const fb = this.ast?.functionBlocks.find(
        (f) => f.name.toUpperCase() === upper,
      );
      if (fb) {
        found = true;
        for (const block of fb.varBlocks.filter(isParam)) {
          for (const d of block.declarations) {
            for (const n of d.names) names.add(n.toUpperCase());
          }
        }
        current = fb.extends?.toUpperCase();
        continue;
      }
      const lib = this.symbolTables.lookupFunctionBlock(upper);
      if (lib) {
        found = true;
        for (const m of [...lib.inputs, ...lib.outputs, ...lib.inouts]) {
          names.add(m.name.toUpperCase());
        }
      }
      break;
    }
    return found ? names : undefined;
  }

  /** Strict diagnostics already reported, so an expression visited twice reports once. */
  private strictReported = new Set<string>();

  private addStrictError(message: string, at: Expression): void {
    this.addStrictErrorAt(message, at.sourceSpan);
  }

  private addStrictErrorAt(message: string, span: SourceSpan): void {
    const { startLine, startCol, file } = span;
    const key = `${startLine}:${startCol}:${file ?? ""}:${message}`;
    if (this.strictReported.has(key)) return;
    this.strictReported.add(key);
    this.addError(message, startLine, startCol, file);
  }

  /**
   * The kind of an untyped constant expression, else undefined: an untyped
   * literal, or unary +/-, NOT, parentheses, + - * / MOD and generic standard
   * function calls over untyped constants only. Mixed INT/REAL is not one.
   */
  private untypedConstantKind(expr: Expression): StrictConstKind | undefined {
    switch (expr.kind) {
      case "LiteralExpression":
        if ((expr.typePrefix ?? "") !== "") return undefined;
        return expr.literalType === "INT" ||
          expr.literalType === "REAL" ||
          expr.literalType === "BOOL"
          ? expr.literalType
          : undefined;
      case "ParenthesizedExpression":
        return this.untypedConstantKind(expr.expression);
      case "UnaryExpression": {
        const k = this.untypedConstantKind(expr.operand);
        if (expr.operator === "NOT") return k === "REAL" ? undefined : k;
        return k === "BOOL" ? undefined : k;
      }
      case "BinaryExpression": {
        if (!STRICT_ARITHMETIC_OPS.has(expr.operator)) return undefined;
        const l = this.untypedConstantKind(expr.left);
        const r = this.untypedConstantKind(expr.right);
        return l === r && l !== "BOOL" ? l : undefined;
      }
      case "FunctionCallExpression": {
        const args = this.strictGenericArgs(expr);
        if (!args || args.length === 0) return undefined;
        const kinds = new Set(args.map((a) => this.untypedConstantKind(a)));
        if (kinds.size !== 1 || kinds.has(undefined)) return undefined;
        return [...kinds][0];
      }
      default:
        return undefined;
    }
  }

  /**
   * The argument values a generic (ANY_*) standard function takes its type
   * from (SEL's G and MUX's K excluded). Undefined for any other call.
   */
  private strictGenericArgs(
    expr: FunctionCallExpression,
  ): Expression[] | undefined {
    if (
      !this.stdRegistry ||
      this.findUserFunction(expr.functionName) ||
      this.ownMethod(expr.functionName)
    ) {
      return undefined;
    }
    const desc = this.stdRegistry.lookup(expr.functionName.toUpperCase());
    if (!desc || !STRICT_GENERIC.has(desc.returnConstraint)) return undefined;
    // TRUNC's result type is fixed by its argument type, not adapted to it.
    if (desc.returnTypeFor) return undefined;
    const params = desc.params;
    const out: Expression[] = [];
    stripEnEno([...expr.arguments]).forEach((arg, i) => {
      if (arg.isOutput) return;
      const upper = arg.name?.toUpperCase();
      const param =
        upper === undefined
          ? (params[i] ?? (desc.isVariadic ? params.at(-1) : undefined))
          : (params.find((q) => q.name === upper) ??
            (desc.isVariadic ? params.at(-1) : undefined));
      if (param && STRICT_GENERIC.has(param.constraint)) out.push(arg.value);
    });
    return out;
  }

  /** `0`, `1`, a parenthesised one or NOT of one: matiec takes these as BOOL. */
  private isStrictBoolConstant(expr: Expression): boolean {
    switch (expr.kind) {
      case "LiteralExpression":
        return (
          (expr.typePrefix ?? "") === "" &&
          expr.literalType === "INT" &&
          (Number(expr.value) === 0 || Number(expr.value) === 1)
        );
      case "ParenthesizedExpression":
        return this.isStrictBoolConstant(expr.expression);
      case "UnaryExpression":
        return (
          expr.operator === "NOT" && this.isStrictBoolConstant(expr.operand)
        );
      case "FunctionCallExpression": {
        // `NOT (0)` parses as a call of the NOT function.
        const args = stripEnEno([...expr.arguments]);
        return (
          expr.functionName.toUpperCase() === "NOT" &&
          !this.findUserFunction(expr.functionName) &&
          args.length === 1 &&
          !args[0]!.isOutput &&
          this.isStrictBoolConstant(args[0]!.value)
        );
      }
      default:
        return false;
    }
  }

  /** Whether an untyped constant of kind `k` takes the type of kind `kind`. */
  private static constantAdapts(
    k: StrictConstKind,
    kind: StrictKind | undefined,
  ): boolean {
    return k === "INT"
      ? kind === "int" || kind === "real" || kind === "bit"
      : k === "REAL"
        ? kind === "real"
        : kind === "bool" || kind === "bit";
  }

  /**
   * The type an expression has for strict conversion checks. An untyped
   * constant adapts to the other operand (`u + 1` with u USINT is a USINT), so it
   * never forces a conversion by itself; everything else keeps its resolved type.
   */
  private strictExprType(expr: Expression): IECType | undefined {
    switch (expr.kind) {
      case "ParenthesizedExpression":
        return this.strictExprType(expr.expression);
      case "UnaryExpression":
        return expr.operator === "NOT"
          ? expr.resolvedType
          : this.strictExprType(expr.operand);
      case "BinaryExpression": {
        if (!STRICT_ARITHMETIC_OPS.has(expr.operator)) return expr.resolvedType;
        const leftK = this.untypedConstantKind(expr.left);
        const rightK = this.untypedConstantKind(expr.right);
        if ((leftK === undefined) === (rightK === undefined)) {
          return expr.resolvedType;
        }
        const other = this.strictExprType(leftK ? expr.right : expr.left);
        if (other?.typeKind !== "elementary") return expr.resolvedType;
        const kind = strictKind((other as ElementaryType).name);
        return TypeChecker.constantAdapts((leftK ?? rightK)!, kind)
          ? other
          : expr.resolvedType;
      }
      case "FunctionCallExpression": {
        // MAX(-1, s) takes its type from s, not from the literal. A still-generic
        // result (LIMIT, SEL, MUX) stays unchecked: this wave adds no rejections.
        if (
          expr.resolvedType?.typeKind !== "elementary" ||
          isGenericGroupType(expr.resolvedType)
        ) {
          return expr.resolvedType;
        }
        const args = this.strictGenericArgs(expr);
        if (!args) return expr.resolvedType;
        const typed = args.filter(
          (a) => this.untypedConstantKind(a) === undefined,
        );
        if (typed.length === 0) return expr.resolvedType;
        const other = this.strictExprType(typed[0]!);
        if (other?.typeKind !== "elementary") return expr.resolvedType;
        const kind = strictKind((other as ElementaryType).name);
        const adapts = args.every((a) => {
          const k = this.untypedConstantKind(a);
          return k === undefined || TypeChecker.constantAdapts(k, kind);
        });
        return adapts ? other : expr.resolvedType;
      }
      default:
        return expr.resolvedType;
    }
  }

  /**
   * Strict rows a, b, c and f for `value` going into something of `targetType`.
   * Returns true when the value is settled (accepted or reported), false when the
   * ordinary rules should decide.
   */
  private checkStrictConversion(
    targetType: IECType,
    value: Expression,
  ): boolean {
    if (targetType.typeKind !== "elementary") return false;
    const valueType = this.strictExprType(value);
    if (valueType?.typeKind !== "elementary") return false;
    const t = (targetType as ElementaryType).name.toUpperCase();
    const v = (valueType as ElementaryType).name.toUpperCase();
    if (t === v) return false;
    const tKind = strictKind(t);
    const vKind = strictKind(v);

    // Row f: an integer where a duration is expected.
    if ((t === "TIME" || t === "LTIME") && vKind === "int") {
      this.addStrictError(
        t === "LTIME"
          ? "An integer cannot be used as LTIME; write an LTIME literal such as LTIME#100ms"
          : `An integer cannot be used as ${t}; write a TIME literal such as T#100ms`,
        value,
      );
      return true;
    }
    if (tKind === undefined || vKind === undefined) return false;

    // An untyped constant (`1`, `-1`, `1 + 2`) keeps its value in any integer or REAL.
    const constKind = this.untypedConstantKind(value);
    if (constKind && TypeChecker.constantAdapts(constKind, tKind)) return false;
    // matiec accepts 0, 1 and NOT 0/1 for a BOOL (and rejects any other integer).
    if (tKind === "bool" && this.isStrictBoolConstant(value)) return false;
    if (strictIsExactWidening(v, t)) return true;
    this.addStrictError(strictConversionMessage(v, t), value);
    return true;
  }

  /** Strict arithmetic: rows d and e. One diagnostic per operation. */
  private checkStrictArithmetic(
    expr: BinaryExpression,
    leftType: IECType,
    rightType: IECType,
  ): void {
    for (const type of [leftType, rightType]) {
      if (type.typeKind !== "elementary") continue;
      const name = (type as ElementaryType).name.toUpperCase();
      if (name === "BOOL") {
        this.addStrictError("Arithmetic on BOOL is not allowed", expr);
        return;
      }
      if (STRICT_BIT_STRINGS.has(name)) {
        this.addStrictError(
          `Arithmetic on ${name} is not allowed; convert it to an integer type first`,
          expr,
        );
        return;
      }
    }
  }

  /** Strict conversion check for each input argument of a call. */
  private checkStrictArguments(
    inputs: Array<{ name: string; type: AccessType }> | undefined,
    args: readonly Argument[],
    _scope: Scope,
  ): void {
    if (!inputs) return;
    stripEnEno([...args]).forEach((arg, i) => {
      if (arg.isOutput) return;
      const argName = arg.name?.toUpperCase();
      const input =
        argName === undefined
          ? inputs[i]
          : inputs.find((p) => p.name.toUpperCase() === argName);
      if (!input) return;
      const refKind = input.type.referenceKind;
      if (refKind !== undefined && refKind !== "none") return;
      if (input.type.arrayDimensions !== undefined) return;
      const declared = ELEMENTARY_TYPES[input.type.name.toUpperCase()];
      if (declared) this.checkStrictConversion(declared, arg.value);
    });
  }

  /** The input parameters of the method a method-call expression names. */
  private methodInputs(
    objType: IECType | undefined,
    expr: MethodCallExpression,
    scope: Scope,
  ): CallInput[] | undefined {
    let typeName: string | undefined;
    if (objType?.typeKind === "elementary") {
      typeName = (objType as ElementaryType).name;
    } else if (expr.object.kind === "VariableExpression") {
      const sym = scope.lookup(expr.object.name);
      if (sym?.kind === "variable") typeName = sym.declaration?.type?.name;
      else if (
        sym?.kind === "program" &&
        this.features.has("program_methods")
      ) {
        typeName = sym.name;
      }
    }
    return this.methodInputsOf(typeName, expr.methodName);
  }

  /**
   * The inputs of any FB or method call form the other resolvers leave out:
   * `arr[i](...)`, `p^(...)`, `s.f(...)`, `THIS.M(...)`, `SUPER.M(...)` and an
   * interface's `i.M(...)`. Only the CHAR literal rule uses it.
   */
  private anyCallInputs(
    expr: FunctionCallExpression,
    scope: Scope,
  ): CallInput[] | undefined {
    if (expr.instance !== undefined) {
      let t = this.resolveExprType(expr.instance, scope);
      if (t?.typeKind === "reference") {
        t = (t as ReferenceType).referencedType;
      }
      if (t?.typeKind === "elementary") {
        return this.fbInputsOf((t as ElementaryType).name);
      }
      // `p^(...)`: the type the pointer or reference is declared to
      const inst = expr.instance;
      const sym =
        inst.kind === "VariableExpression"
          ? scope.lookup(inst.name)
          : undefined;
      const declared =
        sym?.kind === "variable"
          ? (sym.declaration as VarDeclaration | undefined)?.type
          : undefined;
      return inst.kind === "VariableExpression" &&
        inst.isDereference &&
        inst.fieldAccess.length === 0 &&
        inst.subscripts.length === 0 &&
        declared !== undefined
        ? this.fbInputsOf(declared.name)
        : undefined;
    }
    const parts = expr.functionName.split(".");
    if (parts.length !== 2) return undefined;
    const [owner, member] = [parts[0]!, parts[1]!];
    const ownerType = this.callOwnerType(owner, scope);
    if (ownerType === undefined) return undefined;
    return (
      this.methodInputsOf(ownerType, member) ??
      this.interfaceMethodInputs(ownerType, member) ??
      this.memberFbInputs(ownerType, member)
    );
  }

  /** The type `owner` names in `owner.member(...)`: THIS, SUPER or a variable's type. */
  private callOwnerType(owner: string, scope: Scope): string | undefined {
    const upper = owner.toUpperCase();
    if (upper === "THIS") return this.currentFBName;
    if (upper === "SUPER") {
      return this.ast?.functionBlocks.find(
        (f) => f.name.toUpperCase() === this.currentFBName?.toUpperCase(),
      )?.extends;
    }
    const sym = scope.lookup(owner);
    if (sym?.kind !== "variable") return this.inheritedMemberType(owner)?.name;
    return (sym.declaration as VarDeclaration | undefined)?.type.name;
  }

  /** The inputs of method `methodName` of an INTERFACE or one it extends. */
  private interfaceMethodInputs(
    typeName: string,
    methodName: string,
    depth = 0,
  ): CallInput[] | undefined {
    const itf = this.interfaceNamed(typeName);
    if (!itf || depth > 32) return undefined;
    const method = itf.methods.find(
      (m) => m.name.toUpperCase() === methodName.toUpperCase(),
    );
    if (method) {
      return method.varBlocks
        .filter(
          (b) => b.blockType === "VAR_INPUT" || b.blockType === "VAR_IN_OUT",
        )
        .flatMap((b) =>
          b.declarations.flatMap((d) =>
            d.names.map((n) => ({
              name: n,
              type: d.type,
              inOut: b.blockType === "VAR_IN_OUT",
            })),
          ),
        );
    }
    for (const base of itf.extends ?? []) {
      const found = this.interfaceMethodInputs(base, methodName, depth + 1);
      if (found) return found;
    }
    return undefined;
  }

  /** The inputs of an FB instance `member` of a STRUCT or FB type (`s.f(...)`). */
  private memberFbInputs(
    typeName: string,
    member: string,
  ): CallInput[] | undefined {
    const fieldType = this.resolveFieldTypeAnywhere(
      this.aliasBase(typeName),
      member,
    );
    return fieldType === undefined ? undefined : this.fbInputsOf(fieldType);
  }

  /** Inputs of `instance.Method(...)`, written as one dotted call name. */
  private dottedMethodInputs(
    functionName: string,
    scope: Scope,
  ): CallInput[] | undefined {
    const parts = functionName.split(".");
    if (parts.length !== 2) return undefined;
    const sym = scope.lookup(parts[0]!);
    if (sym?.kind === "program" && this.features.has("program_methods")) {
      return this.methodInputsOf(sym.name, parts[1]!);
    }
    if (sym?.kind !== "variable") return undefined;
    return this.methodInputsOf(sym.declaration?.type?.name, parts[1]!);
  }

  /** The VAR_INPUT / VAR_IN_OUT declarations of a method of an FB (or a base FB). */
  private methodInputsOf(
    fbTypeName: string | undefined,
    methodName: string,
  ): CallInput[] | undefined {
    if (!this.ast) return undefined;
    const inputsOf = (method: MethodDeclaration): CallInput[] =>
      method.varBlocks
        .filter(
          (b) => b.blockType === "VAR_INPUT" || b.blockType === "VAR_IN_OUT",
        )
        .flatMap((b) =>
          b.declarations.flatMap((d) =>
            d.names.map((n) => ({
              name: n,
              type: d.type,
              inOut: b.blockType === "VAR_IN_OUT",
            })),
          ),
        );
    let current = fbTypeName?.toUpperCase();
    for (let depth = 0; current !== undefined && depth < 32; depth++) {
      const name: string = current;
      const fb = this.ast.functionBlocks.find(
        (f) => f.name.toUpperCase() === name,
      );
      if (!fb) {
        // A PROGRAM's methods (programs have no base type)
        const prog = this.ast.programs.find(
          (p) => p.name.toUpperCase() === name,
        );
        const own = prog?.methods.find(
          (m) => m.name.toUpperCase() === methodName.toUpperCase(),
        );
        return own ? inputsOf(own) : undefined;
      }
      const method = fb.methods.find(
        (m) => m.name.toUpperCase() === methodName.toUpperCase(),
      );
      if (method) return inputsOf(method);
      current = fb.extends?.toUpperCase();
    }
    return undefined;
  }

  // ===========================================================================
  // Public API (backward compatible)
  // ===========================================================================

  /**
   * Check if a type belongs to a category.
   * Delegates to type-utils.
   */
  isTypeInCategory(
    type: IECType,
    category: import("./type-utils.js").TypeCategory,
  ): boolean {
    return _isTypeInCategory(type, category);
  }

  /**
   * Check if two types are compatible for assignment.
   * Delegates to type-utils isAssignable.
   */
  areTypesCompatible(target: IECType, source: IECType): boolean {
    return _isAssignable(target, source);
  }

  // ===========================================================================
  // Error/Warning Helpers
  // ===========================================================================

  /**
   * Add an error message.
   */
  private addError(
    message: string,
    line: number,
    column: number,
    file?: string,
  ): void {
    this.errors.push({
      message,
      line,
      column,
      severity: "error",
      ...(file ? { file } : {}),
    });
  }

  /**
   * Add a warning message.
   */
  protected addWarning(
    message: string,
    line: number,
    column: number,
    file?: string,
  ): void {
    this.warnings.push({
      message,
      line,
      column,
      severity: "warning",
      ...(file ? { file } : {}),
    });
  }
}
