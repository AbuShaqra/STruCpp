/**
 * An enumeration value used where the C++ enum class cannot go failed g++:
 * as an array index, as an integer or another enumeration's argument, and as
 * a CASE label of another type than the selector. Each is an error now,
 * through enumeration aliases too. `E#M` names the type E also where a
 * variable is named E.
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

const DECLS = `TYPE Col : (A, B, C); END_TYPE
TYPE E2 : (X, Y); END_TYPE
TYPE EA : Col; END_TYPE
FUNCTION FI : INT
VAR_INPUT k : INT; END_VAR
FI := k;
END_FUNCTION
FUNCTION FE : INT
VAR_INPUT k : EA; END_VAR
FE := 1;
END_FUNCTION
FUNCTION_BLOCK FBI
VAR_INPUT k : INT; END_VAR
END_FUNCTION_BLOCK
`;

const errors = (body: string, options: Options) =>
  compile(
    `${DECLS}PROGRAM Main
VAR c : Col := Col#B; ca : EA := Col#C; ez : E2; arr : ARRAY[0..2] OF INT;
  f : FBI; i : INT; END_VAR
${body}
END_PROGRAM
`,
    options,
  ).errors.map((e) => e.message);

describe("enumeration misuse", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      it("refuses an enumeration as an array index", () => {
        expect(errors("i := arr[c] + arr[ca] + arr[Col#A];", options)).toEqual([
          "Array index must be an integer, got COL",
          "Array index must be an integer, got COL",
          "Array index must be an integer, got COL",
        ]);
      });

      it("refuses an enumeration bound to an integer input, and the reverse", () => {
        expect(errors("i := FI(c) + FI(k := ca);", options)).toEqual([
          "Cannot assign COL to parameter 'K' of type INT",
          "Cannot assign COL to parameter 'K' of type INT",
        ]);
        expect(errors("f(k := c);", options)).toEqual([
          "Cannot assign COL to parameter 'K' of type INT",
        ]);
        expect(errors("i := FE(ez);", options)).toEqual([
          "Cannot assign E2 to parameter 'K' of type COL",
        ]);
      });

      it("accepts an enumeration and its alias for each other", () => {
        expect(errors("i := FE(c) + FE(ca) + FE(Col#A);", options)).toEqual([]);
      });

      it("refuses a CASE label of another type than the selector", () => {
        expect(
          errors(
            "CASE c OF X: i := 1; END_CASE; CASE ca OF E2#Y: i := 2; END_CASE;",
            options,
          ),
        ).toEqual([
          "CASE label of type E2 does not match the selector of type COL",
          "CASE label of type E2 does not match the selector of type COL",
        ]);
        expect(errors("CASE i OF Col#A: i := 1; END_CASE;", options)).toEqual([
          "CASE label of type COL does not match the selector of type INT",
        ]);
        expect(errors("CASE c OF 1: i := 1; END_CASE;", options)).toEqual([
          "CASE label of type INT does not match the selector of type COL",
        ]);
        expect(
          errors("CASE ca OF Col#A, B: i := 1; END_CASE;", options),
        ).toEqual([]);
      });

      it("reads E#M as the type E next to a variable named E", () => {
        expect(
          compile(
            `TYPE E : (P, Q); END_TYPE
PROGRAM Main
VAR e : E := E#Q; i : INT; END_VAR
IF e = E#Q THEN i := 1; END_IF;
END_PROGRAM
`,
            options,
          ).errors,
        ).toEqual([]);
      });
    });
  }
});
