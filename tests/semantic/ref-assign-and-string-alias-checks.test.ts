/**
 * REF= is checked as REF() into a REF_TO is: the target's referenced type
 * and STRING length must match the variable bound. An alias of STRING(n) is
 * that STRING(n) for REF_TO, REF= and REFERENCE TO inputs alike.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["strict", { strict: true }],
  [
    "strict, vendor features",
    {
      strict: true,
      dialect: "iec-3",
      features: ["+pointer_to", "+reference_to", "+ref_assign"],
    },
  ],
];

const errors = (body: string, options: Options, decls = "") =>
  compile(
    `TYPE S3 : STRING(3); END_TYPE
${decls}PROGRAM Main
VAR x3 : STRING(3); xs : STRING; xa : S3; xi : INT; xr : REAL;
  rr3 : REFERENCE TO STRING(3); rri : REFERENCE TO INT; rra : REFERENCE TO S3;
  r3 : REF_TO STRING(3); ri : REF_TO INT; ra : REF_TO S3; rs : REF_TO STRING; END_VAR
${body}
END_PROGRAM
`,
    options,
  ).errors.map((e) => e.message);

describe("REF= and STRING alias reference checks", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      it("accepts REF= of the referenced type and length", () => {
        expect(
          errors(
            "rr3 REF= x3; rri REF= xi; r3 REF= x3; ri REF= xi; rri REF= rri;",
            options,
          ),
        ).toEqual([]);
      });

      it("refuses REF= of another type or STRING length", () => {
        expect(errors("rr3 REF= xs;", options)).toEqual([
          "REFERENCE TO STRING(3) cannot refer to a STRING variable",
        ]);
        expect(errors("rri REF= xr;", options)).toEqual([
          "REFERENCE TO INT cannot refer to a REAL variable",
        ]);
        expect(errors("ri REF= xr;", options)).toEqual([
          "REF_TO INT cannot refer to a REAL variable",
        ]);
        expect(errors("rra REF= xs;", options)).toEqual([
          "REFERENCE TO STRING(3) cannot refer to a STRING variable",
        ]);
      });

      it("treats an alias of STRING(3) as STRING(3) for REF_TO", () => {
        expect(errors("r3 := REF(xa); ra := REF(x3);", options)).toEqual([]);
        expect(errors("ra := REF(xs);", options)).toEqual([
          "Cannot assign REF_TO STRING to REF_TO STRING(3): a REF_TO can only hold a reference to its declared type",
        ]);
        expect(errors("rs := REF(xa);", options)).toEqual([
          "Cannot assign REF_TO STRING(3) to REF_TO STRING: a REF_TO can only hold a reference to its declared type",
        ]);
      });

      it("checks the STRING length of a REFERENCE TO input", () => {
        const decls = `FUNCTION FR : INT
VAR_INPUT r : REFERENCE TO STRING(3); END_VAR
FR := 1;
END_FUNCTION
`;
        expect(errors("xi := FR(x3);", options, decls)).toEqual([]);
        expect(errors("xi := FR(xs);", options, decls)).toEqual([
          "REFERENCE TO STRING(3) cannot refer to a STRING variable",
        ]);
      });
    });
  }
});
