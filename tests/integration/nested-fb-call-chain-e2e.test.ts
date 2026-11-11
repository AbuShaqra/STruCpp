// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * E2E: function block instances invoked through member chains of any depth,
 * through STRUCT fields, ARRAY elements, THIS and a global, with and without
 * arguments. Built with g++ and run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

describe.skipIf(!hasGpp)("nested FB call chain — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-nestedfb-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("builds and runs", () => {
    const result = compile(
      `
      FUNCTION_BLOCK FBS
      VAR_INPUT k : INT; END_VAR
      VAR_OUTPUT o : INT; END_VAR
        o := o + k;
      END_FUNCTION_BLOCK
      TYPE ST : STRUCT f : FBS; END_STRUCT END_TYPE
      FUNCTION_BLOCK FBH
      VAR PUBLIC sub : FBS; s : ST; arr : ARRAY[0..1] OF ST; END_VAR
      END_FUNCTION_BLOCK
      FUNCTION_BLOCK FBT
      VAR PUBLIC h : FBH; END_VAR
      VAR_OUTPUT q : INT; END_VAR
      METHOD Run
        THIS.h.sub(k := 10);
        h.s.f(k := 20);
      END_METHOD
        q := h.sub.o + h.s.f.o;
      END_FUNCTION_BLOCK
      VAR_GLOBAL g : FBT; END_VAR
      PROGRAM Main
      VAR a : FBT; r : INT; r2 : INT; r3 : INT; r4 : INT; i : INT := 1; tq : BOOL; END_VAR
        a.h.sub(k := 3);
        a.h.sub(4);
        a.h.s.f(k := 5);
        a.h.arr[i].f(k := 6);
        a.h.arr[i].f(k := 1);
        a.Run();
        a();
        g.h.sub(k := 7);
        r := a.h.sub.o;
        r2 := a.h.s.f.o + a.h.arr[1].f.o;
        r3 := a.q;
        r4 := g.h.sub.o;
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
      testName: "nested_fb_call_chain",
      mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN p;
    p.run();
    std::cout << p.R.get() << " " << p.R2.get() << " " << p.R3.get() << " " << p.R4.get()
              << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("17 32 42 7");
  });
});
