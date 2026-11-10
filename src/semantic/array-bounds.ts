// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Resolve the bounds of every ARRAY to integers before analysis.
 *
 * A bound is an integer constant expression: literals, constants (a POU's
 * VAR CONSTANT, a VAR_GLOBAL CONSTANT of any file, a caller-supplied global
 * constant), enumeration values and `+ - * / MOD` on them. The AST builder
 * resolves what one POU can know while it is built; this pass runs on the
 * merged unit and resolves the rest, for named array types and for arrays
 * written inline. A bound it cannot resolve is an error.
 */

import type {
  CompilationUnit,
  Expression,
  TypeReference,
  VarBlock,
} from "../frontend/ast.js";
import type { CompileError } from "../types.js";
import { walkAST } from "../ast-utils.js";

/** A value, or the name that is not a constant. */
type Evaluated = { value: number } | { unknown: string };

/** Constants by upper-case name; a lazy entry is evaluated on first use. */
type Constants = Map<string, number | Expression | null>;

class BoundResolver {
  private readonly globals: Constants = new Map();
  /** `TYPE.MEMBER` → value. */
  private readonly enumValues = new Map<string, number>();
  /** Bare member → value, or null when several enumerations declare it. */
  private readonly bareMembers = new Map<string, number | null>();
  private readonly enumNames = new Set<string>();
  private locals: Constants = new Map();
  private readonly evaluating = new Set<string>();

  constructor(
    ast: CompilationUnit,
    supplied: Readonly<Record<string, number>>,
  ) {
    for (const [name, value] of Object.entries(supplied)) {
      this.globals.set(name.toUpperCase(), value);
    }
    this.addConstants(ast.globalVarBlocks, this.globals);
    for (const type of ast.types) {
      if (type.definition.kind !== "EnumDefinition") continue;
      const typeUpper = type.name.toUpperCase();
      this.enumNames.add(typeUpper);
      let next = 0;
      for (const member of type.definition.members) {
        const explicit = member.value ? this.evaluate(member.value) : undefined;
        const value =
          explicit !== undefined && "value" in explicit ? explicit.value : next;
        next = value + 1;
        const upper = member.name.toUpperCase();
        this.enumValues.set(`${typeUpper}.${upper}`, value);
        this.bareMembers.set(upper, this.bareMembers.has(upper) ? null : value);
      }
    }
  }

  private addConstants(blocks: readonly VarBlock[], into: Constants): void {
    for (const block of blocks) {
      if (!block.isConstant) continue;
      for (const decl of block.declarations) {
        for (const name of decl.names) {
          into.set(name.toUpperCase(), decl.initialValue ?? null);
        }
      }
    }
  }

  /** Use the VAR CONSTANTs of `blocks` (a POU and its method) until the next call. */
  enter(blocks: readonly VarBlock[]): void {
    this.locals = new Map();
    this.addConstants(blocks, this.locals);
  }

  private constant(name: string): Evaluated {
    const upper = name.toUpperCase();
    for (const table of [this.locals, this.globals]) {
      const entry = table.get(upper);
      if (entry === undefined) continue;
      if (typeof entry === "number") return { value: entry };
      if (entry === null || this.evaluating.has(upper))
        return { unknown: upper };
      this.evaluating.add(upper);
      const result = this.evaluate(entry);
      this.evaluating.delete(upper);
      if ("value" in result) table.set(upper, result.value);
      return "value" in result ? result : { unknown: upper };
    }
    const member = this.bareMembers.get(upper);
    return typeof member === "number" ? { value: member } : { unknown: upper };
  }

  evaluate(expr: Expression): Evaluated {
    switch (expr.kind) {
      case "LiteralExpression": {
        const value = Number(expr.value);
        return expr.literalType === "INT" && Number.isInteger(value)
          ? { value }
          : { unknown: String(expr.rawValue ?? expr.value) };
      }
      case "ParenthesizedExpression":
        return this.evaluate(expr.expression);
      case "UnaryExpression": {
        const operand = this.evaluate(expr.operand);
        if ("unknown" in operand) return operand;
        if (expr.operator === "-") return { value: -operand.value };
        if (expr.operator === "+") return operand;
        return { unknown: expr.operator };
      }
      case "BinaryExpression": {
        const left = this.evaluate(expr.left);
        if ("unknown" in left) return left;
        const right = this.evaluate(expr.right);
        if ("unknown" in right) return right;
        const [l, r] = [left.value, right.value];
        switch (expr.operator) {
          case "+":
            return { value: l + r };
          case "-":
            return { value: l - r };
          case "*":
            return { value: l * r };
          case "/":
            return r === 0 ? { unknown: "/ 0" } : { value: Math.trunc(l / r) };
          case "MOD":
            return r === 0 ? { unknown: "MOD 0" } : { value: l % r };
          default:
            return { unknown: expr.operator };
        }
      }
      case "VariableExpression": {
        if (expr.subscripts.length > 0 || expr.isDereference) {
          return { unknown: expr.name.toUpperCase() };
        }
        if (expr.fieldAccess.length === 0) return this.constant(expr.name);
        const head = expr.name.toUpperCase();
        const member = (expr.fieldAccess[0] ?? "").toUpperCase();
        const dotted = `${head}.${member}`;
        if (expr.fieldAccess.length !== 1) return { unknown: dotted };
        if (this.enumNames.has(head)) {
          const value = this.enumValues.get(dotted);
          return value === undefined ? { unknown: dotted } : { value };
        }
        // `LIST.K`: a constant of a global variable list
        const listed = this.constant(member);
        return "value" in listed ? listed : { unknown: dotted };
      }
      default:
        return { unknown: "the expression" };
    }
  }
}

/**
 * Give every ARRAY of `unit` integer bounds. Mutates `unit`. `supplied` are
 * the caller's global constants. Returns one error per bound that is not a
 * constant.
 */
export function resolveArrayBounds(
  unit: CompilationUnit,
  supplied: Readonly<Record<string, number>> = {},
): CompileError[] {
  const errors: CompileError[] = [];
  const resolver = new BoundResolver(unit, supplied);
  const bound = (expr: Expression): number | undefined => {
    const result = resolver.evaluate(expr);
    if ("value" in result) return result.value;
    errors.push({
      message: `The bounds of an ARRAY must be integer constants: '${result.unknown}' is not a constant`,
      line: expr.sourceSpan.startLine,
      column: expr.sourceSpan.startCol,
      severity: "error",
      ...(expr.sourceSpan.file !== undefined
        ? { file: expr.sourceSpan.file }
        : {}),
    });
    return undefined;
  };
  const literal = (expr: Expression, value: number): Expression => ({
    kind: "LiteralExpression",
    sourceSpan: expr.sourceSpan,
    literalType: "INT",
    value,
    rawValue: String(value),
  });
  const inline = (type: TypeReference): void => {
    const pending = type.unresolvedArray;
    if (pending === undefined) return;
    delete type.unresolvedArray;
    const dims: Array<{ start: number; end: number }> = [];
    for (const dim of pending.dimensions) {
      const start = bound(dim.start);
      const end = bound(dim.end);
      if (start === undefined || end === undefined) return;
      dims.push({ start, end });
    }
    type.arrayDimensions = dims;
    type.elementTypeName = pending.elementTypeName;
  };
  const visit = (root: Parameters<typeof walkAST>[0]): void => {
    walkAST(root, (node) => {
      if (node.kind === "TypeReference") inline(node as TypeReference);
    });
  };

  resolver.enter([]);
  for (const type of unit.types) {
    const def = type.definition;
    if (def.kind === "ArrayDefinition") {
      for (const dim of def.dimensions) {
        if (dim.isVariableLength || !dim.start || !dim.end) continue;
        const start = bound(dim.start);
        const end = bound(dim.end);
        if (start !== undefined) dim.start = literal(dim.start, start);
        if (end !== undefined) dim.end = literal(dim.end, end);
      }
    }
    visit(type);
  }
  for (const block of unit.globalVarBlocks) visit(block);
  for (const fn of unit.functions) {
    resolver.enter(fn.varBlocks);
    visit(fn);
  }
  for (const pou of [...unit.programs, ...unit.functionBlocks]) {
    for (const method of pou.methods) {
      resolver.enter([...pou.varBlocks, ...method.varBlocks]);
      visit(method);
    }
    resolver.enter(pou.varBlocks);
    visit(pou);
  }
  // Interfaces, configurations and anything else: global constants only.
  resolver.enter([]);
  visit(unit);
  return errors;
}
