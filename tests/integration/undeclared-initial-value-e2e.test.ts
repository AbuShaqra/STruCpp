// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * E2E: the initial values the undeclared-name check accepts build and run:
 * constants, another variable, an enum value, a sibling STRUCT field and a
 * standard function. Built with g++ and run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

describe.skipIf(!hasGpp)("names in initial values — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-initname-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("builds and runs", () => {
    const result = compile(
      `
      TYPE ST_S : STRUCT a : INT := 3; b : INT := a; END_STRUCT END_TYPE
      TYPE E1 : (ALPHA, BETA); END_TYPE
      VAR_GLOBAL CONSTANT GC : INT := 4; END_VAR
      FUNCTION_BLOCK FB
      VAR_INPUT i : INT := GC; END_VAR
      VAR CONSTANT K : INT := 2; END_VAR
      VAR_OUTPUT j : INT := K + GC; END_VAR
      METHOD GetI : INT
        GetI := i;
      END_METHOD
      END_FUNCTION_BLOCK
      PROGRAM Main
      VAR CONSTANT C : INT := 3; END_VAR
      VAR x : INT := C * GC; y : INT := x; e : E1 := BETA; s : ST_S;
        f : FB; arr : ARRAY[0..1] OF INT := [C, GC]; r : INT := ABS(-5);
        r1 : INT; r2 : INT; r3 : INT; r4 : INT; END_VAR
        r1 := x * 100 + y;
        IF e = BETA THEN r2 := s.b; END_IF;
        r3 := f.GetI() * 10 + f.j;
        r4 := arr[0] * 100 + arr[1] * 10 + r;
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
      testName: "undeclared_initial_value",
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
    expect(stdout).toBe("1212 3 46 345");
  });

  it("settles a member of several enumerations by its target", () => {
    const result = compile(
      `
      TYPE MODE1 : (A, B); END_TYPE
      TYPE MODE2 : (B, C); END_TYPE
      TYPE T1 : MODE1; END_TYPE
      TYPE ST : STRUCT f : MODE2 := B; END_STRUCT END_TYPE
      PROGRAM Main
      VAR e : MODE1 := B; t : T1 := B; s : ST; s2 : ST := (f := B);
        arr : ARRAY[0..1] OF MODE2 := [C, B]; e3 : MODE2; n : INT; END_VAR
        e3 := B;
        IF e = MODE1#B THEN n := n + 1; END_IF;
        IF t = MODE1#B THEN n := n + 10; END_IF;
        IF s.f = MODE2#B AND s2.f = MODE2#B THEN n := n + 100; END_IF;
        IF arr[1] = MODE2#B AND arr[0] = MODE2#C THEN n := n + 1000; END_IF;
        IF e3 = MODE2#B THEN n := n + 10000; END_IF;
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
      testName: "settled_enum_member",
      mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN prog;
    prog.run();
    std::cout << prog.N.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("11111");
  });
});
