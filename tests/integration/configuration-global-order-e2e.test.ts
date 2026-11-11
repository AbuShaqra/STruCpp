// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: CONFIGURATION and RESOURCE globals whose initial values name globals
 * declared after them (scalar, STRUCT, ARRAY, ADR) build and run with the
 * values those globals hold.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `TYPE ST : STRUCT u : INT; v : INT; END_STRUCT END_TYPE
PROGRAM Main
VAR_EXTERNAL a : INT; s1 : ST; arr : ARRAY[0..1] OF INT; pp : POINTER TO INT;
  r : INT; s : INT; END_VAR
VAR o1 : INT; o2 : INT; o3 : INT; o4 : INT; o5 : INT; END_VAR
o1 := a; o2 := s1.v; o3 := arr[1]; o4 := r; o5 := s;
END_PROGRAM
CONFIGURATION Cfg
VAR_GLOBAL
  a : INT := k * 10;
  s1 : ST := (u := 1, v := k + 1);
  arr : ARRAY[0..1] OF INT := [k, k * 3];
  pp : POINTER TO INT := ADR(k);
  k : INT := 4;
END_VAR
RESOURCE R ON PLC
VAR_GLOBAL r : INT := s * 2 + a; s : INT := a + 1; END_VAR
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM inst WITH T : Main;
END_RESOURCE
END_CONFIGURATION
`;

describe.skipIf(!hasGpp)("configuration global order — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-cfgorder-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("builds and runs", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "configuration_global_order",
      mainCode: `
#include <iostream>
int main() {
    static strucpp::Configuration_CFG cfg;
    cfg.INST.run();
    auto& p = cfg.INST;
    std::cout << p.O1.get() << " " << p.O2.get() << " " << p.O3.get() << " "
              << p.O4.get() << " " << p.O5.get() << " "
              << (*strucpp::PP.value.get()) << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("40 5 12 122 41 4");
  });
});
