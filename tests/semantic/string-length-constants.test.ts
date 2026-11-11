/**
 * STRING(N) / WSTRING(N) with N an ST constant (a VAR_GLOBAL CONSTANT, a POU's
 * VAR CONSTANT, a constant expression) takes the constant's value, which the
 * C++ type needs; a caller-supplied constant keeps its name, which the C++
 * declares.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];

describe("STRING lengths named by constants", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      it("resolves global, local and computed constants", () => {
        const r = compile(
          `VAR_GLOBAL CONSTANT N : INT := 4; M : INT := N + 1; END_VAR
TYPE TS : STRUCT s : STRING(M); END_STRUCT END_TYPE
FUNCTION_BLOCK FB
VAR CONSTANT N : INT := 2; END_VAR
VAR_OUTPUT o : STRING(N); END_VAR
o := 'hello';
END_FUNCTION_BLOCK
PROGRAM Main
VAR s : STRING(N); w : WSTRING(N); a : ARRAY[0..1] OF STRING(M); t : TS; END_VAR
s := 'x';
END_PROGRAM
`,
          options,
        );
        expect(r.errors).toEqual([]);
        expect(r.headerCode).toContain("IECStringVar<4> S;");
        expect(r.headerCode).toContain("IECWStringVar<4> W;");
        expect(r.headerCode).toContain("Array1D<IECStringVar<5>, 0, 1> A;");
        expect(r.headerCode).toContain("IECStringVar<5> S");
        expect(r.headerCode).toContain("IECStringVar<2> O;");
      });

      it("keeps a caller-supplied constant's name", () => {
        const r = compile(
          `PROGRAM Main
VAR s : STRING(LD); END_VAR
s := 'x';
END_PROGRAM
`,
          { ...options, globalConstants: { LD: 3 } },
        );
        expect(r.errors).toEqual([]);
        expect(r.headerCode).toContain("IECStringVar<LD> S;");
      });
    });
  }
});
