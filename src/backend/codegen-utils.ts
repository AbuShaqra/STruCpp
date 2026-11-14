// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * Shared utility functions for C++ code generation.
 */

import type {
  ElementaryType,
  Expression,
  LiteralExpression,
} from "../frontend/ast.js";
import { exactIntegerLiteralValue } from "../literal-utils.js";
import { cp1252Byte } from "../byte-utils.js";

const COMPARISON_OPERATORS: ReadonlySet<string> = new Set([
  "=",
  "<>",
  "<",
  ">",
  "<=",
  ">=",
]);

/** True for the six ST comparison operators. */
export function isComparison(operator: string): boolean {
  return COMPARISON_OPERATORS.has(operator);
}

/** True when `expr` is an unparenthesised comparison. */
export function isComparisonExpr(expr: Expression): boolean {
  return expr.kind === "BinaryExpression" && isComparison(expr.operator);
}

/** True for an integer literal other than 0 and -1, such as the `7` of `x MOD 7`. */
export function isNonZeroIntegerLiteral(expr: Expression): boolean {
  return (
    expr.kind === "LiteralExpression" &&
    expr.literalType === "INT" &&
    typeof expr.value === "number" &&
    Number.isInteger(expr.value) &&
    expr.value !== 0 &&
    expr.value !== -1
  );
}

/**
 * A comparison with a STRING (or WSTRING) literal: each literal emitted
 * wrapped as a string value, so C++ compares the text, not pointers. Two
 * literals, or a literal and an operand of the same string type (for `=` and
 * `<>` only a literal on the left of an operand that is no plain variable).
 * Undefined for any other comparison.
 */
export function literalStringComparison(
  left: Expression,
  right: Expression,
  leftCpp: string,
  rightCpp: string,
  operator = "<",
): [string, string] | undefined {
  // `('aa') > ('zz')`: the literals inside the parentheses
  while (left.kind === "ParenthesizedExpression") left = left.expression;
  while (right.kind === "ParenthesizedExpression") right = right.expression;
  const literalKind = (e: Expression): string | undefined =>
    e.kind === "LiteralExpression" &&
    (e.literalType === "STRING" || e.literalType === "WSTRING")
      ? e.literalType
      : undefined;
  const wrap = (kind: string, raw: string, cpp: string): string =>
    `strucpp::${kind === "STRING" ? "IECString" : "IECWString"}<${Math.max(254, raw.length)}>(${cpp})`;
  const lk = literalKind(left);
  const rk = literalKind(right);
  if (lk !== undefined && rk !== undefined) {
    if (lk !== rk) return undefined;
    const len = Math.max(
      254,
      (left as LiteralExpression).rawValue.length,
      (right as LiteralExpression).rawValue.length,
    );
    const type = lk === "STRING" ? "IECString" : "IECWString";
    return [
      `strucpp::${type}<${len}>(${leftCpp})`,
      `strucpp::${type}<${len}>(${rightCpp})`,
    ];
  }
  const kind = lk ?? rk;
  if (kind === undefined) return undefined;
  const other = lk !== undefined ? right : left;
  if (stringKindOf(other) !== kind) return undefined;
  // `=` / `<>` with the literal on the right, or against a variable, already
  // compares the text
  if (
    (operator === "=" || operator === "<>") &&
    (rk !== undefined || other.kind === "VariableExpression")
  ) {
    return undefined;
  }
  return lk !== undefined
    ? [wrap(kind, (left as LiteralExpression).rawValue, leftCpp), rightCpp]
    : [leftCpp, wrap(kind, (right as LiteralExpression).rawValue, rightCpp)];
}

/** STRING or WSTRING when the type checker typed the expression as one. */
function stringKindOf(e: Expression): string | undefined {
  const type = e.resolvedType;
  if (type?.typeKind !== "elementary") return undefined;
  const m = /^(W?STRING)\b/i.exec((type as ElementaryType).name);
  return m === null ? undefined : m[1]!.toUpperCase();
}

/**
 * Convert an IEC 61131-3 based numeric string to a C++ literal string.
 * Handles 16#FF → 0xFF, 8#77 → 077, 2#1010 → 0b1010, and plain decimals.
 * Strips IEC underscore separators.
 */
export function iecBaseToCppLiteral(raw: string): string {
  const upper = raw.toUpperCase().replace(/_/g, "");
  if (upper.startsWith("16#")) return "0x" + upper.slice(3);
  if (upper.startsWith("8#")) return "0" + upper.slice(2);
  if (upper.startsWith("2#")) return "0b" + upper.slice(2);
  return raw.replace(/_/g, "");
}

/** Largest value a C++ *decimal* literal can name without a suffix. */
const CPP_SIGNED_LITERAL_MAX = 9223372036854775807n;

/**
 * Lower an IEC 61131-3 integer literal to a C++ integer literal.
 *
 * Based literals (16#FF, 8#77, 2#1010) keep their notation. Plain decimals are
 * re-emitted from the *exact* value rather than from the parsed `number`, which
 * matters twice over:
 *
 *   - `number` rounds above 2^53, so a LINT/ULINT initializer such as
 *     `9007199254740993` would silently become ...992, and `ULINT` bounds would
 *     round past the type's range into a literal g++ rejects outright.
 *   - passing the raw digits straight through instead would make a leading zero
 *     an octal prefix in C++ (`0010` → 8, `008` → a compile error), so the
 *     digits are normalized rather than copied.
 *
 * A value above `CPP_SIGNED_LITERAL_MAX` gets a `ULL` suffix: a C++ decimal
 * literal is only ever given a *signed* type (C++17 [lex.icon]/3), so without
 * it `18446744073709551615` names no type at all.
 *
 * `value` is the pre-parsed fallback for a literal whose raw text is not a
 * plain integer (synthesized nodes, for one).
 */
export function formatIntegerLiteral(rawValue: string, value: number): string {
  const upper = rawValue.toUpperCase().replace(/_/g, "");
  if (
    upper.startsWith("16#") ||
    upper.startsWith("8#") ||
    upper.startsWith("2#")
  ) {
    return iecBaseToCppLiteral(rawValue);
  }
  const exact = exactIntegerLiteralValue(rawValue);
  if (exact === undefined) return String(value);
  // INT64_MIN has no C++ literal: `-9223372036854775808` negates an unsigned value.
  if (exact < -CPP_SIGNED_LITERAL_MAX)
    return `(-${CPP_SIGNED_LITERAL_MAX}LL - 1)`;
  return exact > CPP_SIGNED_LITERAL_MAX ? `${exact}ULL` : exact.toString();
}

/**
 * Format an array type string from element type and dimension bounds.
 *
 * - 1D → `Array1D<E, start, end>`
 * - 2D → `Array2D<E, s1, e1, s2, e2>`
 * - 3D → `Array3D<E, s1, e1, s2, e2, s3, e3>`
 * - 4+ → nested `Array1D<Array1D<..., s, e>, s, e>`
 */
export function formatArrayType(
  elemCpp: string,
  dimensions: Array<{ start: number; end: number }>,
): string {
  if (dimensions.length === 1) {
    const dim = dimensions[0]!;
    return `Array1D<${elemCpp}, ${dim.start}, ${dim.end}>`;
  }
  if (dimensions.length === 2) {
    const d1 = dimensions[0]!;
    const d2 = dimensions[1]!;
    return `Array2D<${elemCpp}, ${d1.start}, ${d1.end}, ${d2.start}, ${d2.end}>`;
  }
  if (dimensions.length === 3) {
    const d1 = dimensions[0]!;
    const d2 = dimensions[1]!;
    const d3 = dimensions[2]!;
    return `Array3D<${elemCpp}, ${d1.start}, ${d1.end}, ${d2.start}, ${d2.end}, ${d3.start}, ${d3.end}>`;
  }
  // 4+ dimensions: nested Array1D (outermost first)
  let result = elemCpp;
  for (let i = dimensions.length - 1; i >= 0; i--) {
    const dim = dimensions[i]!;
    result = `Array1D<${result}, ${dim.start}, ${dim.end}>`;
  }
  return result;
}

/**
 * Append an unchecked element access for one full set of array indices,
 * matching the container {@link formatArrayType} picked for that rank.
 *
 * `Array1D` subscripts with `operator[]`; `Array2D` / `Array3D` take all indices
 * at once through `operator()`; 4+ dimensions are nested `Array1D`, so they
 * subscript once per dimension. Getting this wrong doesn't just read the wrong
 * element — `arr[i][j]` on an `Array2D` has no matching operator and fails to
 * compile.
 *
 * Unchecked (rather than `.at()`) because these accessors are `constexpr`, which
 * is what lets `&arr[i]` be a constant expression — required for the debug
 * pointer table's PROGMEM placement on AVR.
 */
export function formatArrayElementAccess(
  base: string,
  indices: number[],
): string {
  if (indices.length === 2 || indices.length === 3) {
    return `${base}(${indices.join(", ")})`;
  }
  return base + indices.map((i) => `[${i}]`).join("");
}

/**
 * A C++ octal escape for one character code (at most 0o777): always exactly
 * three digits, so the character after it can never extend it. A `\x` escape
 * would: C++ hex escapes take every hex digit that follows (`'$41BC'`).
 */
function octalEscape(code: number): string {
  return "\\" + code.toString(8).padStart(3, "0");
}

/**
 * Translate IEC 61131-3 `$`-escape sequences in a string literal's body to C++
 * escape sequences, and escape what C++ needs escaped.
 *
 * Handles `$N`/`$n` (newline), `$L`/`$l` (line feed), `$R`/`$r` (CR), `$T`/`$t`
 * (tab), `$P`/`$p` (form feed), `$$` (literal `$`), `$'` (single quote), `$XX`
 * (hex byte; `$XXXX` in a WSTRING) and `''` (doubled single quote), then
 * escapes backslash and double-quote so the result is safe inside a C++ `"…"`
 * literal.
 *
 * Every control character (below 0x20, and 0x7F) is written as an octal
 * escape, never raw: C++ treats a raw CR or LF as a line break, so `\` + CR in
 * the source (emitted as `\\` + CR) would splice the line, and the backslash
 * left over would escape the next `"` and end the C++ string early. `$XX` is
 * written in octal too, since a hex escape would swallow hex digits after it.
 *
 * A STRING literal's characters above 0x7F become their Windows-1252 byte, in
 * octal: a STRING is stored one CP1252 byte per character. The analyzer refuses
 * a character CP1252 lacks, so the `?` written for one is never compiled.
 *
 * Shared by the expression emitter and the type generator: a STRING literal has
 * to lower identically whether it appears in a statement, a variable
 * initialiser, or a STRUCT element default. `wide` is set for WSTRING literals
 * (emitted as `u"…"`).
 */
export function translateIECString(inner: string, wide = false): string {
  let result = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch === "$" && i + 1 < inner.length) {
      const next = inner[i + 1]!;
      switch (next.toUpperCase()) {
        case "N":
        case "L":
          result += "\\n";
          i++;
          break;
        case "R":
          result += "\\r";
          i++;
          break;
        case "T":
          result += "\\t";
          i++;
          break;
        case "P":
          result += "\\f";
          i++;
          break;
        case "$":
          result += "$";
          i++;
          break;
        case "'":
          result += "'";
          i++;
          break;
        default: {
          if (wide && next === '"') {
            // `$"` is the WSTRING double quote (in a STRING it is no escape)
            result += '\\"';
            i++;
            break;
          }
          // $XXXX (WSTRING) or $XX hex escape, written as a non-greedy escape
          const digits =
            wide && /^[0-9A-Fa-f]{4}$/.test(inner.substring(i + 1, i + 5))
              ? 4
              : /^[0-9A-Fa-f]{2}$/.test(inner.substring(i + 1, i + 3))
                ? 2
                : 0;
          if (digits > 0) {
            const code = parseInt(inner.substring(i + 1, i + 1 + digits), 16);
            if (code <= 0o777) {
              result += octalEscape(code);
            } else {
              // A code unit beyond octal range (WSTRING only). `\uXXXX` is
              // out: g++ rejects surrogates (`\uD800`) and the C0/C1 range.
              // A hex escape takes every hex digit after it, so end the
              // literal and restart it with the same `u` prefix: adjacent
              // literals concatenate, and the next character cannot run into
              // it. The space keeps `"u"` from reading as a literal suffix.
              result += "\\x" + code.toString(16).padStart(4, "0") + '" u"';
            }
            i += digits;
          } else {
            // Unknown $-escape, pass through
            result += "\\\\$";
          }
          break;
        }
      }
    } else if (ch === "'" && i + 1 < inner.length && inner[i + 1] === "'") {
      // ST doubled-quote → single quote
      result += "'";
      i++;
    } else if (ch === "\\") {
      result += "\\\\";
    } else if (ch === '"') {
      result += '\\"';
    } else if (ch === "?") {
      // Never two `?` in a row in the C++ source: `??/` is a trigraph for `\`
      // in -std=gnu++14 and below, and a backslash would eat the next quote.
      result += "\\?";
    } else if (ch < " " || ch === "\x7f") {
      // A raw control character, CR and LF above all: never into the C++ raw
      result += octalEscape(ch.charCodeAt(0));
    } else if (!wide && ch > "\x7f") {
      // A STRING holds Windows-1252 bytes, one per character.
      const codePoint = inner.codePointAt(i)!;
      const byte = cp1252Byte(codePoint);
      if (codePoint > 0xffff) i++;
      result += byte !== undefined ? octalEscape(byte) : "?";
    } else {
      result += ch;
    }
  }
  return result;
}

/** Nanoseconds in a day, as a C++ literal. */
export const NS_PER_DAY = "86400000000000LL";

/**
 * Date arithmetic in days (Table 35): DATE - DATE is a duration in
 * nanoseconds, and a date plus or minus a duration is the day that holds the
 * resulting instant (floor). `l` and `r` are the operands' canonical types;
 * undefined for any other operation.
 */
export function dateArithmeticCpp(
  operator: string,
  l: string | undefined,
  r: string | undefined,
  left: string,
  right: string,
): string | undefined {
  if (operator !== "+" && operator !== "-") return undefined;
  const isDate = (k: string | undefined): boolean =>
    k === "DATE" || k === "LDATE";
  const isDuration = (k: string | undefined): boolean =>
    k === "TIME" || k === "LTIME";
  const raw = (code: string): string => `static_cast<int64_t>(${code})`;
  if (operator === "-" && isDate(l) && isDate(r)) {
    return `((${raw(left)} - ${raw(right)}) * ${NS_PER_DAY})`;
  }
  if (isDate(l) && isDuration(r)) {
    const signed = operator === "-" ? `-${raw(right)}` : raw(right);
    return `DATE_FROM_DAYS(${raw(left)} + iec_floor_div(${signed}, ${NS_PER_DAY}))`;
  }
  if (operator === "+" && isDuration(l) && isDate(r)) {
    return `DATE_FROM_DAYS(iec_floor_div(${raw(left)}, ${NS_PER_DAY}) + ${raw(right)})`;
  }
  return undefined;
}

/** The temporal type a literal names (`D#...`, `T#...`, `LTIME#...`), canonical; else undefined. */
export function literalTemporalType(expr: Expression): string | undefined {
  if (expr.kind === "ParenthesizedExpression") {
    return literalTemporalType(expr.expression);
  }
  if (expr.kind === "UnaryExpression" && expr.operator === "-") {
    return literalTemporalType(expr.operand);
  }
  if (expr.kind !== "LiteralExpression") return undefined;
  const t = expr.literalType;
  return t === "DATE" || t === "LDATE" || t === "TIME" || t === "LTIME"
    ? t
    : undefined;
}
