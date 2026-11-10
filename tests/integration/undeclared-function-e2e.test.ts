// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * E2E: the bare calls the undeclared-function check accepts build and run:
 * a runtime helper, an inherited method and action called bare, a
 * recursive function and a macro from inline C++. Built with g++ and run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

describe.skipIf(!hasGpp)("calls the undeclared-function check accepts — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-undeclfn-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("builds and runs", () => {
    const result = compile(
      `
      FUNCTION F_REC : INT
      VAR_INPUT n : INT; END_VAR
        IF n > 0 THEN F_REC := n + F_REC(n - 1); ELSE F_REC := 0; END_IF
      END_FUNCTION

      FUNCTION_BLOCK FB_A
      VAR_OUTPUT o : INT; END_VAR
      METHOD MA : INT
        MA := 10;
      END_METHOD
      ACTION Act:
        o := o + 1;
      END_ACTION
      END_FUNCTION_BLOCK

      FUNCTION_BLOCK FB_B EXTENDS FB_A
      METHOD MB : INT
        Act();
        MB := MA() + o;
      END_METHOD
      END_FUNCTION_BLOCK

      PROGRAM Main
      VAR b : FB_B; t : TIME := T#1500MS; r1 : INT; r2 : INT; r3 : LINT; r4 : INT; END_VAR
        {external #define TWICE(x) ((x) * 2) }
        r1 := b.MB();
        r2 := F_REC(4);
        r3 := TIME_TO_US(t);
        r4 := TWICE(r2);
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
      testName: "undeclared_function",
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
    expect(stdout).toBe("11 10 1500000 20");
  });
});
