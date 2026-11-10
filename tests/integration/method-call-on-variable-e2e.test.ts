// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * E2E: the `v.M()` calls the method-call check accepts build and run: own,
 * inherited, through an interface, on an alias of the block, and an action.
 * Built with g++ and run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

describe.skipIf(!hasGpp)("method calls on a variable — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-mcall-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("builds and runs", () => {
    const result = compile(
      `
      TYPE T_FB : FB_A; END_TYPE
      INTERFACE I_A
      METHOD M : INT
      END_METHOD
      END_INTERFACE
      FUNCTION_BLOCK FB_A IMPLEMENTS I_A
      VAR_OUTPUT o : INT; END_VAR
      METHOD M : INT
        M := 10 + o;
      END_METHOD
      ACTION Act:
        o := o + 1;
      END_ACTION
      END_FUNCTION_BLOCK
      FUNCTION_BLOCK FB_B EXTENDS FB_A
      END_FUNCTION_BLOCK
      PROGRAM Main
      VAR inst : FB_A; b : FB_B; itf : I_A; al : T_FB; r1 : INT; r2 : INT; r3 : INT; r4 : INT; END_VAR
        inst.Act();
        r1 := inst.M();
        b.Act(); b.Act();
        r2 := b.M();
        itf := b;
        r3 := itf.M();
        r4 := al.M();
      END_PROGRAM
    `,
      { headerFileName: "generated.hpp" },
    );
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "method_call_on_variable",
      mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN prog;
    prog.run();
    std::cout << prog.R1.get() << " " << prog.R2.get() << " " << prog.R3.get() << " "
              << prog.R4.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("11 12 12 10");
  });
});
