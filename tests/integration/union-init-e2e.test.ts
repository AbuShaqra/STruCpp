// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E for UNION initial values (feature union): a structure initializer naming
 * one member writes that member's bytes into the zero-initialised storage. As a
 * variable's initial value, a TYPE default (on the UNION and on an alias), a
 * STRUCT field default, inside a STRUCT initializer and an array literal, with a
 * STRUCT, array or UNION member. Built with g++ and run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

describe.skipIf(!hasGpp)("UNION initial values — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-unioninit-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("writes the named member into zeroed storage", () => {
    const result = compile(
      `
      TYPE U_A : UNION i : DINT; f : REAL; b : ARRAY[0..3] OF BYTE; END_UNION END_TYPE
      TYPE U_D : UNION i : DINT; f : REAL; END_UNION := (i := 21); END_TYPE
      TYPE T_U : U_A := (i := 7); END_TYPE
      TYPE ST_P : STRUCT x : INT; y : INT; END_STRUCT END_TYPE
      TYPE U_S : UNION st : ST_P; w : LWORD; END_UNION END_TYPE
      TYPE U_N : UNION inner : U_A; l : LWORD; END_UNION END_TYPE
      TYPE ST_O : STRUCT a : INT; u : U_A := (i := 15); END_STRUCT END_TYPE

      FUNCTION_BLOCK FB_H
      VAR m : U_A := (i := 33); END_VAR
      END_FUNCTION_BLOCK

      PROGRAM Main
      VAR
        u : U_A := (f := 1.0);
        ub : U_A := (b := [16#11, 16#22]);
        arr : ARRAY[0..2] OF U_A := [(i := 3), 2((f := 2.0))];
        o : ST_O := (a := 1, u := (i := 9));
        od : ST_O;
        ws : ARRAY[0..1] OF ST_O := [(a := 2), (u := (f := 1.0))];
        us : U_S := (st := (x := 1, y := 2));
        un : U_N := (inner := (i := 5));
        td : T_U;
        ud : U_D;
        fb : FB_H;
      END_VAR
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
      testName: "union_init",
      mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN prog;
    std::cout << std::hex << prog.U.I.get() << std::dec << " "
              << prog.UB.I.get() << " "
              << prog.ARR[0].I.get() << " " << prog.ARR[1].F.get() << " " << prog.ARR[2].F.get() << " "
              << prog.O.A.get() << " " << prog.O.U.I.get() << " " << prog.OD.U.I.get() << " "
              << prog.US.ST.X.get() << " " << prog.US.ST.Y.get() << " " << (prog.US.W.get() >> 32) << " "
              << prog.UN.INNER.I.get() << " " << (prog.UN.L.get() >> 32) << " "
              << prog.TD.I.get() << " " << prog.UD.I.get() << " " << prog.FB.M.I.get() << " "
              << prog.WS[0].A.get() << " " << prog.WS[0].U.I.get() << " " << std::hex << prog.WS[1].U.I.get() << std::endl;
    return 0;
}
`,
    });
    // 1.0f is 0x3f800000; b := [16#11, 16#22] leaves the upper bytes zero.
    expect(stdout).toBe("3f800000 8721 3 2 2 1 9 15 1 2 0 5 0 7 21 33 2 15 3f800000");
  });

  it("initialises a global, a function local and an FB instance input", () => {
    const result = compile(
      `
      TYPE U_A : UNION i : DINT; f : REAL; END_UNION END_TYPE
      VAR_GLOBAL g : U_A := (i := 4); END_VAR
      FUNCTION F : DINT
      VAR_INPUT p : U_A; END_VAR
      VAR t : U_A := (i := 8); END_VAR
        F := p.i + t.i;
      END_FUNCTION
      FUNCTION_BLOCK FB_I
      VAR_INPUT q : U_A; END_VAR
      END_FUNCTION_BLOCK
      PROGRAM Main
      VAR e : DINT; gi : DINT; fbi : FB_I := (q := (i := 12)); END_VAR
        e := F(p := g);
        gi := g.i;
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
      testName: "union_init_scopes",
      mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN prog;
    prog.run();
    std::cout << prog.E.get() << " " << prog.GI.get() << " " << prog.FBI.Q.I.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("12 4 12");
  });
});
