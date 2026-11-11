/**
 * A STRING(n) VAR_IN_OUT or VAR_OUTPUT of a FUNCTION or METHOD is a C++
 * reference of that length: an argument of that length binds by reference,
 * one of another length is passed through a STRING(n) temporary.
 */
import { describe, it, expect } from "vitest";
import { compile, compileStlib } from "../../src/index.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["strict", { strict: true }],
  ["strict, vendor features", { strict: true, features: ["+program_methods"] }],
];

const POUS = `FUNCTION FL : INT
VAR_IN_OUT s : STRING(5); END_VAR
s := CONCAT(s, 'xyz'); FL := LEN(s);
END_FUNCTION
FUNCTION FO : INT
VAR_OUTPUT o : STRING(5); END_VAR
o := 'abcdefgh'; FO := 2;
END_FUNCTION
FUNCTION_BLOCK FB
METHOD M : INT
VAR_IN_OUT s : STRING(5); END_VAR
VAR_OUTPUT o : STRING(5); END_VAR
o := s; M := LEN(s);
END_METHOD
END_FUNCTION_BLOCK
`;

describe("STRING(n) parameters passed by reference", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      it("declares the parameters with their length", () => {
        const r = compile(
          `${POUS}PROGRAM Main
VAR f : FB; i : INT; END_VAR
i := 1;
END_PROGRAM
`,
          options,
        );
        expect(r.errors).toEqual([]);
        expect(r.headerCode).toContain("IEC_INT FL(IECStringVar<5>& S);");
        expect(r.headerCode).toContain("IEC_INT FO(IECStringVar<5>& O);");
        expect(r.headerCode).toContain(
          "IEC_INT M(IECStringVar<5>& S, IECStringVar<5>& O);",
        );
      });

      it("binds an argument of the length and copies another one", () => {
        const r = compile(
          `${POUS}PROGRAM Main
VAR f : FB; i : INT; t5, w5 : STRING(5); u, w : STRING; END_VAR
i := FL(t5) + FO(o => w5) + f.M(t5, w5);
i := FL(s := u);
i := FO(o => w);
i := f.M(u, w);
END_PROGRAM
`,
          options,
        );
        expect(r.cppCode).toContain("I = FL(T5) + FO(W5) + F.M(T5, W5);");
        expect(r.cppCode).toMatch(
          /IECStringVar<5> (__gio_\d+); \1 = U;\n\s*I = FL\(\1\);\n\s*U = \1;/,
        );
        expect(r.cppCode).toMatch(
          /IECStringVar<5> (__gio_\d+); \1 = W;\n\s*I = FO\(\1\);\n\s*W = \1;/,
        );
      });
    });
  }

  it("records the length of a library FUNCTION's output and in/out", () => {
    const lib = compileStlib([{ source: POUS, fileName: "s.st" }], {
      name: "s-lib",
      version: "1.0.0",
      namespace: "strucpp",
    });
    expect(lib.success).toBe(true);
    const fns = lib.archive!.manifest.functions;
    expect(fns.find((f) => f.name === "FL")!.parameters[0]!.maxLength).toBe(5);
    expect(fns.find((f) => f.name === "FO")!.parameters[0]!.maxLength).toBe(5);
    const method = lib
      .archive!.manifest.functionBlocks.find((b) => b.name === "FB")!
      .methods!.find((m) => m.name === "M")!;
    expect(method.parameters.map((p) => p.maxLength)).toEqual([5, 5]);
    const r = compile(
      `PROGRAM Main
VAR i : INT; u : STRING; t5 : STRING(5); END_VAR
i := FL(u) + FL(t5);
END_PROGRAM
`,
      { libraries: [lib.archive!] },
    );
    expect(r.errors).toEqual([]);
    expect(r.cppCode).toMatch(/IECStringVar<5> (__gio_\d+); \1 = U;/);
    expect(r.cppCode).toContain("FL(T5)");
  });
});
