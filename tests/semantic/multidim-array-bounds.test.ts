/**
 * LOWER_BOUND / UPPER_BOUND of a fixed two- or three-dimensional array with
 * a literal dimension it does not have is an error (the call failed g++ for
 * every dimension before); a one-dimensional array answers any dimension.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];

const errors = (body: string, options: Options) =>
  compile(
    `TYPE T2 : ARRAY[1..2, 3..4] OF INT; END_TYPE
PROGRAM Main
VAR m2 : ARRAY[1..3, 0..4] OF INT; m3 : ARRAY[0..1, 2..5, -1..1] OF INT;
  a1 : ARRAY[2..7] OF INT; t2 : T2; d : DINT; END_VAR
${body}
END_PROGRAM
`,
    options,
  ).errors.map((e) => e.message);

describe("LOWER_BOUND / UPPER_BOUND dimensions", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      it("accepts the dimensions the array has, and any for 1D", () => {
        expect(
          errors(
            "d := UPPER_BOUND(m2, 2) + LOWER_BOUND(m3, 3) + UPPER_BOUND(t2, 1) + UPPER_BOUND(a1, 2) + LOWER_BOUND(m2, d);",
            options,
          ),
        ).toEqual([]);
      });

      it("refuses a literal dimension the array does not have", () => {
        expect(
          errors(
            "d := UPPER_BOUND(m2, 3) + LOWER_BOUND(m3, 0) + UPPER_BOUND(t2, 5);",
            options,
          ),
        ).toEqual([
          "UPPER_BOUND has no dimension 3: the array has 2",
          "LOWER_BOUND has no dimension 0: the array has 3",
          "UPPER_BOUND has no dimension 5: the array has 2",
        ]);
      });
    });
  }
});
