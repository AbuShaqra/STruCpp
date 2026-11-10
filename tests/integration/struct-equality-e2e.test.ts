// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * E2E: STRUCT `=` / `<>` with nested STRUCT, STRING, enum and ARRAY members,
 * through an alias and on function results. Built with g++ and run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

describe.skipIf(!hasGpp)("STRUCT equality — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-structeq-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("builds and runs", () => {
    const result = compile(
      `
      TYPE E : (Red, Green); END_TYPE
      TYPE IN1 : STRUCT k : INT; c : E; END_STRUCT END_TYPE
      TYPE AR : ARRAY[0..1] OF IN1; END_TYPE
      TYPE ST : STRUCT a : INT; b : REAL; s : STRING; i : IN1;
        arr : ARRAY[1..3] OF INT; ar2 : AR; m : ARRAY[0..1, 0..1] OF BOOL;
      END_STRUCT END_TYPE
      TYPE T_ST : ST; END_TYPE
      FUNCTION Mk : ST
      VAR_INPUT a : INT; END_VAR
        Mk.a := a;
      END_FUNCTION
      PROGRAM Main
      VAR x : ST := (a := 1, s := 'q'); y : T_ST := (a := 1, s := 'q');
        e1 : BOOL; e2 : BOOL; n1 : BOOL; e3 : BOOL; e4 : BOOL; e5 : BOOL;
        e6 : BOOL; e7 : BOOL; END_VAR
        e1 := x = y;
        y.arr[2] := 5;
        e2 := x = y;
        n1 := x <> y;
        x.arr[2] := 5;
        y.ar2[1].c := Green;
        e3 := x = y;
        x.ar2[1].c := Green;
        y.m[1, 0] := TRUE;
        e4 := x = y;
        x.m[1, 0] := TRUE;
        e5 := x = y AND NOT (x <> y);
        e6 := Mk(1) = Mk(1);
        e7 := Mk(1) <> Mk(2);
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
      testName: "struct_equality",
      mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN p;
    p.run();
    std::cout << p.E1.get() << p.E2.get() << p.N1.get() << p.E3.get() << p.E4.get()
              << p.E5.get() << p.E6.get() << p.E7.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("10100111");
  });
});
