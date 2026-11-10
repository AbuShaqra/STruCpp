// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * E2E: a PROGRAM naming its own members as `PRG_A.x` in its body, a method
 * and an action (feature program_methods) reads and writes its own instance.
 * Built with g++ and run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

describe.skipIf(!hasGpp)("PRG_A.x inside PRG_A — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-progself-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("builds and runs", () => {
    const result = compile(
      `
      TYPE ST : STRUCT a : INT; END_STRUCT END_TYPE
      FUNCTION_BLOCK FB_T
      VAR_INPUT i : INT; END_VAR VAR_OUTPUT q : INT; END_VAR
        q := i * 2;
      END_FUNCTION_BLOCK
      PROGRAM PRG_A
      VAR x : INT; s : ST; arr : ARRAY[0..2] OF INT; t : FB_T; r : INT; END_VAR
      METHOD Bump
        PRG_A.x := PRG_A.x + 10;
      END_METHOD
        PRG_A.x := PRG_A.x + 1;
        Bump();
        PRG_A.arr[1] := PRG_A.x;
        PRG_A.s.a := PRG_A.arr[1] + 1;
        PRG_A.t(i := PRG_A.s.a);
        Act();
        ACTION Act: PRG_A.r := PRG_A.t.q; END_ACTION
      END_PROGRAM
      PROGRAM Main
      VAR y : INT; END_VAR
        y := PRG_A.r;
      END_PROGRAM
      `,
      { headerFileName: "generated.hpp", features: ["+program_methods"] },
    );
    expect(result.errors.map((e) => `${e.line}: ${e.message}`)).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "program_self_member",
      mainCode: `#include <iostream>
int main() {
  using namespace strucpp;
  Program_MAIN m;
  __program_PRG_A.run();
  __program_PRG_A.run();
  m.run();
  std::cout << __program_PRG_A.X.get() << " " << __program_PRG_A.S.A.get() << " "
            << __program_PRG_A.R.get() << " " << m.Y.get() << std::endl;
  return 0;
}
`,
    });
    expect(out).toBe("22 23 46 46");
  });
});
