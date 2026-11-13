// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * NOT of an untyped integer constant takes its type from where it is used:
 * into a BYTE, WORD, DWORD or LWORD it is that bit string's complement
 * (`w := NOT 16#00F0` is 16#FF0F); anywhere else it keeps its logical meaning.
 */

import type { Expression } from "../frontend/ast.js";
import { ELEMENTARY_TYPES } from "./type-utils.js";

const BIT_STRINGS: ReadonlySet<string> = new Set([
  "BYTE",
  "WORD",
  "DWORD",
  "LWORD",
]);

/** An untyped integer constant, or NOT/AND/OR/XOR of such constants only. */
export function isUntypedIntegerConstant(expr: Expression): boolean {
  switch (expr.kind) {
    case "LiteralExpression":
      return expr.literalType === "INT" && (expr.typePrefix ?? "") === "";
    case "ParenthesizedExpression":
      return isUntypedIntegerConstant(expr.expression);
    case "UnaryExpression":
      return expr.operator === "NOT" && isUntypedIntegerConstant(expr.operand);
    case "BinaryExpression":
      return (
        ["AND", "OR", "XOR"].includes(expr.operator) &&
        isUntypedIntegerConstant(expr.left) &&
        isUntypedIntegerConstant(expr.right)
      );
    case "FunctionCallExpression": {
      const operand = notCallOperand(expr);
      return operand !== undefined && isUntypedIntegerConstant(operand);
    }
    default:
      return false;
  }
}

/** The operand of `NOT (x)`, which parses as a call of NOT; undefined otherwise. */
function notCallOperand(expr: Expression): Expression | undefined {
  if (
    expr.kind !== "FunctionCallExpression" ||
    expr.functionName.toUpperCase() !== "NOT" ||
    expr.arguments.length !== 1 ||
    expr.arguments[0]!.name !== undefined ||
    expr.arguments[0]!.isOutput
  ) {
    return undefined;
  }
  return expr.arguments[0]!.value;
}

/** The operand of a NOT, written `NOT x` or `NOT (x)`. */
function notOperand(expr: Expression): Expression | undefined {
  if (expr.kind === "UnaryExpression" && expr.operator === "NOT") {
    return expr.operand;
  }
  return notCallOperand(expr);
}

/**
 * Type each NOT of an untyped constant in `value` as `target` when `target`
 * (upper case, aliases resolved) is a bit string other than BOOL.
 */
export function typeUntypedNot(value: Expression, target: string): void {
  if (!BIT_STRINGS.has(target)) return;
  const type = ELEMENTARY_TYPES[target];
  if (type === undefined) return;
  const walk = (e: Expression): void => {
    switch (e.kind) {
      case "ParenthesizedExpression":
        walk(e.expression);
        return;
      case "UnaryExpression":
      case "FunctionCallExpression": {
        const operand = notOperand(e);
        if (operand !== undefined && isUntypedIntegerConstant(operand)) {
          e.resolvedType = type;
          walk(operand);
        }
        return;
      }
      case "BinaryExpression":
        if (["AND", "OR", "XOR"].includes(e.operator)) {
          walk(e.left);
          walk(e.right);
        }
        return;
      default:
        return;
    }
  };
  walk(value);
}

/** The bit string a NOT node was typed as by `typeUntypedNot`, if any. */
export function untypedNotTarget(expr: Expression): string | undefined {
  const operand = notOperand(expr);
  if (operand === undefined) return undefined;
  const t = expr.resolvedType;
  if (t?.typeKind !== "elementary" || !("name" in t)) return undefined;
  const name = String(t.name).toUpperCase();
  return BIT_STRINGS.has(name) && isUntypedIntegerConstant(operand)
    ? name
    : undefined;
}
