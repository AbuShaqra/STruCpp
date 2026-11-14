// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * An address stored into an integer: `ADR(x)`, `ADR(x) ± n` and `REF(x)` are
 * 64-bit addresses, which an integer narrower than 64 bits cannot hold.
 */

import type {
  Expression,
  FunctionCallExpression,
  RefExpression,
  TypeDeclaration,
} from "../frontend/ast.js";
import { stripEnEno } from "../ast-utils.js";

/** The ADR or REF an address-valued expression takes its address from. */
export interface AddressSource {
  op: "ADR" | "REF";
  node: FunctionCallExpression | RefExpression;
  operand: Expression | undefined;
}

/** `value` when it is an address: `ADR(x)`, `REF(x)`, `ADR(x) + n`, `n + ADR(x)`, `ADR(x) - n`. */
export function addressSource(value: Expression): AddressSource | undefined {
  switch (value.kind) {
    case "ParenthesizedExpression":
      return addressSource(value.expression);
    case "RefExpression":
      return { op: "REF", node: value, operand: value.operand };
    case "FunctionCallExpression":
      return value.functionName.toUpperCase() === "ADR" &&
        value.instance === undefined
        ? {
            op: "ADR",
            node: value,
            operand: stripEnEno(value.arguments)[0]?.value,
          }
        : undefined;
    case "BinaryExpression":
      if (value.operator === "+") {
        return addressSource(value.left) ?? addressSource(value.right);
      }
      return value.operator === "-" ? addressSource(value.left) : undefined;
    default:
      return undefined;
  }
}

/** Integer and bit-string types narrower than an address, by upper-case name. */
const NARROW = new Set([
  "SINT",
  "USINT",
  "BYTE",
  "INT",
  "UINT",
  "WORD",
  "DINT",
  "UDINT",
  "DWORD",
]);

/** Integer types as wide as an address (PVOID and XWORD lower to __XWORD). */
const WIDE = new Set(["LINT", "ULINT", "LWORD", "__XWORD"]);

/**
 * How an address fits `typeName`, through TYPE aliases and subranges: the
 * narrow base type it does not fit, "wide" when it fits an integer, or
 * undefined for any other type.
 */
export function addressFit(
  typeName: string,
  types: readonly TypeDeclaration[],
): { narrow: string } | "wide" | undefined {
  let name = typeName.toUpperCase();
  for (let depth = 0; depth < 16; depth++) {
    if (NARROW.has(name)) return { narrow: name };
    if (WIDE.has(name)) return "wide";
    const def = types.find((t) => t.name.toUpperCase() === name)?.definition;
    if (def?.kind === "SubrangeDefinition") {
      name = def.baseType.name.toUpperCase();
    } else if (
      def?.kind === "TypeReference" &&
      (def.referenceKind ?? "none") === "none" &&
      def.arrayDimensions === undefined
    ) {
      name = def.name.toUpperCase();
    } else {
      return undefined;
    }
  }
  return undefined;
}

/** The refusal of an address stored into a narrow integer. */
export function narrowAddressMessage(what: string, narrow: string): string {
  return `${what} gives a 64-bit address, which ${narrow} cannot hold; use a POINTER TO or PVOID, or __XWORD, LWORD or ULINT`;
}
