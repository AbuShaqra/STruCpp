/**
 * E2E: user blocks, interfaces, types and functions named like runtime
 * functions (SUB, SEL, MID, MAX, LIMIT, ...) build with g++ and run with the
 * user's meaning, from a program and from the test runner.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import {
  hasGpp,
  createPCH,
  compileAndRunStandalone,
  runE2ETestPipeline,
} from "./test-helpers.js";

const PROGRAM = `
TYPE Mid : (Lo, Hi := 5); END_TYPE
TYPE Max : STRUCT a : INT; m : Mid; END_STRUCT; END_TYPE
TYPE Min : INT(0..100); END_TYPE
TYPE Abs : DINT; END_TYPE
TYPE Ln EXTENDS Max : STRUCT b : INT; END_STRUCT; END_TYPE
INTERFACE Sel
METHOD Get : INT
END_METHOD
END_INTERFACE
FUNCTION_BLOCK Sub IMPLEMENTS Sel
VAR_INPUT a : INT; END_VAR
VAR_OUTPUT q : INT; END_VAR
VAR st : Max; END_VAR
METHOD Get : INT
Get := q;
END_METHOD
q := a * 2;
st.a := q;
END_FUNCTION_BLOCK
FUNCTION_BLOCK Add EXTENDS Sub
VAR_INPUT b : INT; END_VAR
SUPER^();
q := q + b;
END_FUNCTION_BLOCK
FUNCTION Limit : INT
VAR_INPUT s : Max; e : Mid; END_VAR
VAR_IN_OUT f : Sub; END_VAR
f(a := s.a);
IF e = Mid#Hi THEN Limit := f.q + 1000; ELSE Limit := f.q; END_IF;
END_FUNCTION
PROGRAM Main
VAR
  s : Sub; ad : Add; arr : ARRAY[0..1] OF Sub; mx : Max; e : Mid := Mid.Hi; mn : Min := 7; ab : Abs := 9;
  l : Ln; itf : Sel; r : REF_TO Sub; x : INT; y : INT; z : INT; w : INT; k : INT;
END_VAR
s(a := 3);
ad(a := 4, b := 1);
arr[1](a := 5);
mx.a := 6; mx.m := Mid#Hi;
l.b := 2; l.a := 3;
itf := ad;
r := REF(s);
x := Limit(mx, e, arr[0]);
y := itf.Get() + r^.q;
CASE e OF Mid#Lo: z := 1; Mid.Hi: z := 2; END_CASE;
w := mn + DINT_TO_INT(ab) + l.a + l.b;
k := arr[1].q + MAX(1, 2) + SUB(9, 4) + LEN(MID('hello', 2, 2));
END_PROGRAM
`;

const FUNCTIONS = `
FUNCTION Max : INT
VAR_INPUT a : INT; b : INT; END_VAR
Max := a * 100 + b;
END_FUNCTION
FUNCTION Sel : INT
VAR_INPUT g : BOOL; a : INT; b : INT; END_VAR
Sel := a * 7;
END_FUNCTION
FUNCTION Abs : INT
VAR_INPUT a : INT; END_VAR
Abs := a * 10;
END_FUNCTION
FUNCTION Len : INT
VAR_INPUT a : INT; END_VAR
Len := a + 1;
END_FUNCTION
PROGRAM Main
VAR x : INT; END_VAR
x := Max(1, 2) + Sel(TRUE, 1, 2) + Abs(4) + Len(a := 5);
END_PROGRAM
`;

describe.skipIf(!hasGpp)("POUs named like runtime functions end to end", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-pouname-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const run = (source: string, print: string, testName: string): string => {
    const result = compile(source, {
      headerFileName: "generated.hpp",
      features: ["struct_extends"],
    });
    expect(result.errors.map((e) => `${e.line}: ${e.message}`)).toEqual([]);
    return compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName,
      mainCode: `#include <iostream>
int main() {
  strucpp::Program_MAIN p;
  p.run();
  std::cout << ${print} << std::endl;
  return 0;
}
`,
    });
  };

  it("blocks, an interface, enum, struct, alias and subrange types", () => {
    expect(
      run(
        PROGRAM,
        `(int)p.X << " " << (int)p.Y << " " << (int)p.Z << " " << (int)p.W << " " << (int)p.K`,
        "pouname_types",
      ),
    ).toBe("1012 15 2 21 19");
  });

  it("user functions win over the standard functions of their names", () => {
    // 102 + 7 + 40 + 6; the standard functions would give 2 + 1 + 4 + ...
    expect(run(FUNCTIONS, "(int)p.X", "pouname_functions")).toBe("155");
  });

  it("test code names them as declared", () => {
    const { stdout, exitCode } = runE2ETestPipeline({
      sourceST: `
TYPE Mid : (Lo, Hi); END_TYPE
FUNCTION_BLOCK Sub
VAR_INPUT a : INT; e : Mid; END_VAR
VAR_OUTPUT q : INT; END_VAR
q := Max(a, 2);
IF e = Mid#Hi THEN q := q + 100; END_IF;
END_FUNCTION_BLOCK
FUNCTION Max : INT
VAR_INPUT a : INT; b : INT; END_VAR
Max := a * 10 + b;
END_FUNCTION
`,
      testST: `
TEST 'declared names'
  VAR uut : Sub; END_VAR
  uut(a := 3, e := Mid#Hi);
  ASSERT_EQ(uut.q, 132);
  ASSERT_EQ(Max(1, 2), 12);
END_TEST
TEST 'mocked function'
  VAR uut : Sub; END_VAR
  MOCK_FUNCTION Max RETURNS 5;
  uut(a := 3, e := Mid#Lo);
  ASSERT_EQ(uut.q, 5);
END_TEST
`,
      isTestBuild: true,
      tempDirPrefix: "strucpp-pouname-test-",
    });
    expect(stdout).toContain("2 tests, 2 passed, 0 failed");
    expect(exitCode).toBe(0);
  });
});
