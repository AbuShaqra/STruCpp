// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: the member accesses that stay allowed build and run: inputs written,
 * outputs read, a PUBLIC section read and written, a chain through a PUBLIC
 * FB instance, a derived block using its base's PROTECTED variables, and a
 * PRIVATE section used by its own block.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `FUNCTION_BLOCK FB_A
VAR_INPUT i : INT; END_VAR
VAR_OUTPUT o : INT; END_VAR
VAR v : INT := 5; END_VAR
VAR PRIVATE secret : INT := 7; END_VAR
VAR PUBLIC pub : INT; END_VAR
METHOD Peek : INT
  Peek := secret + THIS.secret;
END_METHOD
  o := i + v + pub;
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_D EXTENDS FB_A
METHOD Twice : INT
  Twice := v * 2 + SUPER.v;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_O
VAR PUBLIC inner : FB_A; END_VAR
END_FUNCTION_BLOCK
PROGRAM Main
VAR a : FB_A; d : FB_D; h : FB_O; r1 : INT; r2 : INT; r3 : INT; r4 : INT; END_VAR
a.i := 1;
a.pub := 100;
a();
r1 := a.o + a.pub;
r2 := d.Twice() + a.Peek();
h.inner(i := 3);
r3 := h.inner.o;
h.inner.pub := 9;
r4 := h.inner.pub;
END_PROGRAM
`;

describe.skipIf(!hasGpp)("function block member access — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-access-"));
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
      testName: "fb_member_access",
      mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN p;
    p.run();
    std::cout << p.R1.get() << " " << p.R2.get() << " " << p.R3.get() << " "
              << p.R4.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("206 29 8 9");
  });
});
