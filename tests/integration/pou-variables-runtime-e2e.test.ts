// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: a VAR_TEMP of a FUNCTION_BLOCK or PROGRAM starts from its initial
 * value at every call, and a METHOD's VAR_INST starts from its initial value
 * once, then keeps its value between calls.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE2 = `FUNCTION_BLOCK Cnt
VAR_INPUT start : INT; END_VAR
VAR_OUTPUT n : INT; END_VAR
n := n + 1 + start;
END_FUNCTION_BLOCK
TYPE S : STRUCT a : INT; c : Cnt; END_STRUCT; END_TYPE
FUNCTION_BLOCK FB
VAR_TEMP c : Cnt := (start := 5); ts : S; arr : ARRAY[0..1] OF Cnt; END_VAR
VAR_OUTPUT o, o1, o2 : INT; END_VAR
METHOD M : INT
VAR_TEMP mc : Cnt; END_VAR
mc(); M := mc.n;
END_METHOD
METHOD K : INT
VAR_INST kc : Cnt; END_VAR
kc(start := 0); K := kc.n;
END_METHOD
c(); o := c.n; ts.c(); o1 := ts.c.n; arr[1](); o2 := arr[1].n;
END_FUNCTION_BLOCK
FUNCTION_BLOCK Base
VAR_TEMP bt : INT := 1; END_VAR
VAR_OUTPUT bo : INT; END_VAR
bt := bt + 1; bo := bt;
END_FUNCTION_BLOCK
FUNCTION_BLOCK D3 EXTENDS Base
VAR_OUTPUT o3 : INT; END_VAR
bt := bt + 10; o3 := bt;
END_FUNCTION_BLOCK
FUNCTION_BLOCK D4 EXTENDS Base
VAR_OUTPUT o4 : INT; END_VAR
bt := bt + 10; SUPER^(); o4 := bt;
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR fb : FB; a, a1, a2, m, k, e, f, g : INT; d3 : D3; d4 : D4; b : Base; END_VAR
fb(); fb(); a := fb.o; a1 := fb.o1; a2 := fb.o2; m := fb.M(); m := fb.M(); k := fb.K(); k := fb.K();
d3(); d3(); e := d3.o3; d4(); d4(); f := d4.o4; b(); b(); g := b.bo;
END_PROGRAM
`;

const SOURCE = `PROGRAM Sub
VAR_TEMP t : INT; END_VAR
VAR_OUTPUT o : INT; END_VAR
t := t + 1; o := t;
END_PROGRAM
FUNCTION_BLOCK FB
VAR_TEMP t : INT := 5; s : STRING := 'x'; arr : ARRAY[0..1] OF INT; END_VAR
VAR_OUTPUT o : INT; os : STRING; END_VAR
METHOD M : INT
VAR_INST k : INT := 40; v : ARRAY[0..1] OF INT := [7, 8]; END_VAR
k := k + 1; M := k * 100 + v[1];
END_METHOD
t := t + 1; s := CONCAT(s, 'y'); arr[0] := arr[0] + 1;
o := t * 10 + arr[0]; os := s;
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR fb : FB; a, b, c, d : INT; s : STRING; END_VAR
fb(); fb(); a := fb.o; s := fb.os;
Sub(); Sub(); b := Sub.o;
c := fb.M(); d := fb.M();
END_PROGRAM
`;

describe.skipIf(!hasGpp)("VAR_TEMP and VAR_INST at run time — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-pouvars-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const [label, options] of [
    ["no dialect", {}],
    ["iec-3", { dialect: "iec-3" }],
    ["strict", { strict: true }],
  ] as const) {
    it(`resets VAR_TEMP per call and initialises VAR_INST once (${label})`, () => {
      const result = compile(SOURCE, {
        ...options,
        headerFileName: "generated.hpp",
        features: ["+program_methods"],
      });
      expect(result.errors).toEqual([]);
      const stdout = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: `pouvars_${label.replace(/\W/g, "_")}`,
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.A.get() << " " << p.B.get() << " " << p.C.get() << " " << p.D.get() << " "
              << p.S.get().c_str() << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe("61 1 4108 4208 xy");
    });

    it(`starts FB instances and inherited VAR_TEMP afresh; calls a VAR_INST instance (${label})`, () => {
      const result = compile(SOURCE2, {
        ...options,
        headerFileName: "generated.hpp",
      });
      expect(result.errors).toEqual([]);
      const stdout = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: `pouvars2_${label.replace(/\W/g, "_")}`,
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.A.get() << " " << p.A1.get() << " " << p.A2.get() << " " << p.M.get() << " "
              << p.K.get() << " " << p.E.get() << " " << p.F.get() << " " << p.G.get() << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe("6 1 1 1 2 11 12 2");
    });
  }
});
