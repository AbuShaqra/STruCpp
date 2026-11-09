/**
 * E2E for named global variable lists (feature named_global_lists): two lists
 * declaring the same name, a local of that name, and a local hiding a global
 * the list is the only one to declare. Compiled with g++ and run; every
 * variable keeps its own value.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const GVL_A = `VAR_GLOBAL
  x : INT := 1;
  y : INT := 10;
  fb : FB_Add;
  arr : ARRAY[1..3] OF INT := [4, 5, 6];
END_VAR
VAR_GLOBAL CONSTANT
  k : INT := 7;
END_VAR
`;

const GVL_B = `VAR_GLOBAL
  x : INT := 2;
END_VAR
`;

const MAIN = `FUNCTION_BLOCK FB_Add
VAR_INPUT a : INT; END_VAR
VAR_OUTPUT out : INT; END_VAR
out := a + GVL_A.y;
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_Use
VAR x : INT := 100; y : INT := 1000; k : INT := 3; END_VAR
METHOD M : INT
GVL_A.x := GVL_A.x + 1;
GVL_B.x := GVL_B.x + 2;
x := x + 1;
GVL_A.y := GVL_A.y + k + GVL_A.k;
y := y + 1;
M := x;
END_METHOD
END_FUNCTION_BLOCK

PROGRAM Main
VAR
  x : INT := 50;
  y : INT := 500;
  fb : INT;
  m : INT;
  o : FB_Use;
END_VAR
GVL_A.x := GVL_A.x + 10;
GVL_B.x := GVL_B.x + 20;
x := x + 1;
y := y + GVL_A.y;
GVL_A.fb.a := GVL_A.arr[2] + GVL_A.y;
fb := GVL_A.fb.a;
m := o.M();
GVL_A.arr[3] := GVL_A.x + GVL_B.x;
END_PROGRAM
`;

describe.skipIf(!hasGpp)("named global lists, run end to end", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-gvl-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("GVL_A.x, GVL_B.x and a local x stay distinct, in a program and an FB method", () => {
    const result = compile(MAIN, {
      fileName: "main.st",
      additionalSources: [
        { source: GVL_A, fileName: "GVL_A.st" },
        { source: GVL_B, fileName: "lists/b.st", globalListName: "GVL_B" },
      ],
      features: ["+named_global_lists"],
    });
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);

    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode!,
      cppCode: result.cppCode!,
      testName: "named_global_lists",
      mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN prog;
    prog.run();
    std::cout << static_cast<int>(strucpp::GVL_A__X) << " "
              << static_cast<int>(strucpp::GVL_B__X) << " "
              << static_cast<int>(prog.X) << " "
              << static_cast<int>(prog.Y) << " "
              << static_cast<int>(prog.FB) << " "
              << static_cast<int>(prog.M) << " "
              << static_cast<int>(prog.O.X) << " "
              << static_cast<int>(prog.O.Y) << " "
              << static_cast<int>(strucpp::Y) << " "
              << static_cast<int>(strucpp::ARR.at(3)) << std::endl;
    return 0;
}
`,
    });
    // GVL_A.x 1+10+1, GVL_B.x 2+20+2, local x 50+1, local y 500+10,
    // fb 5+10 (member chain; the local fb hides the global fb),
    // member x 100+1, member y 1000+1, GVL_A.y 10+3+7 (member k hides
    // GVL_A.k), arr[3] 12+24.
    expect(stdout).toBe("12 24 51 510 15 101 101 1001 20 36");
  });
});
