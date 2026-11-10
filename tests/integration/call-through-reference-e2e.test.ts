// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * E2E: methods and function block bodies called through a REFERENCE TO, a
 * REF_TO and a POINTER TO a function block. Built with g++ and run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

describe.skipIf(!hasGpp)("calls through a reference — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-callref-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("builds and runs", () => {
    const result = compile(
      `
      FUNCTION_BLOCK FBM
      VAR_INPUT v : INT; END_VAR
      VAR_OUTPUT o : INT; END_VAR
      VAR n : INT; END_VAR
      METHOD M : INT
      VAR_INPUT k : INT; END_VAR
        n := n + k;
        M := n;
      END_METHOD
        o := o + v;
      END_FUNCTION_BLOCK
      PROGRAM Main
      VAR f : FBM; g : FBM; rr : REFERENCE TO FBM; q : REF_TO FBM;
        p : POINTER TO FBM; a : INT; b : INT; c : INT; d : INT; e : INT; END_VAR
        rr REF= f;
        rr(v := 2);
        e := rr.M(5);
        q := REF(g);
        q^(v := 3);
        q^.M(7);
        p := ADR(g);
        p^.M(k := 1);
        p^(4);
        a := f.o;
        b := f.M(0);
        c := g.o;
        d := q^.M(0) + p^.M(0);
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
      testName: "call_through_reference",
      mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN prog;
    prog.run();
    std::cout << prog.A.get() << " " << prog.B.get() << " " << prog.C.get() << " "
              << prog.D.get() << " " << prog.E.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("2 5 7 16 5");
  });
});
