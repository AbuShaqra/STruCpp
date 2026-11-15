// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * An address stored into an integer: `ADR(x)`, `ADR(x) ± n` and `REF(x)` are
 * 64-bit addresses, which an integer narrower than 64 bits, or a type that is
 * no integer, cannot hold.
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

/**
 * Standard functions whose result is one of their arguments: the index of
 * the first argument that can be the result.
 */
const PASS_THROUGH: Readonly<Record<string, number>> = {
  SEL: 1,
  MUX: 1,
  MOVE: 0,
  MIN: 0,
  MAX: 0,
  LIMIT: 0,
};

/**
 * `value` when it is an address: `ADR(x)`, `REF(x)`, `ADR(x) + n`,
 * `n + ADR(x)`, `ADR(x) - n`, or one passed through `SEL`, `MUX`, `MOVE`,
 * `MIN`, `MAX` or `LIMIT` (unless `userFunction` says the source declares a
 * FUNCTION of that name).
 */
export function addressSource(
  value: Expression,
  userFunction: (name: string) => boolean = () => false,
): AddressSource | undefined {
  switch (value.kind) {
    case "ParenthesizedExpression":
      return addressSource(value.expression, userFunction);
    case "RefExpression":
      return { op: "REF", node: value, operand: value.operand };
    case "FunctionCallExpression": {
      if (value.instance !== undefined) return undefined;
      const name = value.functionName.toUpperCase();
      if (name === "ADR") {
        return {
          op: "ADR",
          node: value,
          operand: stripEnEno(value.arguments)[0]?.value,
        };
      }
      const first = PASS_THROUGH[name];
      if (first === undefined || userFunction(name)) return undefined;
      for (const arg of stripEnEno(value.arguments).slice(first)) {
        if (arg.isOutput) continue;
        const source = addressSource(arg.value, userFunction);
        if (source) return source;
      }
      return undefined;
    }
    case "BinaryExpression":
      if (value.operator === "+") {
        return (
          addressSource(value.left, userFunction) ??
          addressSource(value.right, userFunction)
        );
      }
      // ADR(x) - n is an address; ADR(x) - ADR(y) is a difference, an integer.
      return value.operator === "-" &&
        addressSource(value.right, userFunction) === undefined
        ? addressSource(value.left, userFunction)
        : undefined;
    default:
      return undefined;
  }
}

/** Comparisons: an address compared stays a valid operand. */
const COMPARISONS = new Set(["=", "<>", "<", ">", "<=", ">="]);

/**
 * An address used where only an offset by + or - an integer keeps it an
 * address, at any depth: `ADR(x) * 2`, `4 - ADR(x)`, `ADR(x) + ADR(y)`,
 * `-ADR(x)`, `NOT ADR(x)`, `ADR(x) OR 0`, `(ADR(x) * 2) + 1`.
 */
export function addressMisuse(
  value: Expression,
  userFunction: (name: string) => boolean = () => false,
): boolean {
  const misuse = (e: Expression): boolean => addressMisuse(e, userFunction);
  const isAddress = (e: Expression): boolean =>
    addressSource(e, userFunction) !== undefined;
  switch (value.kind) {
    case "ParenthesizedExpression":
      return misuse(value.expression);
    case "UnaryExpression":
      return isAddress(value.operand) || misuse(value.operand);
    case "BinaryExpression": {
      if (misuse(value.left) || misuse(value.right)) return true;
      if (COMPARISONS.has(value.operator)) return false;
      const left = isAddress(value.left);
      const right = isAddress(value.right);
      if (value.operator === "+") return left && right;
      if (value.operator === "-") return right && !left;
      return left || right;
    }
    default:
      return false;
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

/** Elementary types that are no integer, which hold no address at any width. */
const NOT_INTEGER = new Set([
  "BOOL",
  "REAL",
  "LREAL",
  "TIME",
  "LTIME",
  "DATE",
  "LDATE",
  "TOD",
  "TIME_OF_DAY",
  "LTOD",
  "LTIME_OF_DAY",
  "DT",
  "DATE_AND_TIME",
  "LDT",
  "LDATE_AND_TIME",
  "CHAR",
  "WCHAR",
  "STRING",
  "WSTRING",
]);

/** Integer types as wide as an address (PVOID and XWORD lower to __XWORD). */
const WIDE = new Set(["LINT", "ULINT", "LWORD", "__XWORD"]);

/**
 * How an address fits `typeName`, through TYPE aliases and subranges: the
 * base type it does not fit (an integer narrower than 64 bits, or an
 * elementary type that is no integer), "wide" when it fits an integer, or
 * undefined for any other type.
 */
export function addressFit(
  typeName: string,
  types: readonly TypeDeclaration[],
): { narrow: string } | "wide" | undefined {
  let name = typeName.toUpperCase();
  for (let depth = 0; depth < 16; depth++) {
    if (NARROW.has(name) || NOT_INTEGER.has(name)) return { narrow: name };
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

/** An integer type narrower than an address, by upper-case base name (see addressFit). */
export function isNarrowInteger(baseName: string): boolean {
  return NARROW.has(baseName);
}

/** The refusal of an address stored into a narrow integer. */
export function narrowAddressMessage(what: string, narrow: string): string {
  return `${what} gives a 64-bit address, which ${narrow} cannot hold; use a POINTER TO or PVOID, or __XWORD, LWORD or ULINT`;
}
