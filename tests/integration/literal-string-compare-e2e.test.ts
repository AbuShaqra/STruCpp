// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: two STRING (or WSTRING) literals compare by text, and LEN keeps its
 * argument, in a body, a variable's initial value and a STRUCT default.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `TYPE ST_Z : STRUCT a : BOOL := 'zz' > 'aa'; b : BOOL := 'aa' > 'zz'; c : BOOL := LEN('abc') = 3; d : BOOL := 'ab' = 'ab'; e : BOOL := "ab" < "b"; f : BOOL := ('zz') > ('aa'); r : REAL := INT_TO_REAL(3); m : INT := MAX(2, 7); END_STRUCT END_TYPE
PROGRAM Main
VAR w : STRING; wa, pp, sf : BOOL; sr : REAL; sm : INT; s : ST_Z; pa : BOOL := 'zz' > 'aa'; pb : BOOL := 'aa' > 'zz'; pc : BOOL := LEN('abc') = 3; pe : BOOL := 'ab' <> 'ab'; ba, bb, sa, sb, sc, sd, se : BOOL; bl : INT; END_VAR
ba := 'zz' > 'aa'; bb := 'aa' > 'zz'; bl := LEN('abcd');
sa := s.a; sb := s.b; sc := s.c; sd := s.d; se := s.e;
sf := s.f; sr := s.r; sm := s.m; pp := ('aa') > ('zz');
w := WSTRING_TO_STRING("ab"); wa := WSTRING_TO_STRING("ab") = 'ab';
END_PROGRAM
`;

describe.skipIf(!hasGpp)("literal STRING comparison — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-litstr-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("refuses STRING compared with WSTRING", () => {
    const r = compile(
      "PROGRAM Main\nVAR a : BOOL; s : STRING; ws : WSTRING; END_VAR\na := 'ab' = \"ab\";\na := s < ws;\nEND_PROGRAM\n",
    );
    expect(r.errors.map((e) => e.message)).toEqual([
      "Cannot compare STRING with WSTRING; convert one with STRING_TO_WSTRING or WSTRING_TO_STRING",
      "Cannot compare STRING with WSTRING; convert one with STRING_TO_WSTRING or WSTRING_TO_STRING",
    ]);
  });

  it("refuses a FUNCTION call in a STRUCT default", () => {
    const r = compile(
      "FUNCTION Twice : INT VAR_INPUT x : INT; END_VAR Twice := x * 2; END_FUNCTION\nTYPE ST : STRUCT a : INT := Twice(3); END_STRUCT END_TYPE\nPROGRAM Main VAR s : ST; END_VAR END_PROGRAM\n",
    );
    expect(r.errors.map((e) => e.message)).toEqual([
      "The default of STRUCT field 'ST.A' must be a constant expression: 'TWICE' is a FUNCTION call",
    ]);
  });

  for (const [label, options] of [
    ["no dialect", {}],
    ["iec-3", { dialect: "iec-3" }],
    ["strict", { strict: true }],
  ] as const) {
    it(`compares the text of two literals (${label})`, () => {
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
        testName: `litstr_${label.replace(/\W/g, "_")}`,
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.PA.get() << p.PB.get() << p.PC.get() << p.PE.get() << " "
              << p.BA.get() << p.BB.get() << " " << p.BL.get() << " "
              << p.SA.get() << p.SB.get() << p.SC.get() << p.SD.get() << p.SE.get() << " "
              << p.SF.get() << p.PP.get() << " " << p.SR.get() << " " << p.SM.get() << " "
              << p.W.get().c_str() << p.WA.get() << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe("1010 10 4 10111 10 3 7 ab1");
    });
  }

  it("refuses STRING compared with WSTRING in a STRUCT default, an array initializer and a global", () => {
    const r =
      compile(`TYPE ST : STRUCT b : BOOL := 'a' = "a"; END_STRUCT END_TYPE
VAR_GLOBAL g : BOOL := 'a' < "a"; END_VAR
PROGRAM Main
VAR x : ST; y : BOOL := 'a' = "a"; a : ARRAY[0..1] OF BOOL := ['a' = "a", TRUE]; END_VAR
END_PROGRAM
`);
    expect(r.errors.map((e) => `${e.line}:${e.column}`).sort()).toEqual([
      "1:30",
      "2:24",
      "4:25",
      "4:64",
    ]);
    expect(new Set(r.errors.map((e) => e.message))).toEqual(
      new Set([
        "Cannot compare STRING with WSTRING; convert one with STRING_TO_WSTRING or WSTRING_TO_STRING",
      ]),
    );
  });

  it("converts a literal by TO_STRING / TO_WSTRING, and compares a literal with a string operand", () => {
    const result = compile(
      `PROGRAM Main
VAR a, d : STRING; w1 : WSTRING; s : STRING := 'm'; t : STRING := 'n'; ws : WSTRING := "b"; r : ARRAY[0..13] OF BOOL; END_VAR
VAR CONSTANT CS : STRING := 'm'; END_VAR
a := TO_STRING('abc'); d := TO_STRING('$E9'); w1 := TO_WSTRING("ab");
r[0] := s > 'l'; r[1] := 'l' < s; r[2] := CS > 'l'; r[3] := 'l' < CS;
r[4] := 'ab' = CONCAT('a', 'b'); r[5] := "a" < ws; r[6] := s <= 'm'; r[7] := 'n' >= s;
r[8] := CONCAT('a', 'b') <> 'ab'; r[9] := 'l' = s; r[10] := s <= t; r[11] := s >= t;
r[12] := "b" <= ws; r[13] := ws >= "c";
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
      testName: "litstr_operand",
      mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.A.get().c_str() << " " << (int)(unsigned char)p.D.get().c_str()[0] << " "
              << p.W1.get().length() << " " << (p.W1.get() == u"ab") << " ";
    for (int i = 0; i < 14; ++i) std::cout << p.R.at(i).get();
    std::cout << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("abc 233 2 1 11111111001010");
  });
});
