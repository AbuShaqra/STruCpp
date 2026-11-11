/**
 * An alias of a STRUCT relates as its target does: assigning or passing an
 * alias of a derived STRUCT where an alias of its base is expected is refused
 * as for the STRUCTs themselves; an alias and its own target stay compatible.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", { features: ["+struct_extends"] }],
  ["iec-3", { dialect: "iec-3", features: ["+struct_extends"] }],
  ["strict", { strict: true, features: ["+struct_extends"] }],
];

const TYPES = `TYPE ST_B : STRUCT a : INT; END_STRUCT END_TYPE
TYPE ST_D EXTENDS ST_B : STRUCT b : INT; END_STRUCT END_TYPE
TYPE AB : ST_B; END_TYPE
TYPE AD : ST_D; END_TYPE
FUNCTION F : INT
VAR_INPUT p : AB; END_VAR
F := p.a;
END_FUNCTION
`;

const errors = (body: string, options: Options): string[] =>
  compile(
    `${TYPES}PROGRAM Main
VAR ab : AB; ad : AD; sb : ST_B; x : INT; END_VAR
${body}
END_PROGRAM
`,
    options,
  ).errors.map((e) => e.message);

const RELATION =
  "a structured variable is assignment-compatible only with the same type (ST_D EXTENDS ST_B)";

describe("STRUCT aliases and EXTENDS", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      it("refuses an alias of the derived STRUCT for an alias of the base", () => {
        expect(errors("ab := ad;", options)).toEqual([
          `Cannot assign AD to AB: ${RELATION}`,
        ]);
        expect(errors("x := F(ad);", options)).toEqual([
          `Cannot assign AD to parameter 'P' of type AB: ${RELATION}`,
        ]);
      });

      it("accepts an alias and its own target", () => {
        expect(
          errors("ab := sb; sb := ab; x := F(sb) + F(ab);", options),
        ).toEqual([]);
      });
    });
  }
});
