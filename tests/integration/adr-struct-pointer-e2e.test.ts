// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * E2E: ADR of a STRUCT, UNION, ARRAY element and FB instance into a POINTER TO
 * that type, read and written through `p^.field`, a pointer held in a STRUCT
 * field and passed to a function. Built with g++ and run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

describe.skipIf(!hasGpp)("ADR into POINTER TO a structured type — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-adrptr-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("writes and reads through the pointers", () => {
    const result = compile(
      `
      TYPE ST_A : STRUCT x : INT; y : REAL; END_STRUCT END_TYPE
      TYPE U_A : UNION i : DINT; f : REAL; END_UNION END_TYPE
      TYPE ST_H : STRUCT p : POINTER TO ST_A; END_STRUCT END_TYPE

      FUNCTION F_Get : INT
      VAR_INPUT p : POINTER TO ST_A; END_VAR
        F_Get := p^.x;
      END_FUNCTION

      FUNCTION_BLOCK FB_A
      VAR_INPUT v : INT; END_VAR
      VAR_OUTPUT o : INT; END_VAR
        o := v * 2;
      END_FUNCTION_BLOCK

      PROGRAM Main
      VAR
        s : ST_A; u : U_A; arr : ARRAY[0..1] OF ST_A; h : ST_H; fb : FB_A;
        p : POINTER TO ST_A; pu : POINTER TO U_A; pf : POINTER TO FB_A;
        r1 : INT; r2 : INT; q : INT;
      END_VAR
        p := ADR(s);
        p^.x := 5;
        p^.y := 1.5;
        h.p := ADR(s);
        r1 := F_Get(h.p);
        p := ADR(arr[1]);
        p^.x := 9;
        r2 := arr[1].x;
        pu := ADR(u);
        pu^.i := 77;
        pf := ADR(fb);
        pf^.v := 4;
        fb();
        q := pf^.o;
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
      testName: "adr_struct_pointer",
      mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN prog;
    prog.run();
    std::cout << prog.S.X.get() << " " << prog.S.Y.get() << " " << prog.R1.get() << " "
              << prog.R2.get() << " " << prog.U.I.get() << " " << prog.Q.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("5 1.5 5 9 77 8");
  });
});
