/**
 * A PROGRAM or FUNCTION_BLOCK that declares ENO declares its ENO output: no
 * implicit ENO member is added next to it (that failed g++ with a
 * redeclaration), and a leaf block's ENO must be a plain BOOL.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

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
      features: ["+program_methods", "+pointer_to", "+reference_to"],
    },
  ],
];

const FB_ENO = `FUNCTION_BLOCK FB
VAR_INPUT x : INT; END_VAR
VAR_OUTPUT ENO : BOOL; END_VAR
ENO := x > 0;
END_FUNCTION_BLOCK
PROGRAM Main
VAR f : FB; a, b : BOOL; END_VAR
f(x := 1, ENO => a);
f(EN := b, x := 2, ENO => a);
END_PROGRAM
`;

describe("a declared ENO", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      it("replaces the implicit ENO member of an FB", () => {
        const r = compile(FB_ENO, options);
        expect(r.errors).toEqual([]);
        const fbClass = /class FB\b[\s\S]*?\n\};/.exec(r.headerCode)?.[0];
        expect(fbClass).toBeDefined();
        expect(fbClass).not.toContain("IEC_BOOL ENO = true;");
        expect(fbClass?.match(/\bENO\b/g)?.length).toBe(1);
      });

      it("is set TRUE before the body and read after it", () => {
        const r = compile(FB_ENO, options);
        expect(r.cppCode).toMatch(/F\.ENO = true;\n\s*F\(\);\n\s*A = F\.ENO;/);
        expect(r.cppCode).toMatch(
          /if \(B\) \{\n\s*F\.ENO = true;\n\s*F\(\);\n\s*A = F\.ENO;\n\s*\} else \{\n\s*F\.ENO = false;\n\s*A = false;\n\s*\}/,
        );
      });

      it("replaces the implicit ENO member of a PROGRAM", () => {
        const r = compile(
          `PROGRAM Main
VAR eno : BOOL; i : INT; END_VAR
eno := TRUE; i := 1;
END_PROGRAM
`,
          options,
        );
        expect(r.errors).toEqual([]);
        expect(r.headerCode).not.toContain("IEC_BOOL ENO = true;");
      });

      it("must be BOOL in a PROGRAM or a block without a base", () => {
        const fb = compile(
          `FUNCTION_BLOCK FB
VAR eno : INT; END_VAR
eno := 1;
END_FUNCTION_BLOCK
PROGRAM Main
VAR f : FB; END_VAR
f();
END_PROGRAM
`,
          options,
        );
        expect(fb.errors.map((e) => e.message)).toEqual([
          "'ENO' of FUNCTION_BLOCK FB must be BOOL: it is the block's ENO output",
        ]);
        const prog = compile(
          `PROGRAM Main
VAR ENO : ARRAY[0..1] OF BOOL; END_VAR
ENO[0] := TRUE;
END_PROGRAM
`,
          options,
        );
        expect(prog.errors.map((e) => e.message)).toEqual([
          "'ENO' of PROGRAM MAIN must be BOOL: it is the block's ENO output",
        ]);
      });

      it("of another type in a derived block still compiles", () => {
        const r = compile(
          `FUNCTION_BLOCK Base
VAR_OUTPUT o : INT; END_VAR
o := 1;
END_FUNCTION_BLOCK
FUNCTION_BLOCK Derived EXTENDS Base
VAR eno : INT; END_VAR
eno := 5; o := eno;
END_FUNCTION_BLOCK
PROGRAM Main
VAR d : Derived; i : INT; END_VAR
d(); i := d.o;
END_PROGRAM
`,
          options,
        );
        expect(r.errors).toEqual([]);
      });
    });
  }

  it("keeps the implicit ENO where none is declared", () => {
    const r = compile(`FUNCTION_BLOCK FB
VAR_OUTPUT o : INT; END_VAR
o := 3;
END_FUNCTION_BLOCK
PROGRAM Main
VAR f : FB; a : BOOL; END_VAR
f(ENO => a);
END_PROGRAM
`);
    expect(r.errors).toEqual([]);
    expect(r.headerCode).toContain("IEC_BOOL ENO = true;");
    expect(r.cppCode).toMatch(/F\(\);\n\s*A = true;\n\s*F\.ENO = true;/);
  });
});
