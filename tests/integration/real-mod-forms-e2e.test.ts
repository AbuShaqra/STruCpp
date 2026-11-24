// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E (g++): what development accepted and g++ then rejected is refused, and
 * the integer and POINTER TO forms on the same routes build and run: MOD
 * through a named pointer type, a computed dereference, a STRUCT default, a
 * global constant and the function form; `__DELETE` of a POINTER TO by alias,
 * member and element; and in a test file `((a)) = (b)` of two STRUCTs.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import {
  hasGpp,
  createPCH,
  compileAndRunStandalone,
  runE2ETestPipeline,
} from "./test-helpers.js";

const SOURCE = `TYPE PI : POINTER TO INT; END_TYPE
TYPE ST : STRUCT a : INT := 7 MOD 3; b : INT := MOD(9, 4); p : PI; pa : POINTER TO ARRAY[0..3] OF INT; END_STRUCT; END_TYPE
VAR_GLOBAL CONSTANT C : INT := 8 MOD 5; END_VAR
PROGRAM MAIN
VAR
  i : INT := 7; q : PI; pi : POINTER TO INT; s : ST; arr : ARRAY[0..1] OF PI;
  m1, m2, m3, m4, m5, m6, m7 : INT; freed : BOOL; b : BOOL := TRUE;
  pa : POINTER TO ARRAY[0..3] OF INT;
END_VAR
q := __NEW(INT); q^ := 7; pi := ADR(i);
m1 := q^ MOD 4;
m2 := (pi^ + 1) MOD 3;
m3 := MOD(i, 5);
m4 := C + s.a + s.b;
s.p := __NEW(INT); s.p^ := 11; m5 := s.p^ MOD 4;
arr[1] := __NEW(INT); arr[1]^ := 13; m6 := arr[1]^ MOD 5;
pa := __NEW(INT, 4); (* s.pa stays NULL: __DELETE of NULL does nothing *)
m7 := SEL(b, i, 3) MOD 4 + LIMIT(0, i, 9) MOD 5;
__DELETE(s.p); __DELETE(arr[1]); __DELETE((q)); __DELETE(pa); __DELETE(s.pa);
freed := s.p = 0 AND arr[1] = 0 AND q = 0 AND pa = 0 AND s.pa = 0;
END_PROGRAM
`;

/** Forms development accepted that g++ rejected, each with the error now given. */
const REFUSED: Array<[string, string, string]> = [
  [
    "named pointer type",
    "TYPE PR : POINTER TO REAL; END_TYPE\nPROGRAM MAIN\nVAR x : REAL := 5.5; p : PR; r : REAL; END_VAR\np := ADR(x);\nr := p^ MOD 2;\nEND_PROGRAM\n",
    "MOD takes integers (ANY_INT, IEC 61131-3 Table 29), not REAL",
  ],
  [
    "computed dereference",
    "PROGRAM MAIN\nVAR x : REAL := 5.5; p : POINTER TO REAL; r : REAL; END_VAR\np := ADR(x);\nr := (p^ + 1.0) MOD 2;\nEND_PROGRAM\n",
    "MOD takes integers (ANY_INT, IEC 61131-3 Table 29), not REAL",
  ],
  [
    "STRUCT default",
    "TYPE S : STRUCT a : REAL := 5.5 MOD 2; END_STRUCT; END_TYPE\nPROGRAM MAIN\nVAR s : S; END_VAR\ns.a := 1.0;\nEND_PROGRAM\n",
    "MOD takes integers (ANY_INT, IEC 61131-3 Table 29), not REAL",
  ],
  [
    "global constant",
    "VAR_GLOBAL CONSTANT C : REAL := 5.5 MOD 2; END_VAR\nPROGRAM MAIN\nVAR r : REAL; END_VAR\nr := C;\nEND_PROGRAM\n",
    "MOD takes integers (ANY_INT, IEC 61131-3 Table 29), not REAL",
  ],
  [
    "function form on a dereference",
    "PROGRAM MAIN\nVAR x : REAL := 5.5; p : POINTER TO REAL; r : REAL; END_VAR\np := ADR(x);\nr := MOD(p^, 2);\nEND_PROGRAM\n",
    "MOD takes integers (ANY_INT, IEC 61131-3 Table 29), not REAL",
  ],
  [
    "SEL of REALs",
    "PROGRAM MAIN\nVAR x : REAL := 5.5; b : BOOL; r : REAL; END_VAR\nr := SEL(b, x, 2.5) MOD 2;\nEND_PROGRAM\n",
    "MOD takes integers (ANY_INT, IEC 61131-3 Table 29), not REAL",
  ],
  [
    "MOD() of a LIMIT of REALs",
    "PROGRAM MAIN\nVAR x : REAL := 5.5; r : REAL; END_VAR\nr := MOD(LIMIT(0.0, x, 9.0), 2);\nEND_PROGRAM\n",
    "MOD takes integers (ANY_INT, IEC 61131-3 Table 29), not REAL",
  ],
  [
    "__DELETE of a PROPERTY",
    "FUNCTION_BLOCK FB\nVAR v : POINTER TO INT; END_VAR\nPROPERTY PP : POINTER TO INT\nGET\nPP := v;\nEND_GET\nEND_PROPERTY\nEND_FUNCTION_BLOCK\nPROGRAM MAIN\nVAR f : FB; END_VAR\n__DELETE(f.PP);\nEND_PROGRAM\n",
    "__DELETE takes a POINTER TO variable (what __NEW returns), not a PROPERTY",
  ],
  [
    "__DELETE of a REF_TO",
    "PROGRAM MAIN\nVAR r : REF_TO INT; x : INT; END_VAR\nr := REF(x);\n__DELETE(r);\nEND_PROGRAM\n",
    "__DELETE takes a POINTER TO variable (what __NEW returns), not REF_TO INT",
  ],
  [
    "STRUCT default with a short LIMIT",
    "TYPE S : STRUCT a : INT := LIMIT(1, 2); END_STRUCT; END_TYPE\nPROGRAM MAIN\nVAR s : S; END_VAR\ns.a := 1;\nEND_PROGRAM\n",
    "'LIMIT' requires 3 argument(s), got 2",
  ],
];

describe.skipIf(!hasGpp)("REAL MOD and other forms — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-realmod-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const [label, options] of [
    ["no dialect", {}],
    ["strict", { strict: true }],
  ] as const) {
    it(`builds and runs integer MOD and __DELETE on the same routes (${label})`, () => {
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
        testName: `realmod_${label.replace(/\W/g, "_")}`,
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.M1.get() << " " << p.M2.get() << " " << p.M3.get() << " " << p.M4.get() << " "
              << p.M5.get() << " " << p.M6.get() << " " << p.M7.get() << " " << p.FREED.get() << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe("3 2 2 5 3 3 5 1");
    });
  }

  for (const [label, source, message] of REFUSED) {
    it(`refuses what g++ rejects: ${label}`, () => {
      const result = compile(source, { headerFileName: "generated.hpp" });
      expect(result.errors.map((e) => e.message)).toEqual([message]);
    });
  }

  it("frees a POINTER TO ARRAY in a test file", () => {
    const { stdout, exitCode } = runE2ETestPipeline({
      sourceST: `TYPE S : STRUCT p : POINTER TO ARRAY[0..3] OF INT; END_STRUCT; END_TYPE
PROGRAM Main
VAR x : INT; END_VAR
x := x + 1;
END_PROGRAM
`,
      testST: `TEST 'free an array'
  VAR p : POINTER TO ARRAY[0..3] OF INT; s : S; END_VAR
  p := __NEW(INT, 4);
  __DELETE(p); __DELETE(s.p);
  ASSERT_TRUE(p = 0);
  ASSERT_TRUE(s.p = 0);
END_TEST
`,
      tempDirPrefix: "strucpp-realmod-test-",
    });
    expect(stdout).toContain("[PASS] free an array");
    expect(exitCode).toBe(0);
  });

  it("compares two parenthesized STRUCTs memberwise in a test file", () => {
    const source = `TYPE S : STRUCT a : INT; b : REAL; END_STRUCT; END_TYPE
PROGRAM Main
VAR x : INT; END_VAR
x := x + 1;
END_PROGRAM
`;
    const test = `TEST 'parenthesized STRUCT compare'
  VAR p1 : S; p2 : S; ok : BOOL; nk : BOOL; END_VAR
  p1.a := 1; p2.a := 1;
  ok := ((p1)) = (p2);
  nk := ((p1)) <> p2;
  ASSERT_TRUE(ok);
  ASSERT_FALSE(nk);
  p2.b := 2.0;
  ASSERT_FALSE((p1) = ((p2)));
END_TEST
`;
    const { stdout, exitCode } = runE2ETestPipeline({
      sourceST: source,
      testST: test,
      tempDirPrefix: "strucpp-realmod-test-",
    });
    expect(stdout).toContain("[PASS] parenthesized STRUCT compare");
    expect(exitCode).toBe(0);
  });
});
