// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * E2E: names spelled Get / Set (a METHOD, FUNCTION, FUNCTION_BLOCK, variable,
 * ACTION, enumeration member, STRUCT field) next to a PROPERTY with GET and
 * SET accessors build with g++ and run with the expected values.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

describe.skipIf(!hasGpp)("GET / SET as identifiers — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-getset-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("runs methods, a function, an FB, an action and fields named Get / Set", () => {
    const result = compile(`
      TYPE ST_A : STRUCT Get : INT; Set : BOOL; END_STRUCT END_TYPE

      FUNCTION Get : INT
      VAR_INPUT x : INT; END_VAR
        Get := x * 10;
      END_FUNCTION

      FUNCTION_BLOCK Set
      VAR_INPUT x : INT; END_VAR
      VAR_OUTPUT y : INT; END_VAR
        y := x + 1;
      END_FUNCTION_BLOCK

      FUNCTION_BLOCK FB_A
      VAR v : INT; END_VAR
      METHOD Get : INT
        Get := v;
      END_METHOD
      METHOD Set
      VAR_INPUT x : INT; END_VAR
        v := x;
      END_METHOD
      METHOD Bump
        THIS.Set(THIS.Get() + 1);
      END_METHOD
      PROPERTY Value : INT
        GET Value := v; END_GET
        SET v := Value; END_SET
      END_PROPERTY
      END_FUNCTION_BLOCK

      PROGRAM Main
      VAR
        f : FB_A;
        s : Set;
        st : ST_A;
        r1 : INT; r2 : INT; r3 : INT; r4 : INT; act : INT;
      END_VAR
        f.Set(41);
        f.Bump();
        r1 := f.Get();
        f.Value := 7;
        r2 := f.Value;
        r3 := Get(4);
        s(x := 9);
        r4 := s.y;
        st.Get := 3;
        st.Set := r3 = 40;
        Tick();
      ACTION Tick:
        act := act + 5;
      END_ACTION
      END_PROGRAM
    `, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "get_set_identifiers",
      mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN prog;
    prog.run();
    std::cout << prog.R1.get() << " " << prog.R2.get() << " " << prog.R3.get() << " "
              << prog.R4.get() << " " << prog.ST.GET.get() << " " << prog.ST.SET.get() << " "
              << prog.ACT.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("42 7 40 10 3 1 5");
  });

  it("runs enumeration members named Get / Set", () => {
    // Kept apart from a POU named Get: an enum member that shares a function's
    // name hijacks its return assignment in C++ for any name (separate defect).
    const result = compile(`
      TYPE E_Mode : (Idle, Get, Set); END_TYPE
      PROGRAM Main
      VAR m : E_Mode := E_Mode#Set; n : E_Mode; r : INT; END_VAR
        n := Get;
        IF m = E_Mode#Set AND n = E_Mode#Get THEN r := 1; END_IF;
      END_PROGRAM
    `, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "get_set_enum",
      mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN prog;
    prog.run();
    std::cout << prog.R.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("1");
  });
});
