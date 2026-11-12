// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Built-in operators beyond IEC 61131-3, each enabled by a dialect feature:
 *
 * - `__ISVALIDREF(r)` (feature reference_to): TRUE when the REFERENCE TO
 *   variable `r` is bound.
 * - `XSIZEOF(x)` (feature vendor_operators): the size of `x` in bytes, as
 *   SIZEOF gives it, of the pointer-sized unsigned type (ULINT on the 64-bit
 *   target).
 *
 * A POU, variable or FUNCTION of the same name wins, and with the feature off
 * the name means what it meant before. See docs/DIALECTS.md.
 */

import type { FeatureId } from "../dialect.js";
import type {
  FunctionCallExpression,
  VendorOperator,
} from "../frontend/ast.js";

/** The feature each operator needs. */
const OPERATOR_FEATURES: ReadonlyMap<string, FeatureId> = new Map<
  VendorOperator,
  FeatureId
>([
  ["__ISVALIDREF", "reference_to"],
  ["XSIZEOF", "vendor_operators"],
]);

/** The operator an upper-case call name spells, if any. */
export function vendorOperatorNamed(
  nameUpper: string,
): VendorOperator | undefined {
  return OPERATOR_FEATURES.has(nameUpper)
    ? (nameUpper as VendorOperator)
    : undefined;
}

/** The dialect feature an operator needs. */
export function vendorOperatorFeature(op: VendorOperator): FeatureId {
  return OPERATOR_FEATURES.get(op)!;
}

/** The elementary result type of an operator. */
export function vendorOperatorResultType(op: VendorOperator): string {
  return op === "XSIZEOF" ? "ULINT" : "BOOL";
}

/**
 * The error for a call of `op` whose arguments do not fit, or undefined.
 * `isReferenceTo` is true for a REFERENCE TO variable, else says what the argument is.
 */
export function vendorOperatorArgumentError(
  expr: FunctionCallExpression,
  op: VendorOperator,
  isReferenceTo: (
    arg: FunctionCallExpression["arguments"][number],
  ) => true | string,
): string | undefined {
  const args = expr.arguments;
  if (args.length !== 1) {
    return `${op} takes one argument, got ${args.length}`;
  }
  if (args[0]!.name !== undefined || args[0]!.isOutput) {
    return `${op} takes its argument without a name`;
  }
  if (op === "__ISVALIDREF") {
    const found = isReferenceTo(args[0]!);
    if (found !== true) return `${op} needs a REFERENCE TO variable; ${found}`;
  }
  return undefined;
}

/** The C++ of an operator call; `arg` is its argument (the reference itself for `__ISVALIDREF`). */
export function vendorOperatorCpp(op: VendorOperator, arg: string): string {
  return op === "XSIZEOF"
    ? `static_cast<IEC_ULINT>(IEC_SIZEOF(${arg}))`
    : `(!(${arg}).is_null())`;
}
