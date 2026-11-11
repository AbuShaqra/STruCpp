/**
 * SEL and MUX of values of one enumeration (aliases included) yield that
 * enumeration; inputs of another type next to an enumeration are an error.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
  ["vendor features", { strict: true, features: ["+program_methods"] }],
];

const errors = (body: string, options: Options) =>
  compile(
    `TYPE Col : (A, B, C); END_TYPE
TYPE E2 : (X, Y); END_TYPE
TYPE EA : Col; END_TYPE
PROGRAM Main
VAR c : Col; ca : EA; ez : E2; g : BOOL; r : Col; i : INT; END_VAR
${body}
END_PROGRAM
`,
    options,
  ).errors.map((e) => e.message);

describe("SEL / MUX of enumerations", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      it("yields the enumeration", () => {
        expect(
          errors(
            "r := SEL(g, Col#A, c); r := MUX(1, Col#A, c, ca); r := SEL(G := g, IN1 := ca, IN0 := c); IF SEL(g, c, Col#B) = Col#B THEN i := 1; END_IF;",
            options,
          ),
        ).toEqual([]);
      });

      it("refuses mixing another type", () => {
        expect(errors("r := SEL(g, c, ez);", options)).toEqual([
          "The inputs of SEL must be of one type: got COL and E2",
        ]);
        expect(errors("r := MUX(0, c, Col#A, 1);", options)).toEqual([
          "The inputs of MUX must be of one type: got COL and INT",
        ]);
        expect(errors("i := SEL(g, c, Col#A);", options)).toEqual([
          "Cannot assign COL to INT",
        ]);
      });
    });
  }
});
