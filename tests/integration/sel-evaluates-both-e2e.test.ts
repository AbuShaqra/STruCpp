// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: SEL and MUX evaluate every input before the call, the one not selected
 * too, as every function does (documented in IEC_COMPLIANCE.md).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `FUNCTION Count : INT
VAR_IN_OUT n : INT; END_VAR
n := n + 1; Count := n;
END_FUNCTION
PROGRAM Main
VAR n, r, m : INT; END_VAR
r := SEL(TRUE, Count(n), 7);
m := MUX(0, 5, Count(n), Count(n));
END_PROGRAM
`;

describe.skipIf(!hasGpp)("SEL and MUX evaluate every input — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-sel-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("runs the input not selected too", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "sel_both",
      mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.N.get() << " " << p.R.get() << " " << p.M.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("3 7 5");
  });
});
