// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: AND, OR and XOR of a signed and an unsigned integer compute in the
 * signed type the checker gives them (IEC 61131-3 Figure 11), not in C++
 * promotion.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `PROGRAM Main
VAR di : DINT := -7; udi : UDINT := 4000000000; sn : SINT := -1; ud : UDINT := 1;
r1, r2, r3 : LINT; neg : BOOL; END_VAR
r1 := di XOR udi;
r2 := di OR udi;
r3 := sn XOR ud;
neg := (di OR udi) < 0;
END_PROGRAM
`;

describe.skipIf(!hasGpp)("mixed-sign AND/OR/XOR — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-mixsign-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("computes DINT XOR UDINT as a LINT", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "mixsign",
      mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.R1.get() << " " << p.R2.get() << " " << p.R3.get() << " " << p.NEG.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("-4000000007 -7 -2 1");
  });
});
