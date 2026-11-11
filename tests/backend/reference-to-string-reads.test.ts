/**
 * A REFERENCE TO STRING / WSTRING read as a value is the bound variable
 * (`rr.target()`), so string functions and comparisons take it; REF= still
 * rebinds the reference. `^` on a REFERENCE TO is refused.
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
      features: ["+reference_to", "+ref_assign"],
    },
  ],
];

const run = (body: string, options: Options) =>
  compile(
    `PROGRAM Main
VAR x : STRING(3) := 'abc'; w : WSTRING(3) := "abc"; xi : INT;
  rr : REFERENCE TO STRING(3); rw : REFERENCE TO WSTRING(3); ri : REFERENCE TO INT;
  i : INT; s : STRING; b : BOOL; END_VAR
rr REF= x; rw REF= w; ri REF= xi;
${body}
END_PROGRAM
`,
    options,
  );

describe("REFERENCE TO STRING reads", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      it("reads the bound variable in expressions", () => {
        const r = run(
          "i := LEN(rr) + LEN(rw); s := CONCAT(rr, 'x'); b := rr = 'abc'; s := rr; rr := 'xyz';",
          options,
        );
        expect(r.errors).toEqual([]);
        expect(r.cppCode).toContain("RR.bind(X);");
        expect(r.cppCode).toContain("I = LEN(RR.target()) + LEN(RW.target());");
        expect(r.cppCode).toContain("S = RR.target();");
      });

      it("refuses '^' on a REFERENCE TO", () => {
        expect(run("i := ri^;", options).errors.map((e) => e.message)).toEqual([
          "'RI' is a REFERENCE TO, dereferenced implicitly: '^' does not apply to it",
        ]);
        expect(
          run("i := LEN(rr^);", options).errors.map((e) => e.message),
        ).toEqual([
          "'RR' is a REFERENCE TO, dereferenced implicitly: '^' does not apply to it",
        ]);
      });
    });
  }
});
