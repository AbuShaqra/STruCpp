// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * E2E: INSERT(IN1, IN2, P) on STRING variables and literals puts IN2 after the
 * first P characters of IN1 (IEC 61131-3). Built with g++ and run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

describe.skipIf(!hasGpp)("STRING INSERT — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-strinse2e-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("builds and runs", () => {
    const result = compile(
      `
      PROGRAM Main
      VAR s : STRING := 'ABC'; x : STRING(10) := 'XY'; r : STRING; k : INT := 2;
        s5 : STRING(5) := 'ABC'; x5 : STRING(5) := 'XYZ'; r5 : STRING(5); b8 : BOOL;
        b1 : BOOL; b2 : BOOL; b3 : BOOL; b4 : BOOL; b5 : BOOL; b6 : BOOL; b7 : BOOL; END_VAR
        r := INSERT(s, x, k);           b1 := r = 'ABXYC';
        r := INSERT(s, 'XY', 0);        b2 := r = 'XYABC';
        r := INSERT(s, x, LEN(s));      b3 := r = 'ABCXY';
        r := INSERT(s, x, 7);           b4 := r = 'ABCXY';
        r := INSERT(s, 'XY', 1);        b5 := r = 'AXYBC';
        r5 := INSERT(s5, x5, 2);        b6 := r5 = 'ABXYZ';
        r5 := INSERT(s5, 'XYZ', 2);     b8 := r5 = 'ABXYZ';
        r := INSERT(s, x, 2);           b7 := LEN(r) = 5;
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
      testName: "string_insert_e2e",
      mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN p;
    p.run();
    std::cout << p.B1.get() << p.B2.get() << p.B3.get() << p.B4.get() << p.B5.get()
              << p.B6.get() << p.B7.get() << p.B8.get() << " " << p.R.get().c_str() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("11111111 ABXYC");
  });
});
