/**
 * A bare call of an FB instance in scope (a local, a member or an inherited
 * member) or of a PROGRAM invokes it, even when a FUNCTION or standard
 * function has the same name. It was refused as a call of the function.
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
    { strict: true, dialect: "iec-3", features: ["+program_methods"] },
  ],
];

const DECLS = `FUNCTION F : INT
VAR_INPUT x : INT; END_VAR
F := x;
END_FUNCTION
FUNCTION_BLOCK FB
VAR_INPUT k : INT; IN : INT; END_VAR
VAR_OUTPUT o : INT; END_VAR
o := k + IN + 7;
END_FUNCTION_BLOCK
`;

function errors(src: string, options: Options): string[] {
  return compile(src, options).errors.map((e) => e.message);
}

describe("an FB instance named like a function", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      it("is invoked as a local of a PROGRAM", () => {
        const r = compile(
          `${DECLS}PROGRAM Main
VAR f : FB; limit : FB; i : INT; e : BOOL; END_VAR
f(); f(k := 3); i := f.o;
limit(IN := 4); limit(EN := TRUE, IN := 5, ENO => e);
END_PROGRAM
`,
          options,
        );
        expect(r.errors).toEqual([]);
        expect(r.cppCode).toContain("F.K = 3;");
        expect(r.cppCode).toContain("LIMIT.IN = 4;");
      });

      it("is invoked as a member and an inherited member", () => {
        const r = compile(
          `${DECLS}FUNCTION_BLOCK Base
VAR f : FB; END_VAR
END_FUNCTION_BLOCK
FUNCTION_BLOCK Derived EXTENDS Base
VAR_OUTPUT i : INT; END_VAR
METHOD M : INT
f(k := 2); M := f.o;
END_METHOD
f(k := 1); i := f.o + M() * 100;
END_FUNCTION_BLOCK
PROGRAM Main
VAR d : Derived; END_VAR
d();
END_PROGRAM
`,
          options,
        );
        expect(r.errors).toEqual([]);
        expect(r.cppCode).toContain("F.K = 1;");
        expect(r.cppCode).toContain("F.K = 2;");
      });

      it("still checks the instance's own parameter names", () => {
        expect(
          errors(
            `${DECLS}PROGRAM Main
VAR f : FB; END_VAR
f(x := 3);
END_PROGRAM
`,
            options,
          ),
        ).toEqual(["FB has no input or output named X"]);
      });
    });
  }

  it("leaves a call of the FUNCTION alone elsewhere", () => {
    const r = compile(`${DECLS}PROGRAM Main
VAR i : INT; END_VAR
i := F(4);
END_PROGRAM
`);
    expect(r.errors).toEqual([]);
  });

  it("invokes a PROGRAM named like a standard function", () => {
    const src = `PROGRAM sub
VAR_INPUT x : INT; END_VAR
VAR_OUTPUT y : INT; END_VAR
y := x * 3;
END_PROGRAM
PROGRAM Main
VAR i : INT; END_VAR
sub(x := 2); i := sub.y;
END_PROGRAM
`;
    expect(errors(src, { features: ["+program_methods"] })).toEqual([]);
    expect(
      errors(src, {}).some((m) => m.includes("has no parameter named")),
    ).toBe(false);
  });
});
