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
import type { SymbolTables, Scope } from "./symbol-table.js";
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
import { stripEnEno, walkAST } from "../ast-utils.js";
import { DEFAULT_FEATURES, type FeatureId } from "../dialect.js";
import { structExtends } from "./struct-extends.js";
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

/** True when the operand type is one of the absolute-time types. */
function isInstantType(t: IECType): boolean {
  if (t.typeKind !== "elementary") return false;
  const name = (t as ElementaryType).name;
  return name === "DT" || name === "DATE" || name === "TOD";
}

/** True when the operand type is the duration type (TIME). */
function isDurationType(t: IECType): boolean {
  if (t.typeKind !== "elementary") return false;
  return (t as ElementaryType).name === "TIME";
}

/** True when the operand pair maps to a recognised date/time arithmetic
 *  rule from IEC 61131-3 §6.6.2.2 — instant minus instant, or instant
 *  ± duration. Anything else (DT * 2, TIME / DT, …) falls through to
 *  the normal arithmetic path so we don't widen the rule beyond what
 *  the standard sanctions. */
function isDateTimeArithmetic(
  left: IECType,
  right: IECType,
  op: string,
): boolean {
  const leftIsInstant = isInstantType(left);
  const rightIsInstant = isInstantType(right);
  const leftIsTime = isDurationType(left);
  const rightIsTime = isDurationType(right);

  // instant - instant → TIME (duration). Both must be the same instant
  // type per the standard (DT - TOD is meaningless).
  if (op === "-" && leftIsInstant && rightIsInstant) {
    return (left as ElementaryType).name === (right as ElementaryType).name;
  }
  // instant ± duration → instant (offset)
  if (leftIsInstant && rightIsTime) return true;
  // duration + instant → instant (commutative addition only)
  if (op === "+" && leftIsTime && rightIsInstant) return true;
  return false;
}

/** Resolves the result type for a recognised date/time arithmetic pair.
 *  Pre-condition: isDateTimeArithmetic returned true for the same args. */
function resolveDateTimeArithmetic(
  left: IECType,
  right: IECType,
  op: string,
): IECType | undefined {
  const leftIsInstant = isInstantType(left);
  const rightIsInstant = isInstantType(right);

  if (op === "-" && leftIsInstant && rightIsInstant) {
    return ELEMENTARY_TYPES["TIME"];
  }
  // instant ± duration: result keeps the instant type.
  if (leftIsInstant) return left;
  // duration + instant (commutative): result is the instant type.
  if (rightIsInstant) return right;
  return undefined;
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
function describeReferenceShape(shape: {
  chain: string[];
  base: string;
}): string {
  return [...shape.chain.map((k) => REFERENCE_LEVEL_TEXT[k] ?? k), shape.base]
    .join(" ")
    .toUpperCase();
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
function referenceShapeOf(
  type: AccessType,
): { chain: string[]; base: string } | undefined {
  if (type.arrayDimensions) return undefined;
  const chain =
    type.referenceChain ??
    (type.referenceKind !== undefined && type.referenceKind !== "none"
      ? [type.referenceKind]
      : []);
  return { chain, base: type.name };
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

type StrictKind = "int" | "real" | "bool";
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
  return undefined;
}

function strictConversionMessage(from: string, to: string): string {
  return `Implicit conversion from ${from} to ${to} is not allowed; use ${from}_TO_${to}`;
}

/**
 * Whether converting `from` to `to` loses nothing: integer to a wider integer
 * (unsigned to a wider signed too, never signed to unsigned), SINT/INT/USINT/UINT
 * to REAL, any integer up to 32 bits to LREAL, and REAL to LREAL.
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
  return false;
}

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
    this.checkAllInitializerElements(ast);

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
          if (prop.getter) this.checkStatements(prop.getter, scope);
          if (prop.setter) this.checkStatements(prop.setter, scope);
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
    const fb = this.symbolTables.lookupFunctionBlock(typeName);
    if (fb) {
      const fu = fieldName.toUpperCase();
      for (const m of [
        ...fb.inputs,
        ...fb.outputs,
        ...fb.inouts,
        ...fb.locals,
      ]) {
        if (m.name.toUpperCase() === fu) return m.declaration?.type?.name;
      }
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
    walkAST(ast, (node) => {
      if (node.kind !== "VarDeclaration") return;
      const decl = node as VarDeclaration;
      if (decl.initialValue) {
        this.checkInitializerElements(decl.type, decl.initialValue);
      }
    });
  }

  /**
   * Report an element a structure initializer names that its STRUCT or
   * function block does not have, at any depth: `(zz := 1)`, `[(zz := 1)]`,
   * `(p := (zz := 1))`. Only types whose whole EXTENDS chain is declared here.
   */
  private checkInitializerElements(
    type: AccessType | undefined,
    value: Expression,
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
      for (const e of value.elements) this.checkInitializerElements(element, e);
      return;
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
      if (field) {
        this.checkInitializerElements(field.type, el.value);
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
      if (!fb) return false;
      const named = (n: { name: string }): boolean =>
        n.name.toUpperCase() === memberUpper;
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
      case "DATE":
        type = ELEMENTARY_TYPES["DATE"];
        break;
      case "TIME_OF_DAY":
        type = ELEMENTARY_TYPES["TIME_OF_DAY"];
        break;
      case "DATE_AND_TIME":
        type = ELEMENTARY_TYPES["DATE_AND_TIME"];
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
   * Infer type of a variable expression, including access chain resolution.
   */
  private inferVariableType(
    expr: VariableExpression,
    scope: Scope,
  ): IECType | undefined {
    const symbol = scope.lookup(expr.name);
    if (symbol === undefined) {
      // Don't report error here — Pass 3 undeclared-variable check handles this
      return undefined;
    }

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
          // Resolve array element type
          const elemType = resolveArrayElementType(currentTypeName, this.ast);
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
        }
        const elemType = resolveArrayElementType(currentTypeName, this.ast);
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

  /**
   * Infer type of a binary expression.
   */
  private inferBinaryType(
    expr: BinaryExpression,
    scope: Scope,
  ): IECType | undefined {
    const leftType = this.resolveExprType(expr.left, scope);
    const rightType = this.resolveExprType(expr.right, scope);

    if (leftType === undefined || rightType === undefined) {
      return undefined;
    }

    if (this.strict && STRICT_ARITHMETIC_OPS.has(expr.operator)) {
      this.checkStrictArithmetic(expr, leftType, rightType);
    }

    let type: IECType | undefined;

    // Comparison operators always return BOOL
    if (["=", "<>", "<", ">", "<=", ">="].includes(expr.operator)) {
      type = ELEMENTARY_TYPES["BOOL"];
    }
    // Logical operators return BOOL
    else if (["AND", "OR", "XOR"].includes(expr.operator)) {
      type = ELEMENTARY_TYPES["BOOL"];
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
   * Infer type of a function call expression.
   */
  private inferFunctionCallType(
    expr: FunctionCallExpression,
    scope: Scope,
  ): IECType | undefined {
    // Resolve argument expressions
    for (const arg of expr.arguments) {
      this.resolveExprType(arg.value, scope);
    }
    this.validateReferenceArguments(expr, scope);
    this.checkDottedMethodCall(expr, scope);
    const inputs =
      this.callInputs(expr, scope) ??
      this.dottedMethodInputs(expr.functionName, scope);
    this.validateInterfaceArguments(inputs, expr.arguments);
    this.validateStructArguments(inputs, expr.arguments);
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
    const ownMethod = this.ownProgramMethod(expr.functionName);
    if (ownMethod) {
      const retType = this.methodReturnType(ownMethod);
      if (retType) expr.resolvedType = retType;
      return retType;
    }

    // Check user-defined functions in symbol tables
    const funcSymbol = this.symbolTables.lookupFunction(expr.functionName);
    if (funcSymbol !== undefined) {
      let returnType = funcSymbol.returnType;
      // Overloaded standard functions are published in the builtin stdlib
      // manifest with their generic return *constraint* (e.g. NOT -> ANY_BIT,
      // ADD -> ANY_NUM). When the IEC signature says the result type matches
      // the first argument, refine that generic to the concrete operand type
      // so downstream checks see a real type — e.g. NOT(BOOL) -> BOOL, which
      // the EN-input check (and bit/num operand rules) require.
      if (returnType && isGenericGroupType(returnType) && this.stdRegistry) {
        const desc = this.stdRegistry.lookup(nameUpper);
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
      if (desc) {
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
      this.validateInterfaceArguments(chainInputs, expr.arguments);
      this.validateStructArguments(chainInputs, expr.arguments);
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
    this.validateInterfaceArguments(methodInputs, expr.arguments);
    this.validateStructArguments(methodInputs, expr.arguments);
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
    if (kind === undefined) return;
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
      if (this.callTargetKind(member.type) === "value") {
        this.addError(
          `Cannot call '${prefix}.${methodName}': it is a member that is not a function block instance, not a method`,
          span.startLine,
          span.startCol,
          span.file,
        );
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
    if (
      owner.referenceKind === "none" &&
      this.lookupMember(owner.name, expr.methodName) !== undefined
    ) {
      error(
        `'${this.chainText(object)}.${expr.methodName}' is a member, not a method; invoking a function block through a member chain is not supported`,
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
    for (const arg of args) {
      if (arg.name !== undefined && !params.includes(arg.name.toUpperCase())) {
        error(
          `Method '${found.name}' of '${owner.name}' has no parameter named '${arg.name}'`,
          arg.sourceSpan,
        );
      }
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

  /** A bare `Name(...)` inside a PROGRAM that names one of its methods. */
  private ownProgramMethod(name: string): MethodDeclaration | undefined {
    if (!this.currentProgram || name.includes(".")) return undefined;
    const upper = name.toUpperCase();
    return this.currentProgram.methods.find(
      (m) => m.name.toUpperCase() === upper,
    );
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
          !isNullInitializer(decl.initialValue)
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
        this.validateInOutMemberWrite(stmt.target, scope);
        if (this.isAddressIntoPointer(stmt.target, valueType, scope)) break;
        if (this.checkArrayScalarAssignment(stmt.target, stmt.value, scope)) {
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
          for (const label of c.labels) {
            this.resolveExprType(label.start, scope);
            if (label.end) this.resolveExprType(label.end, scope);
          }
          this.checkStatements(c.statements, scope);
        }
        if (this.strict) this.checkStrictDuplicateLabels(stmt, scope);
        this.checkStatements(stmt.elseStatements, scope);
        break;
      }

      case "ForStatement": {
        this.checkStrictTerminator(stmt);
        if (this.strict && stmt.body.length === 0) {
          this.addStrictErrorAt("A FOR loop must have a body", stmt.sourceSpan);
        }
        const startType = this.resolveExprType(stmt.start, scope);
        const endType = this.resolveExprType(stmt.end, scope);
        if (stmt.step) this.resolveExprType(stmt.step, scope);

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
        // resolveExprType already validates function call args
        this.resolveExprType(stmt.call, scope);
        if (this.strict && stmt.call.kind === "FunctionCallExpression") {
          this.checkStrictDiscardedResult(stmt.call, scope);
          this.checkStrictFbParameters(stmt.call, scope);
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
          if (!ELEMENTARY_TYPES[tName] || !ELEMENTARY_TYPES[vName]) {
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
  private structRelation(target: string, source: string): string | undefined {
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
      const levelsOk =
        source.chain.length === 0 ||
        (source.chain.length === 1 && source.chain[0] === "reference_to");
      if (levelsOk) {
        if (
          !this.isReferableType(target.base) ||
          !this.isReferableType(source.base)
        ) {
          return;
        }
        if (
          canonicalElementaryName(this.aliasBase(target.base)) ===
          canonicalElementaryName(this.aliasBase(source.base))
        ) {
          this.markAliasReferenceBinding(target, source, value);
          return;
        }
      }
      fail(
        `${describeReferenceShape(target)} cannot refer to a ${describeReferenceShape(source)} variable${levelsOk ? this.referenceMismatchReason(this.aliasBase(source.base)) : ""}`,
      );
    });
  }

  /** A call of a function-block instance (`fb(...)`, `arr[i](...)`). */
  private isFBInstanceCall(
    expr: FunctionCallExpression,
    scope: Scope,
  ): boolean {
    if (expr.instance !== undefined) return true;
    if (this.ownProgramMethod(expr.functionName)) return false;
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

  /** Report `value` when it cannot be held by a target of shape `t`. */
  private validateReferenceValue(
    t: { chain: string[]; base: string },
    value: Expression,
    scope: Scope,
  ): void {
    if (t.chain[0] !== "ref_to") return;
    const v = this.declaredReferenceShape(value, scope);
    if (!v || v.chain.length === 0) return;
    if (!this.isExactlyKnownType(t.base) || !this.isExactlyKnownType(v.base)) {
      return;
    }
    const sameLevels =
      t.chain.length === v.chain.length &&
      t.chain.every((kind, i) => kind === v.chain[i]);
    const sameBase =
      canonicalElementaryName(t.base.toUpperCase()) ===
      canonicalElementaryName(v.base.toUpperCase());
    if (sameLevels && sameBase) return;
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
  ): { chain: string[]; base: string } | undefined {
    if (expr.kind === "RefExpression") {
      const inner = this.declaredReferenceShape(expr.operand, scope);
      return inner
        ? { chain: ["ref_to", ...inner.chain], base: inner.base }
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
    return type ? referenceShapeOf(type) : undefined;
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
    const ownMethod = this.ownProgramMethod(expr.functionName);
    if (ownMethod) return fromBlocks(ownMethod.varBlocks);
    const fn = this.findUserFunction(expr.functionName);
    if (fn) return fromBlocks(fn.varBlocks);
    const sym = scope.lookup(expr.functionName);
    if (sym?.kind !== "variable" || expr.instance) return undefined;
    const declared = sym.declaration as VarDeclaration | undefined;
    if (!declared) return undefined;
    const typeName = declared.type.name.toUpperCase();
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

  private validateCaseSelector(
    selectorType: IECType,
    selectorExpr: Expression,
  ): void {
    // CASE selector must be ANY_INT, ANY_BIT, or enum (IEC 61131-3: ordinal types)
    if (
      !_isTypeInCategory(selectorType, "ANY_INT") &&
      !_isTypeInCategory(selectorType, "ANY_BIT") &&
      selectorType.typeKind !== "enum"
    ) {
      this.addError(
        `CASE selector must be an integer, bit, or enum type, got ${typeNameUtil(selectorType)}`,
        selectorExpr.sourceSpan.startLine,
        selectorExpr.sourceSpan.startCol,
        selectorExpr.sourceSpan.file,
      );
    }
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

    // Validate argument types against parameter constraints. Strip EN/ENO
    // first — they're handled by the codegen wrapper and don't map onto the
    // declared signature, so leaving them in would shift positional indices
    // and the param at slot 0 would be type-checked against EN's BOOL.
    const userArgs = stripEnEno(expr.arguments);
    for (let i = 0; i < userArgs.length && i < desc.params.length; i++) {
      const arg = userArgs[i]!;
      const param = desc.params[i]!;
      const argType = arg.value.resolvedType;

      if (!argType || argType.typeKind !== "elementary") continue;

      const argTypeName = (argType as ElementaryType).name;

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
                `Argument '${param.name}' of '${nameUpper}' expects ${param.specificType}, got ${argTypeName} (narrowing)`,
                arg.value.sourceSpan.startLine,
                arg.value.sourceSpan.startCol,
                arg.value.sourceSpan.file,
              );
            } else {
              this.addError(
                `Argument '${param.name}' of '${nameUpper}' expects ${param.specificType}, got ${argTypeName}`,
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
            `Argument '${param.name}' of '${nameUpper}' expects ${param.constraint}, got ${argTypeName}`,
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

  /** `--strict`: END_IF, END_CASE, END_FOR, END_WHILE and END_REPEAT need a `;`. */
  private checkStrictTerminator(stmt: {
    unterminated?: UnterminatedEnd;
  }): void {
    if (!this.strict || !stmt.unterminated) return;
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
    if (!this.stdRegistry || this.findUserFunction(expr.functionName)) {
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
      ? kind === "int" || kind === "real"
      : k === "REAL"
        ? kind === "real"
        : kind === "bool";
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
        `An integer cannot be used as ${t}; write a TIME literal such as T#100ms`,
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
