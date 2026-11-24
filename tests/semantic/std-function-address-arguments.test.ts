// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * An address passed to a standard function's INT length or position (`L`,
 * `P` of LEFT, RIGHT, MID, INSERT, DELETE, REPLACE; `N` of SHL, SHR, ROL, ROR) is refused as
 * an address stored into an INT is; an integer there is accepted.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["strict", { strict: true }],
];

const program = (body: string): string => `PROGRAM Main
VAR s : STRING := 'abc'; r : STRING; ws : WSTRING; w : WSTRING; x : INT := 1; n : INT; END_VAR
${body}
END_PROGRAM
`;
const errors = (body: string, options: Options): string[] =>
  compile(program(body), {
    ...options,
    headerFileName: "generated.hpp",
  }).errors.map((e) => e.message);
const narrow = (op: string): string =>
  `${op} gives a 64-bit address, which INT cannot hold; use a POINTER TO or PVOID, or __XWORD, LWORD or ULINT`;

describe("addresses into standard INT inputs", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      for (const call of [
        "r := LEFT(s, ADR(x));",
        "r := RIGHT(s, ADR(x));",
        "r := MID(s, 1, ADR(x));",
        "r := MID(s, ADR(x), 1);",
        "r := INSERT(s, 'q', ADR(x));",
        "r := DELETE(s, ADR(x), 1);",
        "r := REPLACE(s, 'z', 1, ADR(x));",
        "r := LEFT(IN := s, L := ADR(x));",
        "r := LEFT(L := ADR(x), IN := s);",
        "w := LEFT(ws, ADR(x));",
        "n := SHL(n, ADR(x));",
        "n := ROR(n, ADR(x));",
      ]) {
        it(`refuses ${call}`, () => {
          expect(errors(call, options)).toEqual([narrow("ADR")]);
        });
      }

      it("refuses a REF and address arithmetic the same way", () => {
        expect(errors("r := LEFT(s, REF(x));", options)).toEqual([
          narrow("REF"),
        ]);
        expect(errors("r := LEFT(s, ADR(x) * 2);", options)).toEqual([
          "An address can only be offset by + or - an integer",
        ]);
      });

      it("accepts an integer length or position", () => {
        expect(
          errors(
            "r := LEFT(s, x);\nr := INSERT(s, 'q', 2);\nr := MID(s, x, 1);",
            options,
          ),
        ).toEqual([]);
      });
    });
  }
});
