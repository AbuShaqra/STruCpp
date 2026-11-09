// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * E2E: an alias of a STRUCT or UNION names the same type. Whole-value copies
 * both ways, through an alias chain, VAR_INPUT / VAR_IN_OUT arguments (a
 * VAR_IN_OUT of one alias bound by reference to a variable of another) and an
 * initialiser build with g++ and run with the expected values.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

describe.skipIf(!hasGpp)("STRUCT / UNION alias assignment — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-alias-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("copies values between a STRUCT / UNION and its aliases", () => {
    const result = compile(
      `
      TYPE ST_A : STRUCT x : INT; y : REAL; END_STRUCT END_TYPE
      TYPE T_A : ST_A; END_TYPE
      TYPE T_AA : T_A; END_TYPE
      TYPE U_A : UNION i : DINT; f : REAL; END_UNION END_TYPE
      TYPE T_U : U_A; END_TYPE

      FUNCTION F_In : INT
      VAR_INPUT p : ST_A; END_VAR
        F_In := p.x;
      END_FUNCTION

      FUNCTION F_Bump : INT
      VAR_IN_OUT p : T_A; END_VAR
        p.x := p.x + 100;
        F_Bump := p.x;
      END_FUNCTION

      FUNCTION F_U : DINT
      VAR_IN_OUT p : U_A; END_VAR
        p.i := p.i + 1;
        F_U := p.i;
      END_FUNCTION

      PROGRAM Main
      VAR
        s : ST_A; t : T_A; tt : T_AA; init : T_A := s; s2 : ST_A;
        u : U_A; tu : T_U;
        r1 : INT; r2 : INT; r3 : INT; d : DINT;
      END_VAR
        t.x := 7; t.y := 1.5;
        s := t;
        tt := s;
        tt.x := tt.x + 1;
        s2 := tt;
        r1 := F_In(tt);
        r2 := F_Bump(s);
        r3 := F_Bump(tt);
        tu.i := 41;
        u := tu;
        d := F_U(tu);
        tu := u;
      END_PROGRAM
    `,
      { headerFileName: "generated.hpp", features: ["union"] },
    );
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "struct_alias_assign",
      mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN prog;
    prog.run();
    std::cout << prog.S.X.get() << " " << prog.S.Y.get() << " " << prog.S2.X.get() << " "
              << prog.R1.get() << " " << prog.R2.get() << " " << prog.INIT.X.get() << " "
              << prog.D.get() << " " << prog.TU.I.get() << " " << prog.R3.get() << " "
              << prog.TT.X.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("107 1.5 8 8 107 0 42 41 108 108");
  });
});
