// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Unary minus on a DATE, TOD or DT (or an L form) is refused in every mode
 * (Table 30 has no negation of a point in time; the C++ value wraps). A named
 * constant DIM of UPPER_BOUND / LOWER_BOUND outside 1..rank is refused as a
 * literal one is. Pinned: `DATE * n`, `LTIME * LTIME`, and UPPER_BOUND with
 * one argument, of a literal or of a POINTER global stay refused.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];

const errors = (vars: string, body: string, options: Options): string[] =>
  compile(
    `PROGRAM Main\nVAR ${vars} END_VAR\n${body}\nEND_PROGRAM\n`,
    options,
  ).errors.map((e) => `${e.line}: ${e.message}`);

describe("unary minus on a date or time of day", () => {
  const vars =
    "d : DATE; tod1 : TOD; dt1 : DT; ld : LDATE; ltod : LTOD; ldt : LDT; t : TIME; lt : LTIME;";
  for (const [label, options] of MODES) {
    it(`is refused (${label})`, () => {
      expect(
        errors(
          vars,
          "d := -d;\ntod1 := -tod1;\ndt1 := -(dt1);\nld := -ld;\nltod := -ltod;\nldt := -ldt;",
          options,
        ),
      ).toEqual(
        [
          [3, "DATE"],
          [4, "TOD"],
          [5, "DT"],
          [6, "LDATE"],
          [7, "LTOD"],
          [8, "LDT"],
        ].map(
          ([line, name]) =>
            `${line}: Unary '-' does not apply to ${name}: a date or time of day has no negation (IEC 61131-3 Table 30)`,
        ),
      );
    });

    it(`leaves a duration's negation alone (${label})`, () => {
      expect(
        errors(vars, "lt := -lt;\nt := -(dt1 - dt1);\nd := +d;", options),
      ).toEqual([]);
    });
  }
});

describe("date and time arithmetic outside Table 30 (pinned)", () => {
  for (const [label, options] of MODES) {
    it(`refuses DATE * n and LTIME * LTIME (${label})`, () => {
      const table30 =
        "date and time arithmetic is TIME + or - TIME, DATE, TOD or DT + or - TIME, TIME + DATE, TOD or DT, DT - DT, TOD - TOD or DATE - DATE (a TIME), TIME * or / a number, TIME / TIME and TIME, TOD or DT MOD TIME (an L form counts as its short one)";
      expect(errors("d : DATE; lt : LTIME;", "d := d * 2;", options)).toEqual([
        `3: Operator '*' does not apply to DATE and INT; ${table30}`,
      ]);
      expect(
        errors("d : DATE; lt : LTIME;", "lt := lt * lt;", options),
      ).toEqual([
        `3: Operator '*' does not apply to LTIME and LTIME; ${table30}`,
      ]);
    });
  }
});

describe("a named constant DIM of UPPER_BOUND / LOWER_BOUND", () => {
  const SOURCE = `PROGRAM Main
VAR CONSTANT KZ : INT := 0; K3 : INT := 3; K1 : INT := 1; KN : INT := -1 + 0; END_VAR
VAR arr : ARRAY[1..5] OF INT; i : DINT; END_VAR
BODY
END_PROGRAM
FUNCTION_BLOCK FB2
VAR_IN_OUT a2 : ARRAY[*] OF INT; END_VAR
VAR CONSTANT KN : INT := -1; END_VAR
VAR i : DINT; END_VAR
i := UPPER_BOUND(a2, KN);
END_FUNCTION_BLOCK
`;
  for (const [label, options] of MODES) {
    it(`is refused outside 1..rank, as a literal is (${label})`, () => {
      const r = compile(
        SOURCE.replace(
          "BODY",
          "i := UPPER_BOUND(arr, KZ);\ni := LOWER_BOUND(arr, K3);\ni := UPPER_BOUND(DIM := KN, ARR := arr);",
        ),
        options,
      );
      expect(r.errors.map((e) => `${e.line}: ${e.message}`)).toEqual([
        "4: UPPER_BOUND has no dimension 0: the array has 1",
        "5: LOWER_BOUND has no dimension 3: the array has 1",
        "6: UPPER_BOUND has no dimension -1: the array has 1",
        "12: UPPER_BOUND has no dimension -1: the array has 1",
      ]);
    });

    it(`accepts one inside it (${label})`, () => {
      const r = compile(
        SOURCE.replace("BODY", "i := UPPER_BOUND(arr, K1);").replace(
          "i := UPPER_BOUND(a2, KN);",
          "i := UPPER_BOUND(a2, 1);",
        ),
        options,
      );
      expect(r.errors).toEqual([]);
    });
  }
});

describe("UPPER_BOUND forms refused since #202 (pinned)", () => {
  for (const [label, options] of MODES) {
    it(`refuses one argument, a literal and a POINTER global (${label})`, () => {
      expect(
        errors(
          "arr : ARRAY[1..5] OF INT; i : DINT;",
          "i := UPPER_BOUND(arr);",
          options,
        ),
      ).toEqual(["3: 'UPPER_BOUND' requires 2 argument(s), got 1"]);
      expect(errors("i : DINT;", "i := UPPER_BOUND(5, 1);", options)).toEqual([
        "3: ARR of UPPER_BOUND must be an array, got a literal",
      ]);
    });
  }

  it("refuses a POINTER global (no dialect)", () => {
    const r = compile(
      "VAR_GLOBAL gp : POINTER TO INT; END_VAR\nPROGRAM Main\nVAR i : DINT; END_VAR\ni := UPPER_BOUND(gp, 1);\nEND_PROGRAM\n",
      {},
    );
    expect(r.errors.map((e) => e.message)).toEqual([
      "ARR of UPPER_BOUND must be an array, got a POINTER TO: dereference it with ^",
    ]);
  });
});
