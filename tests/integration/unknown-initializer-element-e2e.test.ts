// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * E2E: the structure initializers the unknown-element check accepts build and
 * run: nested, inside an array, an inherited element, through an alias and a
 * function block input. Built with g++ and run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

describe.skipIf(!hasGpp)("structure initializer elements — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-sinit-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("builds and runs", () => {
    const result = compile(
      `
      TYPE ST_P : STRUCT a : INT; b : INT; END_STRUCT END_TYPE
      TYPE ST_Q : STRUCT p : ST_P; arr : ARRAY[0..1] OF ST_P; END_STRUCT END_TYPE
      TYPE ST_D EXTENDS ST_P : STRUCT d : INT; END_STRUCT END_TYPE
      TYPE T_P : ST_P; END_TYPE
      FUNCTION_BLOCK FB_A
      VAR_INPUT i : INT; END_VAR
      END_FUNCTION_BLOCK
      FUNCTION_BLOCK FB_B EXTENDS FB_A
      END_FUNCTION_BLOCK
      PROGRAM Main
      VAR q : ST_Q := (p := (a := 1), arr := [(b := 2), (a := 3)]);
        d : ST_D := (a := 4, d := 5); t : T_P := (b := 6); f : FB_B := (i := 7);
        r1 : INT; r2 : INT; r3 : INT; r4 : INT; END_VAR
        r1 := q.p.a * 100 + q.arr[0].b * 10 + q.arr[1].a;
        r2 := d.a * 10 + d.d;
        r3 := t.b;
        r4 := f.i;
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
      testName: "unknown_initializer_element",
      mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN prog;
    prog.run();
    std::cout << prog.R1.get() << " " << prog.R2.get() << " " << prog.R3.get() << " "
              << prog.R4.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("123 45 6 7");
  });
});
