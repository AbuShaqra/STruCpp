/**
 * `r : REFERENCE TO T := REF(x)` binds r to x as it is created (g++), in a
 * PROGRAM, FUNCTION_BLOCK, FUNCTION, METHOD and a global, and is checked as
 * `r REF= x` would be.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile, type CompileOptions } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `TYPE ST_P : STRUCT a : INT; END_STRUCT; END_TYPE
VAR_GLOBAL g : INT := 6; gr : REFERENCE TO INT := REF(g); END_VAR
FUNCTION F : INT
VAR z : INT := 4; r : REFERENCE TO INT := REF(z); END_VAR
r := r + 1;
F := z;
END_FUNCTION
FUNCTION_BLOCK FB_A
VAR y : INT := 3; r : REFERENCE TO INT := REF(y); END_VAR
VAR_OUTPUT q, mo : INT; END_VAR
METHOD M : INT
VAR w : INT := 8; rw : REFERENCE TO INT := REF(w); END_VAR
rw := rw * 2;
M := w;
END_METHOD
r := r + 10;
q := y;
mo := M();
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR
  x : INT := 5;
  rx : REFERENCE TO INT := REF(x);
  s : ST_P;
  rs : REFERENCE TO ST_P := REF(s);
  arr : ARRAY[0..2] OF INT;
  re : REFERENCE TO INT := REF(arr[1]);
  st : STRING := 'ab';
  rst : REFERENCE TO STRING := REF(st);
  fb : FB_A;
  fromF, viaG, len : INT;
END_VAR
rx := 50;
rs.a := 9;
re := 7;
rst := 'xyz';
gr := gr + 1;
fromF := F();
fb();
viaG := g;
len := LEN(st);
END_PROGRAM
`;

describe.skipIf(!hasGpp)("REFERENCE TO initial value", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-refto-init-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("binds the reference in every place a variable is declared", () => {
    for (const [opts, name] of [
      [{}, "refto_init_default"],
      [{ strict: true }, "refto_init_strict"],
    ] as [Partial<CompileOptions>, string][]) {
      const result = compile(SOURCE, {
        headerFileName: "generated.hpp",
        ...opts,
      });
      expect(result.errors).toEqual([]);
      const out = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: name,
        mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p; p.run();\n std::cout << (int)p.X.get() << " " << (int)p.S.A.get() << " " << (int)p.ARR.at(1).get() << " " << (int)p.LEN.get() << " " << (int)p.VIAG.get() << " " << (int)p.FROMF.get() << " " << (int)p.FB.Q.get() << " " << (int)p.FB.MO.get();\n return 0;\n}\n`,
      });
      expect(out.trim().split(/\s+/)).toEqual([
        "50",
        "9",
        "7",
        "3",
        "7",
        "5",
        "13",
        "16",
      ]);
    }
  });

  it("checks the variable as REF= does", () => {
    const src = `TYPE MYINT : INT; END_TYPE
PROGRAM MAIN
VAR d : DINT; m : MYINT; x : INT; END_VAR
VAR bad : REFERENCE TO INT := REF(d); END_VAR
VAR al : REFERENCE TO INT := REF(m); END_VAR
x := 1;
END_PROGRAM
`;
    const r = compile(src, {});
    expect(r.errors.map((e) => `${e.line}:${e.column}: ${e.message}`)).toEqual([
      "4:35: REFERENCE TO INT cannot refer to a DINT variable",
    ]);
    const r2 = compile(
      src.replace("VAR bad : REFERENCE TO INT := REF(d); END_VAR\n", ""),
      {},
    );
    expect(r2.errors.map((e) => e.message)).toEqual([
      "binding a REFERENCE TO INT to a variable of alias type 'MYINT' is not supported yet",
    ]);
  });
});
