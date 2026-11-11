/**
 * Self and super forms end to end through g++: `SUPER.M()` reaches the base
 * implementation over several inheritance levels (including a level that does
 * not override), `SUPER.member` reads a base member, and `THIS.x` and
 * `THIS^.x` (with self_caret) read and write the own instance.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const HIERARCHY = `FUNCTION_BLOCK FB_A
VAR baseN : INT := 7; END_VAR
VAR_OUTPUT count : INT; END_VAR
METHOD Value : INT
  Value := 1;
END_METHOD
METHOD Bump
  THIS.count := THIS.count + 1;
END_METHOD
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_B EXTENDS FB_A
METHOD OVERRIDE Value : INT
  Value := SUPER.Value() + 10;
END_METHOD
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_C EXTENDS FB_B
METHOD OVERRIDE Value : INT
  Value := SUPER.Value() + 100;
END_METHOD
METHOD BaseN : INT
  BaseN := SUPER.baseN;
END_METHOD
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_Gap EXTENDS FB_B
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_D EXTENDS FB_Gap
VAR log : INT; END_VAR
METHOD OVERRIDE Value : INT
  SUPER.Bump();
  Value := SUPER.Value() + 1000;
END_METHOD
END_FUNCTION_BLOCK
`;

describeIfGpp("self and super forms end to end", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-selfsuper-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function run(
    source: string,
    mainBody: string,
    name: string,
    options: Parameters<typeof compile>[1] = {},
  ): string {
    const result = compile(source, {
      headerFileName: "generated.hpp",
      ...options,
    });
    expect(result.errors.map((e) => `${e.line}: ${e.message}`)).toEqual([]);
    return compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: name,
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n${mainBody}\n return 0;\n}\n`,
    });
  }

  const PRINT =
    ' Program_MAIN p;\n p.run();\n std::cout << p.VB.get() << " " << p.VC.get() << " " << p.VD.get() << " " << p.N.get() << " " << p.CNT.get() << std::endl;';

  const MAIN_BODY = `PROGRAM MAIN
VAR b : FB_B; c : FB_C; d : FB_D; vb : INT; vc : INT; vd : INT; n : INT; cnt : INT; END_VAR
  vb := b.Value();
  vc := c.Value();
  d.Bump();
  vd := d.Value();
  n := c.BaseN();
  cnt := d.count;
END_PROGRAM
`;

  it("SUPER.M() chains through every level and SUPER.member reads the base", () => {
    const out = run(HIERARCHY + MAIN_BODY, PRINT, "selfsuper_iec", {
      dialect: "iec-3",
    });
    expect(out).toBe("11 111 1011 7 2");
  });

  it("the same program compiles and runs with no dialect flag", () => {
    const out = run(HIERARCHY + MAIN_BODY, PRINT, "selfsuper_default");
    expect(out).toBe("11 111 1011 7 2");
  });

  it("THIS^.x behaves as THIS.x with self_caret", () => {
    const src = `FUNCTION_BLOCK FB_Self
VAR total : INT; END_VAR
METHOD Add : INT
VAR_INPUT k : INT; END_VAR
  THIS^.total := THIS^.total + k;
  Add := THIS^.Twice(v := THIS.total);
END_METHOD
METHOD Twice : INT
VAR_INPUT v : INT; END_VAR
  Twice := v * 2;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR f : FB_Self; a : INT; b : INT; END_VAR
  a := f.Add(k := 3);
  b := f.Add(k := 4);
END_PROGRAM
`;
    const out = run(
      src,
      ' Program_MAIN p;\n p.run();\n std::cout << p.A.get() << " " << p.B.get() << std::endl;',
      "selfsuper_caret",
      { dialect: "iec-3", features: ["+self_caret"] },
    );
    expect(out).toBe("6 14");
  });

  it("THIS.r REF= x rebinds a member reference", () => {
    const src = `FUNCTION_BLOCK FB_Ref
VAR r : REFERENCE TO INT; END_VAR
METHOD Bind
VAR_IN_OUT target : INT; END_VAR
  THIS.r REF= target;
END_METHOD
METHOD Store
VAR_INPUT v : INT; END_VAR
  r := v;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR f : FB_Ref; x : INT; END_VAR
  f.Bind(target := x);
  f.Store(v := 42);
END_PROGRAM
`;
    const out = run(
      src,
      " Program_MAIN p;\n p.run();\n std::cout << p.X.get() << std::endl;",
      "selfsuper_refassign",
    );
    expect(out).toBe("42");
  });

  it("THIS.p REF= x on a REF_TO member and THIS^.p REF= x with self_caret", () => {
    const src = `FUNCTION_BLOCK FB_Ptr
VAR p : REF_TO INT; q : REF_TO INT; END_VAR
METHOD Bind
VAR_IN_OUT a : INT; b : INT; END_VAR
  THIS.p REF= a;
  THIS^.q REF= b;
END_METHOD
METHOD Store
  p^ := 5;
  q^ := 6;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR f : FB_Ptr; x : INT; y : INT; END_VAR
  f.Bind(a := x, b := y);
  f.Store();
END_PROGRAM
`;
    const out = run(
      src,
      ' Program_MAIN p;\n p.run();\n std::cout << p.X.get() << " " << p.Y.get() << std::endl;',
      "selfsuper_refto",
      { features: ["+self_caret"] },
    );
    expect(out).toBe("5 6");
  });
});
