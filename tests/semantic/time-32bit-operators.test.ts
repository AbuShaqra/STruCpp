// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Operators on the 32-bit TIME, DATE, TOD and DT: a product of two of them and
 * a power of one are refused (also through `p^` and SEL), `/` and MOD of
 * different kinds or of a number by one are refused except TIME with LTIME
 * and TOD or DT MOD a TIME, and so is the negation of a TIME literal or TIME
 * constant (a negative TIME) wherever it is written; negating a TIME
 * variable wraps. An LTIME as the default of a TIME field or alias is refused.
 */
import { describe, it, expect } from "vitest";
import { compile, type CompileOptions } from "../../src/index.js";

const errors = (body: string, opts: Partial<CompileOptions> = {}): string[] =>
  compile(
    `PROGRAM P
VAR t1 : TIME := T#1s; t2 : TIME := T#2s; x : TIME; tod1 : TOD; lt : LTIME; pt : REF_TO TIME; dd : DATE; dt1 : DT; di : DINT; q : LINT; END_VAR
VAR CONSTANT c : TIME := T#3s; END_VAR
${body}
END_PROGRAM
`,
    opts,
  ).errors.map((e) => `${e.line}:${e.column}: ${e.message}`);

const unitErrors = (
  source: string,
  opts: Partial<CompileOptions> = {},
): string[] =>
  compile(source, opts)
    .errors.map((e) => `${e.line}:${e.column}: ${e.message}`)
    .sort();

const NEGATIVE =
  "is negative; a TIME holds T#0ms to T#49d17h2m47s295ms (an LTIME can be negative)";

for (const [label, opts] of [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
] as const) {
  describe(`32-bit date and time operators (${label})`, () => {
    it("refuses a product of two of them and a power", () => {
      expect(
        errors(
          `x := t1 * t2;
x := t1 ** 2;
tod1 := tod1 * tod1;`,
          opts,
        ),
      ).toEqual([
        "4:6: Operator '*' does not apply to TIME and TIME; multiply a duration by a number",
        "5:6: Operator '**' does not apply to TIME",
        "6:9: Operator '*' does not apply to TOD and TOD; multiply a duration by a number",
      ]);
    });

    it("refuses the negation of a TIME literal or constant", () => {
      expect(
        errors(
          `x := -T#5s;
x := -(T#1ms);
x := -c;`,
          opts,
        ),
      ).toEqual([
        `4:6: TIME literal '-T#5S' ${NEGATIVE}`,
        `5:6: TIME literal '-T#1MS' ${NEGATIVE}`,
        `6:6: TIME value '-C' ${NEGATIVE}`,
      ]);
    });

    it("refuses a product or power through a dereference, SEL or LTIME", () => {
      expect(
        errors(
          `pt := REF(t1);
x := pt^ * t1;
x := SEL(TRUE, t1, t2) * t1;
x := SEL(TRUE, t1, t2) ** 2;
x := pt^ ** 2;
lt := t1 * lt;`,
          opts,
        ),
      ).toEqual([
        "5:6: Operator '*' does not apply to TIME and TIME; multiply a duration by a number",
        "6:6: Operator '*' does not apply to TIME and TIME; multiply a duration by a number",
        "7:6: Operator '**' does not apply to TIME",
        "8:6: Operator '**' does not apply to TIME",
        "9:7: Operator '*' does not apply to TIME and LTIME; multiply a duration by a number",
      ]);
    });

    it("refuses / and MOD of different kinds or of a number by one", () => {
      expect(
        errors(
          `q := DATE_TO_LINT(dd MOD T#1d);
q := TOD_TO_LINT(tod1 / T#1h);
x := t1 MOD dd;
x := t1 / dd;
x := DIV_TIME(t1, dd);
q := di / T#1s;
q := di MOD t1;
x := MUL_TIME(t1, t2);
q := TOD_TO_LINT(tod1 MOD lt);`,
          opts,
        ),
      ).toEqual([
        "4:19: Operator 'MOD' does not apply to DATE and TIME",
        "5:18: Operator '/' does not apply to TOD and TIME",
        "6:6: Operator 'MOD' does not apply to TIME and DATE",
        "7:6: Operator '/' does not apply to TIME and DATE",
        "8:6: DIV_TIME takes a duration and a number: got TIME and DATE",
        "9:6: Operator '/' does not apply to DINT and TIME",
        "10:6: Operator 'MOD' does not apply to DINT and TIME",
        "11:6: MUL_TIME takes a duration and a number: got TIME and TIME",
        "12:18: Operator 'MOD' does not apply to TOD and LTIME",
      ]);
    });

    it("accepts TOD or DT MOD a TIME and TIME with LTIME in / and MOD", () => {
      expect(
        errors(
          `tod1 := tod1 MOD T#1h;
dt1 := dt1 MOD t1;
lt := t1 MOD lt;
lt := t1 / lt;
lt := lt MOD t1;
lt := lt / t1;
x := DIV_TIME(t1, t2);
x := t1 MOD t2;`,
          opts,
        ),
      ).toEqual([]);
    });

    it("refuses a negated TIME literal or constant in every position", () => {
      expect(
        unitErrors(
          `TYPE MyT : TIME; END_TYPE
TYPE S : STRUCT a : TIME; b : TIME := -T#5s; END_STRUCT; END_TYPE
FUNCTION_BLOCK FB VAR_INPUT p : TIME; END_VAR END_FUNCTION_BLOCK
PROGRAM MAIN
VAR s : S := (a := -T#5s); arr : ARRAY[1..2] OF TIME := [-T#5s, T#1s]; f : FB := (p := -T#5s); r : TIME; END_VAR
VAR CONSTANT C : MyT := T#5s; C0 : TIME := T#0s; END_VAR
r := -C; r := -(T#5s - T#1s);
r := -C0; r := -T#0s; r := -(T#1s - T#1s);
END_PROGRAM
`,
          opts,
        ),
      ).toEqual([
        `2:39: TIME literal '-T#5S' ${NEGATIVE}`,
        `5:20: TIME literal '-T#5S' ${NEGATIVE}`,
        `5:58: TIME literal '-T#5S' ${NEGATIVE}`,
        `5:88: TIME literal '-T#5S' ${NEGATIVE}`,
        `7:15: The negated TIME expression ${NEGATIVE}`,
        `7:6: TIME value '-C' ${NEGATIVE}`,
      ]);
    });

    it("refuses an LTIME as the default of a TIME STRUCT field or TIME alias", () => {
      expect(
        unitErrors(
          `TYPE MyT : TIME; END_TYPE
TYPE S : STRUCT a : TIME := LTIME#2ms; b : MyT := LTIME#2ms; END_STRUCT; END_TYPE
PROGRAM MAIN
VAR x : TIME := LTIME#3ms; y : MyT := LTIME#3ms; s : S; END_VAR
END_PROGRAM
`,
          opts,
        ),
      ).toEqual([
        "2:29: Cannot assign LTIME to TIME",
        "2:51: Cannot assign LTIME to MYT",
        "4:17: Cannot assign LTIME to TIME",
        "4:39: Cannot assign LTIME to MYT",
      ]);
    });

    it("accepts a negated TIME variable, -T#0s and LTIME products", () => {
      expect(
        errors(
          `x := -t1;
x := -T#0s;
lt := lt * 2;
x := t1 * 2;`,
          opts,
        ),
      ).toEqual([]);
    });
  });
}

describe("32-bit date and time operators through a POINTER TO", () => {
  it("refuses a product or power of a dereferenced POINTER TO TIME", () => {
    expect(
      unitErrors(`PROGRAM P
VAR t : TIME := T#2s; pt : POINTER TO TIME; END_VAR
pt := ADR(t);
t := pt^ * t;
t := pt^ ** 2;
END_PROGRAM
`),
    ).toEqual([
      "4:6: Operator '*' does not apply to TIME and TIME; multiply a duration by a number",
      "5:6: Operator '**' does not apply to TIME",
    ]);
  });
});
