// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * E2E: REF / REF= of a STRUCT and a function block into REF_TO and REFERENCE
 * TO, member access through them, and REF / ADR of CONFIGURATION globals.
 * Built with g++ and run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

describe.skipIf(!hasGpp)("references to a STRUCT — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-refstruct-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("builds and runs", () => {
    const result = compile(
      `
      TYPE ST : STRUCT a : INT; b : INT; END_STRUCT END_TYPE
      FUNCTION_BLOCK FBM
      VAR_INPUT v : INT; END_VAR
      METHOD M : INT
        M := v * 3;
      END_METHOD
      END_FUNCTION_BLOCK
      PROGRAM Main
      VAR_EXTERNAL gi : INT; gs : ST; END_VAR
      VAR s : ST := (a := 1, b := 2); t : ST := (a := 30, b := 40);
        r : REF_TO ST; rf : REFERENCE TO ST; f : FBM; q : REF_TO FBM;
        rr : REFERENCE TO FBM; ri : REF_TO INT; pi : POINTER TO INT;
        ps : POINTER TO ST; rs : REF_TO ST;
        x : INT; y : INT; z : INT; m : INT; g : INT; h : INT; END_VAR
        r := REF(s);
        r^.a := 10;
        x := r^.b;
        rf REF= s;
        rf.b := 20;
        y := rf.a + rf.b;
        r REF= t;
        z := r^.a;
        q := REF(f);
        q^.v := 3;
        rr REF= f;
        m := rr.M() + rr.v;
        ri := REF(gi);
        pi := ADR(gi);
        ri^ := ri^ + pi^;
        ps := ADR(gs);
        rs REF= gs;
        rs^.a := 7;
        g := ps^.a + gi;
        h := s.a + s.b;
      END_PROGRAM
      CONFIGURATION C
        VAR_GLOBAL gi : INT := 5; gs : ST; END_VAR
        RESOURCE R ON PLC
          TASK T(INTERVAL := T#100ms, PRIORITY := 1);
          PROGRAM Inst WITH T : Main;
        END_RESOURCE
      END_CONFIGURATION
    `,
      { headerFileName: "generated.hpp" },
    );
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "reference_to_struct",
      mainCode: `
#include <iostream>
int main() {
    using namespace strucpp;
    Configuration_C c;
    c.INST.run();
    std::cout << c.INST.X.get() << " " << c.INST.Y.get() << " " << c.INST.Z.get() << " "
              << c.INST.M.get() << " " << c.INST.G.get() << " " << c.INST.H.get() << " "
              << GI.value.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("2 30 30 12 17 30 10");
  });
});
