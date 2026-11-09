/**
 * E2E for STRUCT EXTENDS (feature struct_extends): a chain of three structs
 * with base initialisers, a structure initializer setting inherited fields,
 * an array of derived structs, a derived struct held by an FB and by another
 * STRUCT, a VAR_IN_OUT and a VAR_INPUT of the derived type, and a whole-struct
 * copy. Compiled with g++ and run. (REF, REF= and `=` on a STRUCT do not
 * compile for any STRUCT today, derived or not, so they are not exercised.)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `TYPE
  ST_C EXTENDS ST_B : STRUCT c1 : INT := 30; END_STRUCT;
  ST_A : STRUCT a1 : INT := 10; a2 : INT; END_STRUCT;
  ST_B EXTENDS ST_A : STRUCT b1 : INT := 20; END_STRUCT;
  ST_OUTER : STRUCT inner : ST_B; o1 : INT := 1; END_STRUCT;
END_TYPE

FUNCTION F_Bump : INT
VAR_IN_OUT x : ST_C; END_VAR
x.a2 := x.a2 + 100;
x.b1 := x.b1 + 100;
F_Bump := x.a1;
END_FUNCTION

FUNCTION_BLOCK FB_Hold
VAR_INPUT k : INT; END_VAR
VAR s : ST_C; END_VAR
VAR_OUTPUT sum : INT; END_VAR
s.a2 := k;
sum := s.a1 + s.a2 + s.b1 + s.c1;
END_FUNCTION_BLOCK

FUNCTION F_Sum : INT
VAR_INPUT x : ST_C; END_VAR
F_Sum := x.a1 + x.a2 + x.b1 + x.c1;
END_FUNCTION

PROGRAM Main
VAR
  c : ST_C;
  d : ST_C := (a1 := 1, a2 := 2, c1 := 4);
  arr : ARRAY[1..2] OF ST_C;
  fb : FB_Hold;
  o : ST_OUTER;
  r1, r2, r3, r4, r5, r6, r7 : INT;
END_VAR
r1 := c.a1 + c.a2 + c.b1 + c.c1;
r2 := d.a1 + d.a2 + d.b1 + d.c1;
arr[2].a2 := 5;
r3 := arr[2].a1 + arr[2].a2 + arr[1].c1;
fb(k := 7);
r4 := fb.sum;
r5 := F_Bump(x := c);
r5 := r5 + c.a2 + c.b1;
c := d;
r6 := F_Sum(x := c);
o.inner.a2 := 3;
r7 := o.inner.a1 + o.inner.a2 + o.inner.b1 + o.o1;
END_PROGRAM
`;

describe.skipIf(!hasGpp)("STRUCT EXTENDS, run end to end", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-sext-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("inherited fields hold their values in every place a struct goes", () => {
    const result = compile(SOURCE, {
      fileName: "main.st",
      features: ["+struct_extends"],
    });
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);

    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode!,
      cppCode: result.cppCode!,
      testName: "struct_extends",
      mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN prog;
    prog.run();
    std::cout << static_cast<int>(prog.R1) << " "
              << static_cast<int>(prog.R2) << " "
              << static_cast<int>(prog.R3) << " "
              << static_cast<int>(prog.R4) << " "
              << static_cast<int>(prog.R5) << " "
              << static_cast<int>(prog.R6) << " "
              << static_cast<int>(prog.R7) << std::endl;
    return 0;
}
`,
    });
    // r1 10+0+20+30, r2 1+2+20+4 (b1 keeps its default), r3 10+5+30,
    // r4 10+7+20+30, r5 10+100+120 (in-out writes back), r6 after c := d
    // 1+2+20+4, r7 10+3+20+1.
    expect(stdout).toBe("60 27 45 67 230 27 34");
  });
});
