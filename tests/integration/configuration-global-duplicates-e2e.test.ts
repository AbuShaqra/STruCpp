// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: CONFIGURATION and RESOURCE globals under distinct names build and run;
 * declaring one of them twice is refused before any C++ is generated.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const source = (extra: string): string => `PROGRAM Main
VAR_EXTERNAL r : INT; s : DINT; t : INT; END_VAR
VAR x : DINT; END_VAR
x := r + s + t;
END_PROGRAM
CONFIGURATION Cfg
VAR_GLOBAL r : INT := 1; END_VAR
VAR_GLOBAL s : DINT := 70000; ${extra} END_VAR
RESOURCE R1 ON PLC
VAR_GLOBAL t : INT := 5; END_VAR
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM inst WITH T : Main;
END_RESOURCE
END_CONFIGURATION
`;

describe.skipIf(!hasGpp)("duplicate configuration globals — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-cfgdup-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("builds and runs distinct globals", () => {
    const result = compile(source(""), { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "configuration_global_duplicates",
      mainCode: `
#include <iostream>
int main() {
    static strucpp::Configuration_CFG cfg;
    cfg.INST.run();
    std::cout << cfg.INST.X.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("70006");
  });

  it("refuses the program once a global is declared twice", () => {
    const result = compile(source("r : DINT := 2;"), {
      headerFileName: "generated.hpp",
    });
    expect(result.success).toBe(false);
    expect(result.errors.map((e) => e.message)).toEqual([
      "Symbol 'R' already defined in scope 'CFG'",
    ]);
  });
});
