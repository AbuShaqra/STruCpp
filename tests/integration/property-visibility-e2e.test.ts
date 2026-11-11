// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: the property accesses that stay allowed build and run: PRIVATE inside
 * its block, PROTECTED in a derived block, PUBLIC from outside.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `FUNCTION_BLOCK FB_A
VAR _v : INT := 3; END_VAR
PROPERTY PRIVATE Pv : INT
GET Pv := _v; END_GET
SET _v := Pv; END_SET
END_PROPERTY
PROPERTY PROTECTED Pt : INT
GET Pt := _v * 10; END_GET
SET _v := Pt; END_SET
END_PROPERTY
PROPERTY Pub : INT
GET Pub := Pv + THIS.Pt; END_GET
END_PROPERTY
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_D EXTENDS FB_A
METHOD M : INT
Pt := 4;
M := Pt + THIS.Pt;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main
VAR f : FB_A; d : FB_D; a : INT; b : INT; END_VAR
a := f.Pub;
b := d.M();
END_PROGRAM
`;

describe.skipIf(!hasGpp)("property visibility — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-propvis-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("builds and runs", () => {
    const result = compile(SOURCE, {
      headerFileName: "generated.hpp",
      features: ["+property"],
    });
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "property_visibility",
      mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN p;
    p.run();
    std::cout << p.A.get() << " " << p.B.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("33 80");
  });
});
