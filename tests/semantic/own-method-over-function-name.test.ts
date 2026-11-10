/**
 * A bare call inside a PROGRAM or FUNCTION_BLOCK that names one of its
 * methods calls the method, as the generated C++ member call does, even when
 * a FUNCTION or standard function has the same name. The argument checks,
 * the type checker and codegen used to disagree on which one it was.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { compile } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";

const LIBS_DIR = path.resolve(__dirname, "../../libs");
const libsAvailable = fs.existsSync(
  path.join(LIBS_DIR, "iec-std-functions.stlib"),
);

type Options = Parameters<typeof compile>[1];
const PM = ["+program_methods"];
const MODES: Array<[string, Options]> = [
  ["no dialect", { features: PM }],
  ["iec-3", { dialect: "iec-3", features: PM }],
  ["strict", { strict: true, features: PM }],
  ...(libsAvailable
    ? ([
        [
          "with the bundled libraries",
          { features: PM, libraries: discoverStlibs(LIBS_DIR) },
        ],
      ] as Array<[string, Options]>)
    : []),
];

const USER_FN = `FUNCTION F : INT
VAR_INPUT x : INT; y : INT; END_VAR
F := x * 10 + y;
END_FUNCTION
`;

function run(src: string, options: Options): { errors: string[]; cpp: string } {
  const r = compile(src, options);
  return { errors: r.errors.map((e) => e.message), cpp: r.cppCode };
}

describe("a bare call naming an own method", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      it("calls a PROGRAM method over a FUNCTION of its name", () => {
        const r = run(
          `${USER_FN}PROGRAM Main
VAR i, j : INT; END_VAR
METHOD F : INT
VAR_INPUT b : INT; a : INT; END_VAR
F := a * 100 + b;
END_METHOD
i := F(a := 1, b := 2);
j := F(3, 4);
END_PROGRAM
`,
          options,
        );
        expect(r.errors).toEqual([]);
        expect(r.cpp).toContain("I = F(2, 1);");
        expect(r.cpp).toContain("J = F(3, 4);");
      });

      it("refuses the FUNCTION's parameter names on the method", () => {
        const r = run(
          `${USER_FN}PROGRAM Main
VAR i : INT; END_VAR
METHOD F : INT
VAR_INPUT b : INT; a : INT; END_VAR
F := a * 100 + b;
END_METHOD
i := F(x := 5, y := 6);
END_PROGRAM
`,
          options,
        );
        expect(r.errors).toEqual([
          "Method 'F' of 'MAIN' has no parameter named 'X'",
          "Method 'F' of 'MAIN' has no parameter named 'Y'",
        ]);
      });

      it("calls a PROGRAM method named like a standard function", () => {
        const r = run(
          `PROGRAM Main
VAR i, j, k : INT; END_VAR
METHOD LIMIT : INT
VAR_INPUT a : INT; b : INT; END_VAR
LIMIT := a * 100 + b;
END_METHOD
METHOD MID : INT
VAR_INPUT a : INT; END_VAR
MID := a + 1;
END_METHOD
i := LIMIT(b := 2, a := 1);
j := LIMIT(3, 4);
k := MID(a := 5) + MID(7);
END_PROGRAM
`,
          options,
        );
        expect(r.errors).toEqual([]);
        expect(r.cpp).toContain("I = LIMIT(1, 2);");
        expect(r.cpp).toContain("J = LIMIT(3, 4);");
      });

      it("calls an inherited FB method over a FUNCTION of its name", () => {
        const r = run(
          `${USER_FN}FUNCTION_BLOCK Base
METHOD F : INT
VAR_INPUT b : INT; a : INT; END_VAR
F := a * 100 + b;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK Derived EXTENDS Base
VAR_OUTPUT i, j : INT; END_VAR
i := F(a := 1, b := 2);
j := F(3, 4);
END_FUNCTION_BLOCK
FUNCTION G : INT
G := F(x := 5, y := 6);
END_FUNCTION
PROGRAM Main
VAR d : Derived; END_VAR
d();
END_PROGRAM
`,
          options,
        );
        expect(r.errors).toEqual([]);
        expect(r.cpp).toContain("I = F(2, 1);");
        expect(r.cpp).toContain("G_result = F(5, 6);");
      });

      it("types the call by the method's return type", () => {
        const r = run(
          `${USER_FN}FUNCTION_BLOCK FB
VAR_OUTPUT s : STRING; END_VAR
METHOD F : STRING
F := 'x';
END_METHOD
s := F();
END_FUNCTION_BLOCK
PROGRAM Main
VAR fbi : FB; END_VAR
fbi();
END_PROGRAM
`,
          options,
        );
        expect(r.errors).toEqual([]);
      });
    });
  }

  it("still binds a FUNCTION outside the block that has the method", () => {
    const r = run(
      `${USER_FN}PROGRAM Main
VAR i : INT; END_VAR
METHOD M : INT
M := 1;
END_METHOD
i := F(y := 6, x := 5);
END_PROGRAM
`,
      { features: PM },
    );
    expect(r.errors).toEqual([]);
    expect(r.cpp).toContain("I = F(5, 6);");
  });
});
