// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Date and time arithmetic follows IEC 61131-3 Table 30: TIME +/- TIME, an
 * instant +/- a TIME, TIME + an instant, the difference of two instants of
 * one kind, TIME * or / a number, TIME / TIME and TIME, TOD or DT MOD a TIME.
 * Any other form with a DATE, TOD or DT operand is refused in every mode; a
 * number +/- a date or time and TOD or DT MOD a number only under iec-3 and
 * --strict.
 */
import { describe, it, expect } from "vitest";
import { compile, type CompileOptions } from "../../src/index.js";
import type { DialectProfile } from "../../src/dialect.js";

const TWINCAT3: DialectProfile = {
  id: "twincat3",
  name: "twincat3",
  extends: "iec-3",
  features: [
    "pointer_to",
    "reference_to",
    "ref_assign",
    "conditional_pragmas",
    "vendor_operators",
  ],
  semantics: {},
};

const VARS = `t : TIME := T#1s; lt : LTIME; d : DATE; tod : TOD; dt : DT;
ld : LDATE; ltod : LTOD; ldt : LDT; n : DINT := 2; r : REAL := 2.0;
u : UDINT; b : BOOL;`;

const errors = (body: string, opts: Partial<CompileOptions> = {}): string[] =>
  compile(
    `PROGRAM P\nVAR\n${VARS}\nEND_VAR\n${body}\nEND_PROGRAM\n`,
    opts,
  ).errors.map((e) => `${e.line}:${e.column}: ${e.message}`);

const FORMS =
  "date and time arithmetic is TIME + or - TIME, DATE, TOD or DT + or - TIME, " +
  "TIME + DATE, TOD or DT, DT - DT, TOD - TOD or DATE - DATE (a TIME), " +
  "TIME * or / a number, TIME / TIME and TIME, TOD or DT MOD TIME " +
  "(an L form counts as its short one)";

const MODES: Array<[string, Partial<CompileOptions>]> = [
  ["no dialect", {}],
  ["a vendor profile", { dialect: TWINCAT3 }],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];

/** Each refused statement and the operand types its message names. */
const REFUSED: Array<[string, string, string, string]> = [
  ["dt := dt + dt;", "+", "DT", "DT"],
  ["dt := DT#2020-01-01-00:00:00 + DT#2020-01-01-00:00:00;", "+", "DT", "DT"],
  ["tod := tod + tod;", "+", "TOD", "TOD"],
  ["d := d + d;", "+", "DATE", "DATE"],
  ["t := t - dt;", "-", "TIME", "DT"],
  ["t := T#1s - D#2020-01-01;", "-", "TIME", "DATE"],
  ["t := dt - tod;", "-", "DT", "TOD"],
  ["dt := dt * 2;", "*", "DT", "INT"],
  ["tod := tod * n;", "*", "TOD", "DINT"],
  ["dt := 2 * dt;", "*", "INT", "DT"],
  ["d := d / 2;", "/", "DATE", "INT"],
  ["tod := tod / r;", "/", "TOD", "REAL"],
  ["u := dt / dt;", "/", "DT", "DT"],
  ["d := d MOD d;", "MOD", "DATE", "DATE"],
  ["ldt := ldt + ldt;", "+", "LDT", "LDT"],
  ["ltod := ltod * 2;", "*", "LTOD", "INT"],
  ["lt := lt - ld;", "-", "LTIME", "LDATE"],
  ["lt := lt * lt;", "*", "LTIME", "LTIME"],
];

describe("date and time arithmetic outside Table 30", () => {
  for (const [label, opts] of MODES) {
    it(`refuses each form naming the allowed ones (${label})`, () => {
      const got = errors(REFUSED.map((f) => f[0]).join("\n"), opts);
      expect(got).toEqual(
        REFUSED.map(
          ([stmt, op, l, r], i) =>
            `${7 + i}:${stmt.indexOf(":=") + 4}: Operator '${op}' does not apply to ${l} and ${r}; ${FORMS}`,
        ),
      );
    });

    it(`accepts the Table 30 forms (${label})`, () => {
      expect(
        errors(
          `t := t + T#1s; t := t - T#1s; t := T#2s - t;
dt := dt + t; dt := dt - t; dt := t + dt; tod := tod + t; tod := tod - t; tod := t + tod;
d := d + T#1d; d := d - T#1d; d := T#1d + d;
t := dt - dt; t := tod - tod; t := d - d; t := DT#2020-01-02-00:00:00 - dt;
ldt := ldt + lt; ldt := dt + lt; lt := ldt - dt; lt := ld - ld; ld := ld - t; ltod := ltod + lt;
t := t * 2; t := t * r; t := t / n; t := t / 2.0; u := TIME_TO_UDINT(t / t);
lt := lt * n; lt := lt / 4;
t := t MOD T#300ms; tod := tod MOD T#1h; dt := dt MOD T#1h; t := t MOD n;
t := t + SEL(b, T#1s, T#2s);`,
          opts,
        ),
      ).toEqual([]);
    });
  }

  const NUMBER_FORMS =
    "t := t + 100;\ndt := dt + 1;\nd := d - n;\ntod := tod MOD 300;";

  it("accepts a number +/- a date or time and TOD MOD a number by default", () => {
    expect(errors(NUMBER_FORMS)).toEqual([]);
    expect(errors(NUMBER_FORMS, { dialect: TWINCAT3 })).toEqual([]);
  });

  for (const [label, opts] of MODES.slice(2)) {
    it(`refuses a number +/- a date or time and TOD MOD a number (${label})`, () => {
      expect(errors(NUMBER_FORMS, opts)).toEqual([
        `7:6: Operator '+' does not apply to TIME and INT; ${FORMS}`,
        `8:7: Operator '+' does not apply to DT and INT; ${FORMS}`,
        `9:6: Operator '-' does not apply to DATE and DINT; ${FORMS}`,
        `10:8: Operator 'MOD' does not apply to TOD and INT; ${FORMS}`,
      ]);
    });
  }
});
