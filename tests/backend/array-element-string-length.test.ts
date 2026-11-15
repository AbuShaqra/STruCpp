/**
 * Elements of an ARRAY OF STRING(n) or ARRAY OF REF_TO STRING(n), inline or
 * named, keep their length: in the C++ element type, in the type checker
 * (REF_TO assignment, in-out binding) and for ARRAY[*] OF STRING(n).
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { withoutSites } from "../support/fault-sites.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
  [
    "strict, vendor features",
    {
      strict: true,
      dialect: "iec-3",
      features: ["+pointer_to", "+reference_to"],
    },
  ],
];

function run(src: string, options: Options) {
  const r = compile(src, options);
  return { errors: r.errors.map((e) => e.message), r };
}

describe("array element STRING length", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      it("gives inline and named arrays elements of the length", () => {
        const { errors, r } = run(
          `TYPE TA : ARRAY[0..1] OF STRING(3); END_TYPE
TYPE TR : ARRAY[0..1] OF REF_TO STRING(3); END_TYPE
TYPE TS : STRUCT f : ARRAY[0..1] OF STRING(4); END_STRUCT END_TYPE
PROGRAM Main
VAR a : ARRAY[0..1] OF STRING(3); b : TA; ra : ARRAY[0..1] OF REF_TO STRING(3);
  rb : TR; w : ARRAY[0..1] OF WSTRING(2); st : TS; x : STRING(3); END_VAR
a[0] := 'abcdef'; ra[0] := REF(x); rb[1] := REF(a[1]);
END_PROGRAM
`,
          options,
        );
        expect(errors).toEqual([]);
        expect(withoutSites(r.headerCode)).toContain(
          "using TA = Array1D<IECStringVar<3>, 0, 1>;",
        );
        expect(withoutSites(r.headerCode)).toContain(
          "using TR = Array1D<IEC_REF_TO<IECString<3>>, 0, 1>;",
        );
        expect(withoutSites(r.headerCode)).toContain("Array1D<IECStringVar<3>, 0, 1> A;");
        expect(withoutSites(r.headerCode)).toContain(
          "Array1D<IEC_REF_TO<IECString<3>>, 0, 1> RA;",
        );
        expect(withoutSites(r.headerCode)).toContain("Array1D<IECWStringVar<2>, 0, 1> W;");
        expect(withoutSites(r.headerCode)).toContain("Array1D<IECStringVar<4>, 0, 1> F{};");
      });

      it("refuses a REF_TO element holding a reference of another length", () => {
        expect(
          run(
            `PROGRAM Main
VAR y : STRING; ra : ARRAY[0..1] OF REF_TO STRING(3); END_VAR
ra[1] := REF(y);
END_PROGRAM
`,
            options,
          ).errors,
        ).toEqual([
          "Cannot assign REF_TO STRING to REF_TO STRING(3): a REF_TO can only hold a reference to its declared type",
        ]);
      });

      it("binds an element to an in-out of its length", () => {
        const { errors, r } = run(
          `FUNCTION F : INT
VAR_IN_OUT s : STRING(3); END_VAR
F := LEN(s);
END_FUNCTION
PROGRAM Main
VAR a : ARRAY[0..1] OF STRING(3); i : INT; END_VAR
i := F(a[0]);
END_PROGRAM
`,
          options,
        );
        expect(errors).toEqual([]);
        expect(r.warnings).toEqual([]);
        expect(withoutSites(r.cppCode)).toContain("I = F(A.at(0));");
      });

      it("keeps arrays of another element length assignable and passable", () => {
        const { errors, r } = run(
          `FUNCTION FI : INT
VAR_IN_OUT x : ARRAY[0..1] OF STRING; END_VAR
FI := LEN(x[0]);
END_FUNCTION
FUNCTION FV : INT
VAR_IN_OUT x : ARRAY[*] OF STRING(3); END_VAR
FV := LEN(x[0]);
END_FUNCTION
PROGRAM Main
VAR a : ARRAY[0..1] OF STRING(3); b : ARRAY[0..1] OF STRING; i : INT; END_VAR
b := a; a := b;
i := FI(a) + FV(b) + FV(a);
END_PROGRAM
`,
          options,
        );
        expect(errors).toEqual([]);
        expect(withoutSites(r.cppCode)).toMatch(
          /Array1D<IEC_STRING, 0, 1> (__gio_\d+); \1 = A;/,
        );
        expect(withoutSites(r.cppCode)).toMatch(
          /array_rebind_t<typename std::decay<decltype\(B\)>::type, IECStringVar<3>> (__gio_\d+); \1 = B;/,
        );
        expect(withoutSites(r.cppCode)).toContain("FV(A)");
      });
    });
  }
});
