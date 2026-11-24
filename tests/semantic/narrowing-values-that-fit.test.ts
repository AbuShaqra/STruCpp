// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * The narrowing warning of an assignment or an input argument leaves alone a
 * value known to fit the target: a negative literal (`-1` into a SINT), a
 * named constant whose value fits, and arithmetic of a value no wider than
 * the target with an untyped constant that takes its type (`s + 1` is a
 * SINT). A real narrowing keeps its warning (an error under --strict).
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const SOURCE = (body: string): string => `FUNCTION F_SINT : INT
VAR_INPUT x : SINT; END_VAR
F_SINT := 0;
END_FUNCTION
FUNCTION F_INT : INT
VAR_INPUT x : INT; END_VAR
F_INT := 0;
END_FUNCTION
PROGRAM Main
VAR CONSTANT CD : DINT := 100; CD2 : DINT := 300; CN : DINT := -5; END_VAR
VAR s : SINT; i : INT; n : INT; END_VAR
${body}
END_PROGRAM
`;
const warnings = (body: string, options = {}): string[] =>
  compile(SOURCE(body), options).warnings.map(
    (w) => `${w.line - 11}: ${w.message}`,
  );

describe("narrowing of a value that fits", () => {
  for (const options of [{}, { dialect: "iec-3" }]) {
    it(`gives no warning (${JSON.stringify(options)})`, () => {
      expect(
        warnings(
          [
            "n := F_SINT(-1);",
            "n := F_SINT(-128);",
            "n := F_SINT(s + 1);",
            "n := F_INT(CD);",
            "s := -1;",
            "s := s + 1;",
            "s := (s - 1) * 2;",
            "i := CD;",
            "s := CN;",
          ].join("\n"),
          options,
        ),
      ).toEqual([]);
    });

    it(`keeps the warning of a real narrowing (${JSON.stringify(options)})`, () => {
      const n = (line: number, from: string): string =>
        `${line}: Implicit narrowing conversion from ${from} to SINT`;
      expect(
        warnings(
          [
            "s := i;",
            "s := s + i;",
            "s := CD2;",
            "s := -129;",
            "s := s + 200;",
            "n := F_SINT(i);",
            "n := F_SINT(CD2);",
          ].join("\n"),
          options,
        ),
      ).toEqual([
        n(1, "INT"),
        n(2, "INT"),
        n(3, "DINT"),
        n(4, "INT"),
        n(5, "INT"),
        n(6, "INT"),
        n(7, "DINT"),
      ]);
    });
  }

  it("leaves --strict as it was", () => {
    const r = compile(SOURCE("i := CD;\ns := s + i;"), { strict: true });
    expect(r.errors.map((e) => `${e.line - 11}: ${e.message}`)).toEqual([
      "1: Implicit conversion from DINT to INT is not allowed; use DINT_TO_INT",
      "2: Implicit conversion from INT to SINT is not allowed; use INT_TO_SINT",
    ]);
  });
});
