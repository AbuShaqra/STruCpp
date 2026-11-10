// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * E2E: an input a call leaves out takes its declared initial value, else its
 * type's default, for function and method calls (positional and named); an
 * FB call keeps the input's current value. Built with g++ and run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

describe.skipIf(!hasGpp)("omitted inputs take their default — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-omitted-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("runs with the declared and type defaults", () => {
    const result = compile(
      `
      TYPE ST_P : STRUCT a : INT := 3; b : INT := 4; END_STRUCT END_TYPE
      TYPE E_M : (ALPHA, BETA, GAMMA); END_TYPE
      TYPE T_I : INT := 5; END_TYPE

      FUNCTION F_S : INT
      VAR_INPUT s : ST_P; k : INT := 9; END_VAR
        F_S := s.a * 100 + s.b * 10 + k;
      END_FUNCTION

      FUNCTION F_T : INT
      VAR_INPUT k : INT := 9; s : ST_P := (b := 6); END_VAR
        F_T := s.a * 100 + s.b * 10 + k;
      END_FUNCTION

      FUNCTION_BLOCK FB_X
      VAR_INPUT i : INT := 4; j : INT; END_VAR
      VAR_OUTPUT o : INT; END_VAR
      METHOD M : INT
      VAR_INPUT x : INT := 7; s : ST_P; e : E_M; t : T_I; END_VAR
      VAR_OUTPUT q : INT; END_VAR
        q := 1;
        M := x * 1000 + s.a * 100 + s.b * 10 + INT_TO_INT(t);
        IF e <> ALPHA THEN M := -1; END_IF
      END_METHOD
      METHOD Run : INT
        Run := M(1) + M();
      END_METHOD
        o := i * 10 + j;
      END_FUNCTION_BLOCK

      PROGRAM Main
      VAR
        st : ST_P := (a := 1, b := 2); fb : FB_X;
        r1 : INT; r2 : INT; r3 : INT; r4 : INT; r5 : INT; r6 : INT; r7 : INT; r8 : INT;
      END_VAR
        r1 := F_S(st);
        r2 := F_T(1);
        r3 := F_T();
        r4 := F_T(s := st);
        r5 := fb.M(2);
        r6 := fb.Run();
        fb(i := 1, j := 2);
        fb(j := 3);
        r7 := fb.o;
        r8 := fb.M(x := 3);
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
      testName: "omitted_inputs",
      mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN prog;
    prog.run();
    std::cout << prog.R1.get() << " " << prog.R2.get() << " " << prog.R3.get() << " "
              << prog.R4.get() << " " << prog.R5.get() << " " << prog.R6.get() << " "
              << prog.R7.get() << " " << prog.R8.get() << std::endl;
    return 0;
}
`,
    });
    // R1 1*100+2*10+9; R2 3*100+6*10+1; R3 k 9; R4 1*100+2*10+9;
    // R5 2*1000+345; R6 1345+7345; R7 i keeps 1: 13; R8 3345.
    expect(stdout).toBe("129 361 369 129 2345 8690 13 3345");
  });
});
