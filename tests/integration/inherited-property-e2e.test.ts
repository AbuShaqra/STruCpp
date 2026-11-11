// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * E2E: a PROPERTY declared in a base function block, read and written on a
 * derived instance, along a member chain, through THIS and SUPER and by its
 * bare name inside the derived block. Built
 * with g++ and run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

describe.skipIf(!hasGpp)("inherited PROPERTY — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-inhprop-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("builds and runs", () => {
    const result = compile(
      `
      FUNCTION_BLOCK FBA
      VAR _p : INT := 3; END_VAR
      PROPERTY P : INT
      GET
        P := _p;
      END_GET
      SET
        _p := P;
      END_SET
      END_PROPERTY
      END_FUNCTION_BLOCK
      FUNCTION_BLOCK FBB EXTENDS FBA
      VAR_OUTPUT o : INT; END_VAR
      PROPERTY Q : INT
      GET
        Q := P * 2;
      END_GET
      SET
        P := Q + 100;
      END_SET
      END_PROPERTY
      METHOD Bump : INT
        THIS^.P := SUPER^.P + 1;
        Bump := THIS.P;
      END_METHOD
      METHOD Bare : INT
        P := P + 1;
        Bare := Q;
      END_METHOD
        o := P * 10;
      END_FUNCTION_BLOCK
      FUNCTION_BLOCK FBC EXTENDS FBB END_FUNCTION_BLOCK
      FUNCTION_BLOCK FBH
      VAR PUBLIC c : FBC; d : FBB; END_VAR
      END_FUNCTION_BLOCK
      PROGRAM Main
      VAR b : FBB; h : FBH; r1 : INT; r2 : INT; r3 : INT; r4 : INT; r5 : INT;
        r6 : INT; r7 : INT; END_VAR
        r1 := b.P;
        b.P := 7;
        r2 := b.P;
        h.c.P := 5;
        r3 := h.c.Bump();
        h.d.P := 4;
        h.d();
        r4 := h.d.o;
        r5 := h.c.P;
        r6 := h.c.Bare();
        h.d.Q := 1;
        r7 := h.d.P;
      END_PROGRAM
    `,
      { headerFileName: "generated.hpp", features: ["+self_caret"] },
    );
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "inherited_property",
      mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN prog;
    prog.run();
    std::cout << prog.R1.get() << " " << prog.R2.get() << " " << prog.R3.get() << " "
              << prog.R4.get() << " " << prog.R5.get() << " " << prog.R6.get() << " "
              << prog.R7.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("3 7 6 40 6 14 101");
  });
});
