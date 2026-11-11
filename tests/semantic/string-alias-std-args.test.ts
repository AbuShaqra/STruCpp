/**
 * A standard function's argument of an alias type is checked as the alias's
 * base type, with or without libraries loaded: LEN, CONCAT and FIND take a
 * STRING alias (also an alias of an alias); an alias of INT is still no string.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];

const TYPES = `TYPE TS : STRING(20); END_TYPE
TYPE TS2 : TS; END_TYPE
TYPE TI : INT; END_TYPE
`;

const errors = (body: string, options: Options): string[] =>
  compile(
    `${TYPES}PROGRAM Main
VAR t : TS := 'hello'; t2 : TS2 := 'ab'; i : TI := -3; n : INT; s : STRING; END_VAR
${body}
END_PROGRAM
`,
    options,
  ).errors.map((e) => e.message);

describe("standard function arguments of an alias type", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      it("accepts a STRING alias where a string is expected", () => {
        expect(
          errors(
            "n := LEN(t); s := CONCAT(t, '!'); n := LEN(t2); n := FIND(t, 'll'); n := ABS(i);",
            options,
          ),
        ).toEqual([]);
      });

      it("still refuses an INT alias where a string is expected", () => {
        expect(errors("n := LEN(i);", options)).toEqual([
          "Argument 'IN' of 'LEN' expects ANY_STRING, got TI",
        ]);
      });
    });
  }
});
