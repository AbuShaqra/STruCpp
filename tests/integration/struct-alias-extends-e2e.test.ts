// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: an alias of a STRUCT and its target stay assignment-compatible, as
 * values and as arguments, while the derived-to-base forms are refused.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `TYPE ST_B : STRUCT a : INT; END_STRUCT END_TYPE
TYPE ST_D EXTENDS ST_B : STRUCT b : INT; END_STRUCT END_TYPE
TYPE AB : ST_B; END_TYPE
FUNCTION F : INT
VAR_INPUT p : AB; END_VAR
F := p.a;
END_FUNCTION
PROGRAM Main
VAR ab : AB; sb : ST_B; d : ST_D; x : INT; END_VAR
sb.a := 4;
ab := sb;
d.a := 2;
x := F(ab) * 10 + F(sb) + d.a * 100;
END_PROGRAM
`;

describe.skipIf(!hasGpp)("STRUCT aliases and EXTENDS — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-salias-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("builds and runs", () => {
    const result = compile(SOURCE, {
      headerFileName: "generated.hpp",
      features: ["+struct_extends"],
    });
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "struct_alias_extends",
      mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN p;
    p.run();
    std::cout << p.X.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("244");
  });
});
