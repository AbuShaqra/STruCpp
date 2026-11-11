// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * E2E: the member accesses and array assignments the unknown-member and
 * array/single-value checks accept build and run: members through EXTENDS and
 * an alias, a property, bits, same-shape arrays and a POINTER TO ARRAY (built, not read).
 * Built with g++ and run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

describe.skipIf(!hasGpp)("member access and array assignment — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-member-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("builds and runs", () => {
    const result = compile(
      `
      TYPE ST_I : STRUCT a : INT; arr : ARRAY[0..2] OF INT; END_STRUCT END_TYPE
      TYPE ST_O : STRUCT mid : ST_I; END_STRUCT END_TYPE
      TYPE ST_D EXTENDS ST_I : STRUCT d : INT; END_STRUCT END_TYPE
      TYPE T_A : ARRAY[0..2] OF INT; END_TYPE
      TYPE T_S : ST_I; END_TYPE
      FUNCTION_BLOCK FB_A
      VAR PUBLIC o : INT; END_VAR
      PROPERTY P : INT
      GET
        P := o + 100;
      END_GET
      END_PROPERTY
      END_FUNCTION_BLOCK
      FUNCTION_BLOCK FB_B EXTENDS FB_A
      END_FUNCTION_BLOCK
      PROGRAM Main
      VAR o : ST_O; d : ST_D; ts : T_S; fb : FB_A; fbb : FB_B; arr2 : ARRAY[0..2] OF INT;
        ta : T_A; w : WORD := 8; p : POINTER TO ARRAY[0..3] OF BYTE;
        dw : DWORD := 16#0403; r1 : INT; r2 : INT; r3 : INT; r4 : INT;
        r5 : BOOL; r6 : BYTE; END_VAR
        o.mid.a := 3; o.mid.arr[1] := 4;
        d.a := 5; ts.a := 6;
        r1 := o.mid.a + o.mid.arr[1];
        r2 := d.a + ts.a;
        fbb.o := 1; r3 := fb.P + fbb.o;
        ta := o.mid.arr; arr2 := ta;
        r4 := arr2[1];
        r5 := w.3;
        p := ADR(dw); r6 := p^[0];
      END_PROGRAM
    `,
      { headerFileName: "generated.hpp", features: ["+struct_extends"] },
    );
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "unknown_member_access",
      mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN prog;
    prog.run();
    std::cout << prog.R1.get() << " " << prog.R2.get() << " " << prog.R3.get() << " "
              << prog.R4.get() << " " << prog.R5.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("7 11 101 4 1");
  });
});
