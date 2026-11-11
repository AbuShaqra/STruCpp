/**
 * A typed integer literal must be representable in its type: a decimal
 * payload outside the range is refused; a 2#, 8# or 16# payload on a signed
 * type is a bit pattern of the type's width; unsigned and bit-string types
 * refuse anything above their maximum in any base.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];

const errors = (literal: string, options: Options): string[] => {
  const type = literal.split("#")[0]!;
  return compile(
    `PROGRAM Main\nVAR x : ${type}; END_VAR\nx := ${literal};\nEND_PROGRAM\n`,
    options,
  ).errors.map((e) => e.message);
};

describe("typed literal range", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      it("refuses a decimal payload outside the type", () => {
        expect(errors("SINT#200", options)).toEqual([
          "Typed literal 'SINT#200' is outside the range of SINT (-128 to 127).",
        ]);
        expect(errors("USINT#300", options)).toEqual([
          "Typed literal 'USINT#300' is outside the range of USINT (0 to 255).",
        ]);
        expect(errors("INT#40000", options)).toHaveLength(1);
        expect(errors("INT#-40000", options)).toHaveLength(1);
        expect(errors("BYTE#256", options)).toEqual([
          "Typed literal 'BYTE#256' is outside the range of BYTE (0 to 255).",
        ]);
      });

      it("accepts a based bit pattern of a signed type's width", () => {
        for (const lit of [
          "INT#16#FFFF",
          "SINT#16#FF",
          "DINT#16#FFFF_FFFF",
          "LINT#16#FFFF_FFFF_FFFF_FFFF",
          "SINT#2#1000_0000",
          "SINT#127",
          "SINT#-128",
          "BYTE#16#FF",
          "ULINT#18446744073709551615",
        ]) {
          expect(errors(lit, options)).toEqual([]);
        }
      });

      it("refuses a based payload wider than the type", () => {
        expect(errors("INT#16#1_0000", options)).toEqual([
          "Typed literal 'INT#16#1_0000' is outside the range of INT (-32768 to 32767, or 0 to 65535 as a 2#, 8# or 16# bit pattern).",
        ]);
        expect(errors("SINT#16#100", options)).toHaveLength(1);
        expect(errors("USINT#16#100", options)).toEqual([
          "Typed literal 'USINT#16#100' is outside the range of USINT (0 to 255).",
        ]);
        expect(errors("WORD#16#1_0000", options)).toEqual([
          "Typed literal 'WORD#16#1_0000' is outside the range of WORD (0 to 65535).",
        ]);
      });
    });
  }
});
