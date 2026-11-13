// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: MOD by 0 gives 0 (Table 29, note e) and SHL/SHR by a count at or
 * above the width of IN give 0 (Table 30), compiled with g++ and run.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `TYPE SR : INT(0..10); END_TYPE
TYPE ST : STRUCT f : INT := 7 MOD 3; END_STRUCT END_TYPE
PROGRAM MAIN
VAR
  a : INT := 7; z : INT := 0; l : LINT := -7; lz : LINT; u : UDINT := 9; uz : UDINT;
  s : SR := 7; sz : SR := 0;
  arr : ARRAY[0..2] OF DINT := [5, 0, 3];
  m1, m2, m3, m4, m5, m6, m7, m8 : LINT; x : ST;
  n16 : INT := 16; n32 : INT := 32; n64 : INT := 64;
  bw : WORD := 16#8001; bd : DWORD := 16#80000001; bl : LWORD := 16#8000000000000001;
  i : INT := -5;
  h1, h2 : WORD; h3, h4, h5 : DWORD; h6, h7, h8 : LWORD; h9 : INT;
END_VAR
m1 := a MOD z;
m2 := (a + 1) MOD (z + 0);
m3 := MOD(a, z);
m4 := l MOD lz + l MOD 2;
m5 := UDINT_TO_LINT(u MOD uz);
m6 := s MOD sz;
m7 := arr[0] MOD arr[1] + arr[0] MOD arr[2];
m8 := x.f;
h1 := SHL(bw, n16); h2 := SHR(bw, n16);
h3 := SHL(bd, n32); h4 := SHR(bd, n32); h5 := SHL(bd, 31);
h6 := SHL(bl, n64); h7 := SHR(bl, n64); h8 := SHR(bl, 63);
h9 := SHR(i, n32);
END_PROGRAM
`;

describe.skipIf(!hasGpp)("MOD by 0 and full-width shifts — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-modshift-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const [label, options] of [
    ["no dialect", {}],
    ["iec-3", { dialect: "iec-3" }],
    ["strict", { strict: true }],
  ] as const) {
    it(`gives 0 for MOD 0 and for a shift past the width (${label})`, () => {
      const result = compile(SOURCE, {
        ...options,
        headerFileName: "generated.hpp",
      });
      expect(result.errors).toEqual([]);
      const stdout = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: `modshift_${label.replace(/\W/g, "_")}`,
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.M1.get() << " " << p.M2.get() << " " << p.M3.get() << " " << p.M4.get() << " "
              << p.M5.get() << " " << p.M6.get() << " " << p.M7.get() << " " << p.M8.get() << " "
              << p.H1.get() << " " << p.H2.get() << " " << p.H3.get() << " " << p.H4.get() << " "
              << p.H5.get() << " " << p.H6.get() << " " << p.H7.get() << " " << p.H8.get() << " "
              << p.H9.get() << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe("0 0 0 -1 0 0 2 1 0 0 0 0 2147483648 0 0 1 -1");
    });
  }
});
