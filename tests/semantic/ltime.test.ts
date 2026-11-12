// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * LTIME (IEC 61131-3 Ed. 3): a 64-bit duration in nanoseconds, its LTIME# and
 * LT# literals, the implicit conversion of TIME to LTIME, and the explicit
 * conversions to and from it.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { exactTimeLiteralNanoseconds } from "../../src/project-model.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];

const program = (body: string): string => `PROGRAM Main
VAR a : LTIME; b : LTIME; t : TIME; x : BOOL; n : LINT; END_VAR
${body}
END_PROGRAM
`;
const errors = (body: string, options: Options): string[] =>
  compile(program(body), options).errors.map((e) => e.message);

describe("LTIME literal values", () => {
  it("counts every unit exactly, with sign, fraction and underscores", () => {
    expect(exactTimeLiteralNanoseconds("LTIME#1d2h3m4s5ms6us7ns")).toBe(
      93_784_005_006_007n,
    );
    expect(exactTimeLiteralNanoseconds("LT#-1_500ms")).toBe(-1_500_000_000n);
    expect(exactTimeLiteralNanoseconds("lt#1.5s")).toBe(1_500_000_000n);
    expect(exactTimeLiteralNanoseconds("LTIME#106751d")).toBe(
      9_223_286_400_000_000_000n,
    );
    expect(exactTimeLiteralNanoseconds("T#1_000ms")).toBe(1_000_000_000n);
  });
});

describe("LTIME", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      it("declares LTIME and emits its literals as exact nanoseconds", () => {
        const r = compile(
          program(
            "a := LTIME#106751d;\nb := LT#-1_500ms;\nn := LTIME_TO_LINT(a);",
          ),
          options,
        );
        expect(r.errors).toEqual([]);
        expect(r.cppCode).toContain("A = 9223286400000000000LL;");
        expect(r.cppCode).toContain("B = -1500000000LL;");
        expect(r.headerCode).toContain("IEC_LTIME A;");
      });

      it("refuses an LTIME literal past the 64-bit range", () => {
        expect(errors("a := LTIME#106752d;", options)).toEqual([
          "LTIME literal 'LTIME#106752D' is outside the LTIME range (-9223372036854775808 to 9223372036854775807 nanoseconds)",
        ]);
      });

      it("converts TIME to LTIME implicitly, not back", () => {
        expect(
          errors("a := t;\nb := t + a;\nb := a - t;\nx := t < a;", options),
        ).toEqual([]);
        expect(errors("t := a;", options)).toEqual([
          "Cannot assign LTIME to TIME",
        ]);
        expect(errors("t := a - a;", options)).toEqual([
          "Cannot assign LTIME to TIME",
        ]);
      });

      it("has explicit conversions in both directions", () => {
        expect(
          errors(
            "t := LTIME_TO_TIME(a);\na := TIME_TO_LTIME(t);\na := TO_LTIME(t);\nn := LTIME_TO_LINT(a);\na := LINT_TO_LTIME(n);",
            options,
          ),
        ).toEqual([]);
      });

      it("takes duration arithmetic with numbers", () => {
        expect(errors("a := a * 2;\na := b / 4;\na := -a;", options)).toEqual(
          [],
        );
      });
    });
  }

  it("asks for an LTIME literal where strict refuses an integer", () => {
    expect(errors("a := 5;", { strict: true })).toEqual([
      "An integer cannot be used as LTIME; write an LTIME literal such as LTIME#100ms",
    ]);
  });
});
