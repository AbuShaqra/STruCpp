// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: SUPER(); THIS.a.b, THIS.arr[i], SUPER.s.b, SUPER.arr[i] as values and
 * targets, and SUPER.x := SUPER.x + 100 build and run.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `TYPE ST : STRUCT b : INT; END_STRUCT END_TYPE
FUNCTION_BLOCK FB_B
VAR_OUTPUT x : INT; END_VAR
VAR s : ST; arrB : ARRAY[1..2] OF INT; END_VAR
x := x + 1;
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_D EXTENDS FB_B
VAR_OUTPUT o : INT; o2 : INT; END_VAR
VAR a : ST; arr : ARRAY[1..2] OF INT; END_VAR
SUPER();
THIS.a.b := 3;
THIS.arr[2] := 4;
SUPER.s.b := 5;
SUPER.arrB[1] := 6;
o := THIS.a.b * 10 + THIS.arr[2];
o2 := SUPER.s.b * 10 + SUPER.arrB[1];
SUPER.x := SUPER.x + 100;
END_FUNCTION_BLOCK
PROGRAM Main
VAR d : FB_D; r1 : INT; r2 : INT; r3 : INT; END_VAR
d();
r1 := d.o; r2 := d.o2; r3 := d.x;
END_PROGRAM
`;

describe.skipIf(!hasGpp)("THIS and SUPER access paths — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-selfpath-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("builds and runs", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "this_super_paths",
      mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN p;
    p.run();
    std::cout << p.R1.get() << " " << p.R2.get() << " " << p.R3.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("34 56 101");
  });
});
