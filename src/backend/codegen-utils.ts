// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * Shared utility functions for C++ code generation.
 */

import type {
  ElementaryType,
  Expression,
  ParenthesizedExpression,
} from "../frontend/ast.js";
import { exactIntegerLiteralValue } from "../literal-utils.js";
import { cp1252Byte } from "../byte-utils.js";
import {
  parseDateLiteralToDays,
  parseDtLiteralToNs,
  parseTimeLiteral,
  parseTodLiteralToNs,
} from "../project-model.js";

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

/**
 * True when `expr` yields a BOOL: a comparison, a BOOL literal, NOT of a BOOL,
 * AND/OR/XOR of two BOOLs, or anything `baseType` names BOOL. Parentheses are
 * looked through. Used where the C++ form must stay a `bool`.
 */
export function isBoolValued(
  expr: Expression,
  baseType: (e: Expression) => string | undefined,
): boolean {
  switch (expr.kind) {
    case "ParenthesizedExpression":
      return isBoolValued(expr.expression, baseType);
    case "LiteralExpression":
      if (expr.literalType === "BOOL") return true;
      break;
    case "UnaryExpression":
      if (expr.operator === "NOT") return isBoolValued(expr.operand, baseType);
      break;
    case "BinaryExpression":
      if (isComparison(expr.operator)) return true;
      if (isBoolLogic(expr, baseType)) return true;
      break;
  }
  return baseType(expr) === "BOOL";
}

/**
 * True for AND, OR or XOR of two BOOL operands. C++ promotes `bool & bool`
 * to an int, so its C++ form is cast back to `bool`.
 */
export function isBoolLogic(
  expr: Expression,
  baseType: (e: Expression) => string | undefined,
): boolean {
  return (
    expr.kind === "BinaryExpression" &&
    (expr.operator === "AND" ||
      expr.operator === "OR" ||
      expr.operator === "XOR") &&
    isBoolValued(expr.left, baseType) &&
    isBoolValued(expr.right, baseType)
  );
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
 * STRING or WSTRING when `e` is a string literal (not one taken as a CHAR) or
 * is typed as a string, through `aliasBase` for an alias type.
 */
export function comparedStringKind(
  e: Expression,
  aliasBase: (name: string) => string,
): string | undefined {
  while (e.kind === "ParenthesizedExpression" && e.resolvedType === undefined) {
    e = e.expression;
  }
  const type = e.resolvedType;
  if (type?.typeKind === "elementary") {
    const m = /^(W?STRING)\b/i.exec(aliasBase((type as ElementaryType).name));
    if (m !== null) return m[1]!.toUpperCase();
    return undefined;
  }
  return e.kind === "LiteralExpression" &&
    (e.literalType === "STRING" || e.literalType === "WSTRING")
    ? e.literalType
    : undefined;
}

/**
 * A comparison of two STRING or two WSTRING values compares their text
 * through `strucpp::iec_str_cmp`, whatever form each operand takes (a
 * literal, a variable, a dereference, a call). Undefined for any other.
 */
export function stringComparisonCpp(
  left: Expression,
  right: Expression,
  leftCpp: string,
  rightCpp: string,
  cppOp: string,
  aliasBase: (name: string) => string,
): string | undefined {
  if (
    comparedStringKind(left, aliasBase) === undefined &&
    comparedStringKind(right, aliasBase) === undefined
  ) {
    return undefined;
  }
  return `strucpp::iec_str_cmp(${leftCpp}, ${rightCpp}) ${cppOp} 0`;
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

/**
 * A 32-bit TIME, DATE, TOD or DT value as C++: its raw count (ms for TIME and
 * TOD, seconds for DATE and DT) modulo 2^32, in the type's constructor.
 */
export function temporal32Cpp(
  type: "TIME_t" | "DATE_t" | "TOD_t" | "DT_t",
  raw: bigint,
): string {
  const wrapped = ((raw % 4294967296n) + 4294967296n) % 4294967296n;
  return `${type}(${wrapped}u)`;
}

/**
 * The C++ of a date or time literal: the 32-bit TIME, DATE, TOD and DT in
 * their types (ms, s, ms, s), the long forms as int64 (ns; days for LDATE).
 * Undefined for any other literal type.
 */
export function temporalLiteralCpp(
  literalType: string,
  value: string,
): string | undefined {
  switch (literalType) {
    case "TIME":
      return temporal32Cpp("TIME_t", parseTimeLiteral(value).exact / 1000000n);
    case "LTIME":
      return `${parseTimeLiteral(value).exact}LL`;
    case "DATE":
      return temporal32Cpp("DATE_t", parseDateLiteralToDays(value) * 86400n);
    case "LDATE":
      return `${parseDateLiteralToDays(value)}LL`;
    case "TIME_OF_DAY":
      return temporal32Cpp("TOD_t", parseTodLiteralToNs(value) / 1000000n);
    case "LTIME_OF_DAY":
      return `${parseTodLiteralToNs(value)}LL`;
    case "DATE_AND_TIME":
      return temporal32Cpp(
        "DT_t",
        floorDivBig(parseDtLiteralToNs(value), 1000000000n),
      );
    case "LDATE_AND_TIME":
      return `${parseDtLiteralToNs(value)}LL`;
    default:
      return undefined;
  }
}

/** `n / d` rounded toward negative infinity. */
export function floorDivBig(n: bigint, d: bigint): bigint {
  const q = n / d;
  return n % d !== 0n && n < 0n !== d < 0n ? q - 1n : q;
}

/** Nanoseconds in a day, as a C++ literal. */
export const NS_PER_DAY = "86400000000000LL";

/** The kind of a temporal type, and whether it is the long (64-bit) form. */
const TEMPORAL_KINDS: Record<string, [string, boolean]> = {
  TIME: ["duration", false],
  LTIME: ["duration", true],
  DATE: ["date", false],
  LDATE: ["date", true],
  TOD: ["tod", false],
  TIME_OF_DAY: ["tod", false],
  LTOD: ["tod", true],
  LTIME_OF_DAY: ["tod", true],
  DT: ["dt", false],
  DATE_AND_TIME: ["dt", false],
  LDT: ["dt", true],
  LDATE_AND_TIME: ["dt", true],
};

/** The long form a 32-bit temporal operand widens to, as a C++ conversion. */
const WIDEN: Record<string, string> = {
  duration: "TO_LTIME",
  date: "TO_LDATE",
  tod: "TO_LTOD",
  dt: "TO_LDT",
};

/**
 * A binary operation on temporal operands (Table 30, Table 35). `l` and `r`
 * are the operands' canonical types; undefined when it is no such operation.
 * - Both 32-bit: TIME +/- TIME and TIME * or / a number stay C++ operators;
 *   any other + or - (TOD, DT or DATE with TIME, or a difference) calls
 *   `iec_temporal_add` / `iec_temporal_sub`.
 * - A 32-bit operand beside a long one widens to its long form; then a date
 *   (days) with a duration or a date goes by days, the rest in nanoseconds.
 */
export function temporalArithmeticCpp(
  operator: string,
  l: string | undefined,
  r: string | undefined,
  left: string,
  right: string,
): string | undefined {
  const lk = l === undefined ? undefined : TEMPORAL_KINDS[l];
  const rk = r === undefined ? undefined : TEMPORAL_KINDS[r];
  const comparison = ["=", "<>", "<", ">", "<=", ">="].includes(operator);
  if (lk === undefined || rk === undefined) return undefined;
  if (operator !== "+" && operator !== "-" && !comparison) return undefined;
  if (!lk[1] && !rk[1]) {
    if (comparison || (lk[0] === "duration" && rk[0] === "duration")) {
      return undefined;
    }
    return operator === "+"
      ? `iec_temporal_add(${left}, ${right})`
      : `iec_temporal_sub(${left}, ${right})`;
  }
  // One side long: widen the other.
  const wl = lk[1] ? left : `${WIDEN[lk[0]]!}(${left})`;
  const wr = rk[1] ? right : `${WIDEN[rk[0]]!}(${right})`;
  if (comparison) {
    return lk[1] === rk[1]
      ? undefined
      : `${wl} ${operator === "=" ? "==" : operator === "<>" ? "!=" : operator} ${wr}`;
  }
  const raw = (code: string): string =>
    `static_cast<int64_t>(iec_unwrap(${code}))`;
  if (operator === "-" && lk[0] === "date" && rk[0] === "date") {
    return `IEC_LTIME((${raw(wl)} - ${raw(wr)}) * ${NS_PER_DAY})`;
  }
  if (lk[0] === "date" && rk[0] === "duration") {
    const signed = operator === "-" ? `-${raw(wr)}` : raw(wr);
    return `IEC_LDATE(${raw(wl)} + iec_floor_div(${signed}, ${NS_PER_DAY}))`;
  }
  if (operator === "+" && lk[0] === "duration" && rk[0] === "date") {
    return `IEC_LDATE(iec_floor_div(${raw(wl)}, ${NS_PER_DAY}) + ${raw(wr)})`;
  }
  if (lk[1] === rk[1]) return undefined;
  return `${wl} ${operator} ${wr}`;
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
  return t === "DATE" ||
    t === "LDATE" ||
    t === "TIME" ||
    t === "LTIME" ||
    t === "TIME_OF_DAY" ||
    t === "LTIME_OF_DAY" ||
    t === "DATE_AND_TIME" ||
    t === "LDATE_AND_TIME"
    ? t
    : undefined;
}

/** The integer and bit string types (BOOL aside) a folded constant is cast to. */
const FOLDED_CAST_TYPES: ReadonlySet<string> = new Set([
  "BYTE",
  "WORD",
  "DWORD",
  "LWORD",
  "SINT",
  "INT",
  "DINT",
  "LINT",
  "USINT",
  "UINT",
  "UDINT",
  "ULINT",
]);

/**
 * `(inner)`, or for a typed global constant folded into a STRUCT default a
 * cast to its declared type, so it computes in that width as a typed literal does.
 */
export function parenthesizedCpp(
  expr: ParenthesizedExpression,
  inner: string,
): string {
  const t = expr.resolvedType;
  if (expr.foldedConstant === true && t?.typeKind === "elementary") {
    const name = (t as ElementaryType).name.toUpperCase();
    if (FOLDED_CAST_TYPES.has(name))
      return `static_cast<IEC_${name}>(${inner})`;
  }
  return `(${inner})`;
}
