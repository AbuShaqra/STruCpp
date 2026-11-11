/**
 * A PRIVATE property is reachable only inside its block; a PROTECTED one
 * inside its block and the blocks derived from it, as for methods. Reading
 * and writing from outside are refused.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", { features: ["+property"] }],
  ["iec-3", { dialect: "iec-3", features: ["+property"] }],
  ["strict", { strict: true, features: ["+property"] }],
];

const TYPES = `FUNCTION_BLOCK FB_A
VAR _v : INT := 3; END_VAR
PROPERTY PRIVATE Pv : INT
GET Pv := _v; END_GET
SET _v := Pv; END_SET
END_PROPERTY
PROPERTY PROTECTED Pt : INT
GET Pt := _v * 10; END_GET
SET _v := Pt; END_SET
END_PROPERTY
PROPERTY Pub : INT
GET Pub := Pv + THIS.Pt; END_GET
END_PROPERTY
END_FUNCTION_BLOCK
`;

const errors = (extra: string, body: string, options: Options): string[] =>
  compile(
    `${TYPES}${extra}PROGRAM Main
VAR f : FB_A; a : INT; END_VAR
${body}
END_PROGRAM
`,
    options,
  ).errors.map((e) => e.message);

const PRIV =
  "Cannot access PRIVATE property 'PV' of 'FB_A' from outside 'FB_A'.";

describe("property visibility", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      it("refuses reading and writing a PRIVATE or PROTECTED property from outside", () => {
        expect(errors("", "a := f.Pv;", options)).toEqual([PRIV]);
        expect(errors("", "f.Pv := 1;", options)).toEqual([PRIV]);
        expect(errors("", "a := f.Pt;", options)).toEqual([
          "Cannot access PROTECTED property 'PT' of 'FB_A' from 'PROGRAM'.",
        ]);
        expect(errors("", "a := f.Pub;", options)).toEqual([]);
      });

      it("lets a derived block use PROTECTED, not PRIVATE", () => {
        const derived = (body: string): string =>
          `FUNCTION_BLOCK FB_D EXTENDS FB_A\nMETHOD M : INT\n${body}\nEND_METHOD\nEND_FUNCTION_BLOCK\n`;
        expect(
          errors(derived("M := Pt + THIS.Pt + SUPER.Pt;"), "", options),
        ).toEqual([]);
        expect(errors(derived("M := Pv;"), "", options)).toEqual([PRIV]);
        expect(errors(derived("M := THIS.Pv;"), "", options)).toEqual([PRIV]);
      });
    });
  }
});
