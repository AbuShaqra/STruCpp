// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Fold the global constants a STRUCT field default names into the default.
 *
 * A STRUCT type is emitted before the globals, so a field default naming a
 * global does not compile. A field default is a constant expression (Ed. 3
 * 6.4.4.2): a VAR_GLOBAL CONSTANT, plain or qualified by its global variable
 * list, is replaced by its initial value, itself folded; a caller-supplied
 * constant by its value. A global that is not a constant is an error.
 */

import type {
  CompilationUnit,
  Expression,
  LiteralExpression,
  VarBlock,
  VariableExpression,
} from "../frontend/ast.js";
import type { CompileError } from "../types.js";

/** The global variables a field default may name, by upper-case name. */
interface Globals {
  /** A constant's initial value; null when it has none. */
  constants: Map<string, Expression | null>;
  /** Names of the globals that are not constants. */
  variables: Set<string>;
  /** Upper-case names of the global variable lists. */
  lists: Set<string>;
}

function collect(blocks: readonly VarBlock[], into: Globals): void {
  for (const block of blocks) {
    if (block.blockType !== "VAR_GLOBAL") continue;
    if (block.globalListName !== undefined) {
      into.lists.add(block.globalListName.toUpperCase());
    }
    for (const decl of block.declarations) {
      for (const name of decl.names) {
        const upper = name.toUpperCase();
        if (block.isConstant) {
          into.constants.set(upper, decl.initialValue ?? null);
        } else {
          into.variables.add(upper);
        }
      }
    }
  }
}

/** The global a plain or list-qualified name refers to, upper case. */
function globalName(
  expr: VariableExpression,
  globals: Globals,
): string | undefined {
  if (expr.subscripts.length > 0 || expr.isDereference) return undefined;
  if (expr.fieldAccess.length === 0) return expr.name.toUpperCase();
  if (
    expr.fieldAccess.length === 1 &&
    globals.lists.has(expr.name.toUpperCase())
  ) {
    return (expr.fieldAccess[0] ?? "").toUpperCase();
  }
  return undefined;
}

class Folder {
  private readonly evaluating = new Set<string>();
  /** The fields of the STRUCT being folded: a bare name naming one is no global. */
  shadowed: ReadonlySet<string> = new Set();

  constructor(
    private readonly globals: Globals,
    private readonly supplied: Readonly<Record<string, number>>,
    private readonly errors: CompileError[],
  ) {}

  /** `expr` with every global constant it names replaced by its value. */
  fold(expr: Expression, field: string): Expression {
    switch (expr.kind) {
      case "VariableExpression": {
        const name = globalName(expr, this.globals);
        if (name === undefined) return expr;
        if (expr.fieldAccess.length === 0 && this.shadowed.has(name)) {
          return expr;
        }
        const value = this.constant(name, expr, field);
        return value ?? expr;
      }
      case "ParenthesizedExpression":
        return { ...expr, expression: this.fold(expr.expression, field) };
      case "UnaryExpression":
        return { ...expr, operand: this.fold(expr.operand, field) };
      case "BinaryExpression":
        return {
          ...expr,
          left: this.fold(expr.left, field),
          right: this.fold(expr.right, field),
        };
      case "FunctionCallExpression":
        return {
          ...expr,
          arguments: expr.arguments.map((a) => ({
            ...a,
            value: this.fold(a.value, field),
          })),
        };
      case "ArrayLiteralExpression":
        return {
          ...expr,
          elements: expr.elements.map((e) => this.fold(e, field)),
        };
      case "StructInitializerExpression":
        return {
          ...expr,
          elements: expr.elements.map((e) => ({
            ...e,
            value: this.fold(e.value, field),
          })),
        };
      default:
        return expr;
    }
  }

  /** The folded value of global `name`; undefined when it is no constant. */
  private constant(
    name: string,
    at: VariableExpression,
    field: string,
  ): Expression | undefined {
    const entry = this.globals.constants.get(name);
    if (entry !== undefined) {
      if (entry === null || this.evaluating.has(name)) return undefined;
      this.evaluating.add(name);
      const folded = this.fold(entry, field);
      this.evaluating.delete(name);
      return {
        kind: "ParenthesizedExpression",
        sourceSpan: at.sourceSpan,
        expression: { ...folded, sourceSpan: at.sourceSpan },
      };
    }
    const supplied = Object.entries(this.supplied).find(
      ([key]) => key.toUpperCase() === name,
    );
    if (supplied !== undefined) {
      const literal: LiteralExpression = {
        kind: "LiteralExpression",
        sourceSpan: at.sourceSpan,
        literalType: "INT",
        value: supplied[1],
        rawValue: String(supplied[1]),
      };
      return literal;
    }
    if (this.globals.variables.has(name)) {
      this.errors.push({
        message: `The default of STRUCT field '${field}' must be a constant expression: '${name}' is a global variable, not a constant`,
        line: at.sourceSpan.startLine,
        column: at.sourceSpan.startCol,
        severity: "error",
        ...(at.sourceSpan.file !== undefined
          ? { file: at.sourceSpan.file }
          : {}),
      });
    }
    return undefined;
  }
}

/**
 * Fold the global constants in the field defaults of every STRUCT of `unit`.
 * Mutates `unit`. Returns one error per global variable a default names.
 */
export function foldStructFieldDefaults(
  unit: CompilationUnit,
  supplied: Readonly<Record<string, number>> = {},
): CompileError[] {
  const globals: Globals = {
    constants: new Map(),
    variables: new Set(),
    lists: new Set(),
  };
  collect(unit.globalVarBlocks, globals);
  for (const config of unit.configurations) collect(config.varBlocks, globals);
  const errors: CompileError[] = [];
  const folder = new Folder(globals, supplied, errors);
  for (const type of unit.types) {
    if (type.definition.kind !== "StructDefinition") continue;
    // A default may name another field of the STRUCT: that is no global.
    const fields = new Set(
      type.definition.fields.flatMap((f) =>
        f.names.map((n) => n.toUpperCase()),
      ),
    );
    folder.shadowed = fields;
    for (const field of type.definition.fields) {
      // A POINTER TO / REF_TO / REFERENCE TO default is refused by the type checker.
      if (
        field.initialValue === undefined ||
        field.type.referenceKind !== "none" ||
        field.type.referenceChain !== undefined
      ) {
        continue;
      }
      const name = `${type.name}.${field.names[0] ?? ""}`.toUpperCase();
      field.initialValue = folder.fold(field.initialValue, name);
    }
  }
  return errors;
}
