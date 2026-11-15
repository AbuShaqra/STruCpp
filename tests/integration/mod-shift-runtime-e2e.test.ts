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

// Under --strict a LINT shift count needs LINT_TO_INT, so the wide counts are left out there.
const source2 = (wide: boolean): string => `TYPE SR : INT(-5..5); END_TYPE
TYPE A : ARRAY[0..(5 MOD 0)] OF INT; END_TYPE
PROGRAM MAIN
VAR
  li : LINT := LINT#-9223372036854775808; m1 : LINT := -1; di : DINT := DINT#-2147483648; dm : DINT := -1;
  u : UDINT := 7; um : UDINT := UDINT#4294967295; s : SR := 3; sm : SR := -1;
  r1, r2, r3, r4, r5, r6 : LINT;
  bd : DWORD := 16#80000001; bl : LWORD := 16#8000000000000001; lc : LINT := LINT#4294967297; uc : ULINT := ULINT#4294967296;
  h1, h2 : DWORD; h3 : LWORD;
  b : BOOL := TRUE; n : INT := 1; n0 : INT := 0; b1, b2, b3 : BOOL; x : A;
END_VAR
r1 := li MOD m1;
r2 := MOD(li, m1);
r3 := li MOD -1;
r4 := DINT_TO_LINT(di MOD dm);
r5 := UDINT_TO_LINT(u MOD um);
r6 := INT_TO_LINT(s MOD sm);
${wide ? "h1 := SHL(bd, lc); h2 := SHR(bd, lc); h3 := SHL(bl, uc);\n" : ""}b1 := SHL(b, n); b2 := SHR(b, n); b3 := SHL(b, n0);
x[0] := 4;
END_PROGRAM
`;

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

    it(`gives 0 for MOD -1, a wide shift count and a BOOL shift (${label})`, () => {
      const result = compile(source2(label !== "strict"), {
        ...options,
        headerFileName: "generated.hpp",
      });
      expect(result.errors).toEqual([]);
      const stdout = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: `modshift2_${label.replace(/\W/g, "_")}`,
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.R1.get() << " " << p.R2.get() << " " << p.R3.get() << " " << p.R4.get() << " "
              << p.R5.get() << " " << p.R6.get() << " " << p.H1.get() << " " << p.H2.get() << " "
              << p.H3.get() << " " << p.B1.get() << p.B2.get() << p.B3.get() << " "
              << p.X.at(0).get() << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe("0 0 0 0 7 0 0 0 0 001 4");
    });

    it(`refuses MOD on a REAL reached through a pointer (${label})`, () => {
      const r = compile(
        "TYPE S : STRUCT f : REAL; END_STRUCT END_TYPE\nPROGRAM MAIN\nVAR a : REAL; i : INT; r : REAL; p : POINTER TO REAL; ps : POINTER TO S; pa : POINTER TO ARRAY[0..1] OF REAL; pl : POINTER TO LREAL; pi : POINTER TO INT; k : INT; END_VAR\nr := p^ MOD i;\nr := ps^.f MOD 2;\nr := pa^[0] MOD 2;\nr := pl^ MOD 3;\nk := pi^ MOD 2;\nEND_PROGRAM\n",
        { ...options, features: ["+pointer_to"] },
      );
      const mod = (t: string): string =>
        `MOD takes integers (ANY_INT, IEC 61131-3 Table 29), not ${t}`;
      expect(r.errors.map((e) => e.message)).toEqual([
        mod("REAL"),
        mod("REAL"),
        mod("REAL"),
        mod("LREAL"),
      ]);
    });

    it(`refuses MOD on REAL operands (${label})`, () => {
      const r = compile(
        "PROGRAM MAIN\nVAR a, b, r : REAL; END_VAR\nr := a MOD b;\nEND_PROGRAM\n",
        options,
      );
      expect(r.errors.map((e) => e.message)).toEqual([
        "MOD takes integers (ANY_INT, IEC 61131-3 Table 29), not REAL",
      ]);
    });
  }
});
