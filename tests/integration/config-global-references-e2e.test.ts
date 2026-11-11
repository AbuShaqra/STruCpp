// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: CONFIGURATION globals of type REF_TO and POINTER TO, bound in their
 * initial values (REF(g), ADR(g)), dereferenced through VAR_EXTERNAL in a
 * program for reading and writing, including a field through a REF_TO STRUCT.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `TYPE ST : STRUCT a : INT; b : INT; END_STRUCT END_TYPE
PROGRAM Main
VAR_EXTERNAL g : INT; s : ST; p : REF_TO INT; q : POINTER TO INT; ps : REF_TO ST; END_VAR
VAR x : INT; y : INT; z : INT; w : INT; v : INT; END_VAR
y := p^;
z := q^;
p^ := 9;
q^ := q^ + 1;
ps^.b := 7;
v := ps^.a * 100 + ps^.b;
w := g;
END_PROGRAM
CONFIGURATION Cfg
VAR_GLOBAL
  p : REF_TO INT := REF(g);
  q : POINTER TO INT := ADR(g);
  ps : REF_TO ST := REF(s);
  g : INT := 4;
  s : ST := (a := 3);
END_VAR
RESOURCE R ON PLC
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM inst WITH T : Main;
END_RESOURCE
END_CONFIGURATION
`;

describe.skipIf(!hasGpp)("CONFIGURATION global references — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-cfgref-"));
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
      testName: "config_global_references",
      mainCode: `
#include <iostream>
int main() {
    static strucpp::Configuration_CFG cfg;
    cfg.INST.run();
    auto& p = cfg.INST;
    std::cout << p.Y.get() << " " << p.Z.get() << " " << p.W.get() << " "
              << p.V.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("4 4 10 307");
  });
});
