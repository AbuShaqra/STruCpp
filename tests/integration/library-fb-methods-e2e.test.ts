// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * E2E: methods of a library function block called with named arguments in
 * any order, omitted inputs, outputs and in-outs. Built with g++ and run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile, compileStlib } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

describe.skipIf(!hasGpp)("library FB methods — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-libmeth-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("builds and runs", () => {
    const lib = compileStlib(
      [
        {
          source: `FUNCTION_BLOCK FB_Cnt
VAR_INPUT step : INT := 1; END_VAR
VAR_OUTPUT n : INT; END_VAR
METHOD Add : INT
VAR_INPUT k : INT := 3; m : INT := 1; END_VAR
VAR_OUTPUT old : INT; END_VAR
VAR_IN_OUT acc : INT; END_VAR
  old := n;
  n := n + k * m;
  acc := acc + n;
  Add := n;
END_METHOD
METHOD Reset
  n := 0;
END_METHOD
  n := n + step;
END_FUNCTION_BLOCK`,
          fileName: "cnt.st",
        },
      ],
      { name: "cnt-lib", version: "1.0.0", namespace: "strucpp" },
    );
    expect(lib.success).toBe(true);
    const result = compile(
      `PROGRAM Main
VAR tn : FB_Cnt; a : INT; b : INT; c : INT; d : INT; o : INT; s : INT; END_VAR
  a := tn.Add(acc := s);
  b := tn.Add(m := 2, k := 5, old => o, acc := s);
  c := tn.Add(1, 1, o, s);
  tn(step := 4);
  d := tn.n;
  tn.Reset();
END_PROGRAM`,
      { headerFileName: "generated.hpp", libraries: [lib.archive!] },
    );
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "library_fb_methods",
      mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN p;
    p.run();
    std::cout << p.A.get() << " " << p.B.get() << " " << p.C.get() << " " << p.D.get()
              << " " << p.O.get() << " " << p.S.get() << " " << p.TN.N.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("3 13 14 18 13 30 0");
  });
});
