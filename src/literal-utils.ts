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
