// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * Exact handling of IEC 61131-3 integer literals.
 *
 * LINT and ULINT span the full 64 bits, which a JS `number` cannot represent:
 * `9007199254740993` parses as ...992, and `18446744073709551615` rounds past
 * the type's own maximum. Anything that has to agree with the source digits —
 * codegen's lowering, the analyzer's range check — works from the `bigint` here
 * rather than from the parsed `number` on the AST node.
 *
 * Lives at the root rather than under `backend/` or `semantic/` because both
 * layers need it and neither should depend on the other for it.
 */

import type { Expression } from "./frontend/ast.js";

import { cp1252Byte } from "./byte-utils.js";

/** Widest value any IEC 61131-3 integer type (ULINT) can hold. */
export const IEC_INTEGER_MAX = 18446744073709551615n;

/** Narrowest value any IEC 61131-3 integer type (LINT) can hold. */
export const IEC_INTEGER_MIN = -9223372036854775808n;

/**
 * Exact value of an IEC integer literal, or undefined when `raw` is not one.
 *
 * Accepts the based forms (16#FF, 8#77, 2#1010), a plain decimal, an optional
 * sign, and IEC underscore separators. A typed prefix (`INT#5`) must be
 * stripped by the caller — only the value part is parsed here.
 */
export function exactIntegerLiteralValue(raw: string): bigint | undefined {
  const upper = raw.trim().toUpperCase().replace(/_/g, "");
  const sign = upper.startsWith("-") ? -1n : 1n;
  const digits = /^[+-]/.test(upper) ? upper.slice(1) : upper;
  let normalized: string;
  if (/^16#[0-9A-F]+$/.test(digits)) normalized = "0x" + digits.slice(3);
  else if (/^8#[0-7]+$/.test(digits)) normalized = "0o" + digits.slice(2);
  else if (/^2#[01]+$/.test(digits)) normalized = "0b" + digits.slice(2);
  else if (/^[0-9]+$/.test(digits)) normalized = digits;
  else return undefined;
  try {
    return sign * BigInt(normalized);
  } catch {
    return undefined;
  }
}

/** Bit width of each IEC 61131-3 integer type, keyed by upper-case name. */
const INTEGER_TYPE_BITS: Readonly<Record<string, number>> = {
  SINT: 8,
  INT: 16,
  DINT: 32,
  LINT: 64,
  USINT: 8,
  UINT: 16,
  UDINT: 32,
  ULINT: 64,
};

/**
 * Inclusive value range of an IEC integer type (`SINT` → [-128, 127]), or
 * undefined when `typeName` is not one.
 */
export function integerTypeRange(
  typeName: string,
): { min: bigint; max: bigint } | undefined {
  const name = typeName.toUpperCase();
  const bits = INTEGER_TYPE_BITS[name];
  if (bits === undefined) return undefined;
  if (name.startsWith("U")) return { min: 0n, max: (1n << BigInt(bits)) - 1n };
  const half = 1n << BigInt(bits - 1);
  return { min: -half, max: half - 1n };
}

/**
 * The characters of a typed character literal (`CHAR#'A'`, `WCHAR#"$20AC"`),
 * after its `$` escapes: Windows-1252 bytes for CHAR (-1 for a character that
 * encoding lacks), UTF-16 code units for WCHAR.
 */
export function charLiteralUnits(raw: string): {
  wide: boolean;
  units: number[];
} {
  const wide = /^W/i.test(raw);
  const payload = raw.slice(raw.indexOf("#") + 1);
  // A code: CHAR#16#41, WCHAR#8364 (-1 when it is past the type's range)
  if (!payload.startsWith("'") && !payload.startsWith('"')) {
    const code = exactIntegerLiteralValue(payload);
    const max = wide ? 0xffffn : 0xffn;
    return {
      wide,
      units: [code !== undefined && code <= max ? Number(code) : -1],
    };
  }
  const quote = payload[0]!;
  const inner = payload.slice(1, payload.lastIndexOf(quote));
  const units: number[] = [];
  const escapes: Record<string, number> = {
    N: 10,
    L: 10,
    R: 13,
    T: 9,
    P: 12,
    $: 36,
    "'": 39,
    '"': 34,
  };
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch === "$" && i + 1 < inner.length) {
      const hexLen = wide ? 4 : 2;
      const hex = inner.substring(i + 1, i + 1 + hexLen);
      if (new RegExp(`^[0-9A-Fa-f]{${hexLen}}$`).test(hex)) {
        units.push(parseInt(hex, 16));
        i += hexLen;
        continue;
      }
      const code = escapes[inner[i + 1]!.toUpperCase()];
      if (code !== undefined) {
        units.push(code);
        i++;
        continue;
      }
    }
    if (ch === quote && inner[i + 1] === quote) {
      units.push(quote.charCodeAt(0));
      i++;
      continue;
    }
    if (wide) {
      units.push(ch.charCodeAt(0));
    } else {
      const cp = inner.codePointAt(i)!;
      if (cp > 0xffff) i++;
      units.push(cp1252Byte(cp) ?? -1);
    }
  }
  return { wide, units };
}

/** An integer constant written as a literal (typed, signed or in parentheses): its exact value. */
export function exactIntegerValue(expr: Expression): bigint | undefined {
  if (expr.kind === "ParenthesizedExpression") {
    return exactIntegerValue(expr.expression);
  }
  if (expr.kind === "UnaryExpression" && expr.operator === "-") {
    const inner = exactIntegerValue(expr.operand);
    return inner === undefined ? undefined : -inner;
  }
  if (expr.kind !== "LiteralExpression" || expr.literalType !== "INT") {
    return undefined;
  }
  const typed =
    expr.rawValue.includes("#") && !/^(16|8|2)#/.test(expr.rawValue);
  const raw = typed
    ? expr.rawValue.slice(expr.rawValue.indexOf("#") + 1)
    : expr.rawValue;
  const value = exactIntegerLiteralValue(raw);
  if (!typed || value === undefined || !/^(16|8|2)#/.test(raw)) return value;
  // A based literal of a signed type is its bit pattern: SINT#16#FF is -1
  const type = expr.rawValue.slice(0, expr.rawValue.indexOf("#")).toUpperCase();
  const range = integerTypeRange(type);
  const bits = INTEGER_TYPE_BITS[type];
  if (range === undefined || bits === undefined || range.min >= 0n)
    return value;
  return value > range.max ? value - (1n << BigInt(bits)) : value;
}

/**
 * The exact value of an untyped integer constant expression (untyped literals,
 * parentheses, unary +/- and + - * /), and whether it or any part of it lies
 * outside DINT. Undefined for anything else, or a division by 0.
 */
export function untypedIntegerConstant(
  expr: Expression,
): { value: bigint; pastDint: boolean } | undefined {
  const outside = (v: bigint): boolean => v > 2147483647n || v < -2147483648n;
  switch (expr.kind) {
    case "LiteralExpression": {
      if (expr.literalType !== "INT" || (expr.typePrefix ?? "") !== "") {
        return undefined;
      }
      const value = exactIntegerLiteralValue(expr.rawValue);
      return value === undefined
        ? undefined
        : { value, pastDint: outside(value) };
    }
    case "ParenthesizedExpression":
      return untypedIntegerConstant(expr.expression);
    case "UnaryExpression": {
      if (expr.operator !== "-" && expr.operator !== "+") return undefined;
      const inner = untypedIntegerConstant(expr.operand);
      if (inner === undefined) return undefined;
      const value = expr.operator === "-" ? -inner.value : inner.value;
      return { value, pastDint: inner.pastDint || outside(value) };
    }
    case "BinaryExpression": {
      const l = untypedIntegerConstant(expr.left);
      const r = untypedIntegerConstant(expr.right);
      if (l === undefined || r === undefined) return undefined;
      let value: bigint;
      switch (expr.operator) {
        case "+":
          value = l.value + r.value;
          break;
        case "-":
          value = l.value - r.value;
          break;
        case "*":
          value = l.value * r.value;
          break;
        case "/":
          if (r.value === 0n) return undefined;
          value = l.value / r.value;
          break;
        default:
          return undefined;
      }
      return { value, pastDint: l.pastDint || r.pastDint || outside(value) };
    }
    default:
      return undefined;
  }
}
