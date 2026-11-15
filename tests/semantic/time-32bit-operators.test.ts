// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Operators on the 32-bit TIME, DATE, TOD and DT: a product of two of them and
 * a power of one are refused, and so is the negation of a TIME literal or
 * TIME constant (a negative TIME); negating a TIME variable wraps.
 */
import { describe, it, expect } from "vitest";
import { compile, type CompileOptions } from "../../src/index.js";

const errors = (body: string, opts: Partial<CompileOptions> = {}): string[] =>
  compile(
    `PROGRAM P
VAR t1 : TIME := T#1s; t2 : TIME := T#2s; x : TIME; tod1 : TOD; lt : LTIME; END_VAR
VAR CONSTANT c : TIME := T#3s; END_VAR
${body}
END_PROGRAM
`,
    opts,
  ).errors.map((e) => `${e.line}:${e.column}: ${e.message}`);

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
