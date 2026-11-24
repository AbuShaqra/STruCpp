// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * STRING and WSTRING operands: MAX, MIN, LIMIT, SEL, MUX and the comparison
 * functions take one string type throughout (no number, no other string
 * type); `+` and the other arithmetic or logic operators do not apply to a
 * string (CONCAT joins strings); a string compares only with its own type.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];

const program = (body: string): string => `PROGRAM Main
VAR s : STRING := 'b'; s2 : STRING; r : STRING; w : WSTRING; w2 : WSTRING; i : INT; b : BOOL; END_VAR
${body}
END_PROGRAM
`;
const errors = (body: string, options: Options): string[] =>
  compile(program(body), {
    ...options,
    headerFileName: "generated.hpp",
  }).errors.map((e) => e.message);
const mixed = (fn: string, got: string, want: string): string =>
  `Argument of '${fn}' is ${got} where the others are ${want}; ${want} does not convert implicitly`;

describe("STRING and WSTRING operand types", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      it("accepts one string type throughout, with three or more arguments", () => {
        expect(
          errors(
            "r := MAX(s, s2, s);\nr := MIN(s, s2, 'c');\nw2 := MAX(w, w, w);\nr := MAX('a', 'c', 'b');\nb := GT(s, s2, 'a');\nr := SEL(b, s, 'q');\nb := s = 'b';",
            options,
          ),
        ).toEqual([]);
      });

      for (const [call, fn, got, want] of [
        ["r := MAX(s, i);", "MAX", "INT", "STRING"],
        ["r := MIN(s, s2, i);", "MIN", "INT", "STRING"],
        ["r := SEL(TRUE, s, i);", "SEL", "INT", "STRING"],
        ["r := MUX(1, s, i);", "MUX", "INT", "STRING"],
        ["b := GT(s, i);", "GT", "INT", "STRING"],
        ["r := MAX(s, w);", "MAX", "WSTRING", "STRING"],
        ["b := GT(s, w);", "GT", "WSTRING", "STRING"],
        ["r := LIMIT(s, w, s);", "LIMIT", "WSTRING", "STRING"],
        ["w2 := MAX(w, 'abc');", "MAX", "STRING", "WSTRING"],
      ] as const) {
        it(`refuses ${call}`, () => {
          expect(errors(call, options)).toEqual([mixed(fn, got, want)]);
        });
      }

      it("refuses arithmetic on strings and a string compared with a number", () => {
        for (const sum of ["s + 'b'", "'a' + 'b'", "STRING#'abc' + 'x'"]) {
          expect(errors(`r := ${sum};`, options)).toEqual([
            "Operator '+' does not apply to STRING; join strings with CONCAT",
          ]);
        }
        expect(errors("w2 := w - w;", options)).toEqual([
          "Operator '-' does not apply to WSTRING",
        ]);
        expect(errors("b := s = i;", options)).toEqual([
          "Cannot compare STRING with INT",
        ]);
      });
    });
  }
});
