// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * E2E: the STRUCT arguments the unrelated-STRUCT check accepts build and run:
 * the same type and an alias of it, to inputs and in-outs of functions,
 * function blocks and methods. Built with g++ and run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

describe.skipIf(!hasGpp)("STRUCT arguments — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-structarg-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("builds and runs", () => {
    const result = compile(
      `
      TYPE ST_A : STRUCT a : INT; END_STRUCT END_TYPE
      TYPE T_A : ST_A; END_TYPE
      FUNCTION F : INT
      VAR_INPUT p : ST_A; END_VAR
        F := p.a;
      END_FUNCTION
      FUNCTION G : INT
      VAR_IN_OUT p : T_A; END_VAR
        p.a := p.a + 1;
        G := p.a;
      END_FUNCTION
      FUNCTION_BLOCK FB
      VAR_INPUT p : ST_A; END_VAR
      VAR_IN_OUT q : ST_A; END_VAR
      VAR_OUTPUT o : INT; END_VAR
      METHOD M : INT
      VAR_INPUT p2 : ST_A; END_VAR
        M := p2.a * 10;
      END_METHOD
        q.a := q.a + p.a;
        o := q.a;
      END_FUNCTION_BLOCK
      PROGRAM Main
      VAR a : ST_A := (a := 2); ta : T_A := (a := 5); f1 : FB;
        r1 : INT; r2 : INT; r3 : INT; r4 : INT; END_VAR
        r1 := F(ta);
        r2 := G(a) + G(ta);
        f1(p := ta, q := a);
        r3 := f1.o;
        r4 := f1.M(ta);
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
      testName: "unrelated_struct_argument",
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
    expect(stdout).toBe("5 9 9 60");
  });
});
