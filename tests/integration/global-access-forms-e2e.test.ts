// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: access to globals that passed the check and then failed g++:
 * - a STRING(10) or WSTRING(10) written to a CONFIGURATION STRING / WSTRING
 *   through VAR_EXTERNAL, and a STRING(5) external keeping its length;
 * - a FUNCTION reading and writing a CONFIGURATION global through VAR_EXTERNAL;
 * - a user FUNCTION called in a GVL, STRUCT-field or CONFIGURATION global's
 *   initial value (its prototype now precedes the globals).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `
FUNCTION Fx : INT
VAR_INPUT a : INT := 1; END_VAR
Fx := 40 + a;
END_FUNCTION
TYPE S : STRUCT f : INT; END_STRUCT END_TYPE
VAR_GLOBAL y : INT := Fx(); z : S := (f := Fx(a := 3)); END_VAR
CONFIGURATION C
VAR_GLOBAL
  g : STRING := 'xy'; g5 : STRING(5); gw : WSTRING; cg : INT := Fx(5); cb : BOOL;
END_VAR
RESOURCE R ON PLC
TASK t(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM p WITH t : Main;
END_RESOURCE
END_CONFIGURATION
FUNCTION FSet : INT
VAR_INPUT v : INT; END_VAR
VAR_EXTERNAL cg : INT; cb : BOOL; END_VAR
VAR loc : INT := 2; END_VAR
cg := v + loc;
cg := cg * 2;
cb := cg > 3;
FSet := cg;
END_FUNCTION
PROGRAM Main
VAR_EXTERNAL g : STRING; g5 : STRING(5); gw : WSTRING; cg : INT; y : INT; z : S; END_VAR
VAR
  s : STRING(10) := 'hello'; s2 : STRING(20) := 'abcdefghij'; w : WSTRING(10) := "wide";
  r : STRING; init : INT; n : INT;
END_VAR
init := y + z.f + cg;
g := s;
g5 := s2;
gw := w;
r := CONCAT(g, g5);
n := FSet(1) + cg;
END_PROGRAM
`;

const MAIN = `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p(&strucpp::G, &strucpp::G5, &strucpp::GW, &strucpp::CG);
    p.run();
    std::cout << p.INIT.get() << "|" << p.R.c_str() << "|" << strucpp::GW.read().length()
              << "|" << p.N.get() << " " << strucpp::CG.read().get() << " " << strucpp::CB.read().get();
    std::cout << std::endl;
    return 0;
}
`;

describe.skipIf(!hasGpp)("global access forms — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-globals-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("builds and reaches each global", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "global_access_forms",
      mainCode: MAIN,
    });
    // init: 41 + 43 + 45; FSet(1) = (1 + 2) * 2 = 6, n = 6 + 6
    expect(out.split("|").map((p) => p.trim())).toEqual([
      "129",
      "helloabcde",
      "4",
      "12 6 1",
    ]);
  });
});
