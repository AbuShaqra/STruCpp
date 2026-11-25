// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: a `VAR_IN_OUT r : REFERENCE TO T` given a variable of type T refers to
 * that variable (no copy, no warning) in a FUNCTION, METHOD and function block
 * call, a STRUCT included; given another type it is passed by copy-in /
 * copy-out through a T, as the warning says. Neither aborts on an unbound
 * reference.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `
TYPE T : STRUCT a : INT; END_STRUCT END_TYPE
FUNCTION F : INT
VAR_IN_OUT r : REFERENCE TO INT; END_VAR
r := r + 10;
F := r;
END_FUNCTION
FUNCTION_BLOCK FB
VAR_IN_OUT r : REFERENCE TO INT; s : REFERENCE TO T; END_VAR
r := r + 1;
s.a := s.a + 2;
END_FUNCTION_BLOCK
FUNCTION_BLOCK FM
METHOD M : INT
VAR_IN_OUT r : REFERENCE TO INT; END_VAR
r := r * 3;
M := r;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main
VAR
  i : INT := 1; x : INT; j : INT := 1; t : T; fb : FB; fm : FM; k : INT := 2;
  y : INT; d : DINT := 4; z : INT;
END_VAR
x := F(i);
fb(r := j, s := t);
y := fm.M(k);
z := F(d);
END_PROGRAM
`;

const MAIN = `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.I.get() << " " << p.X.get() << " " << p.J.get() << " "
              << p.T_.A.get() << " " << p.K.get() << " " << p.Y.get() << " "
              << p.D.get() << " " << p.Z.get() << std::endl;
    return 0;
}
`;

describe("VAR_IN_OUT REFERENCE TO T — check and codegen", () => {
  it("binds a T without a warning and copies another type with one", () => {
    const result = compile(SOURCE);
    expect(result.errors).toEqual([]);
    expect(
      result.warnings
        .map((w) => `${w.line}: ${w.message}`)
        .filter((m) => m.includes("copy-in")),
    ).toEqual([
      "28: VAR_IN_OUT 'r' of type REFERENCE TO INT is bound to a variable of type DINT; it is passed by copy-in / copy-out, not by reference",
    ]);
    expect(result.cppCode).toMatch(/IEC_REFERENCE_TO<INT_t> __gio_\d+\(I\);/);
    expect(result.cppCode).toMatch(
      /decltype\(FB_\.S\)::value_type __io_\d+\(T_\);/,
    );
  });
});

describe.skipIf(!hasGpp)("VAR_IN_OUT REFERENCE TO T — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-inoutref-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("writes through to the caller's variable", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "inout_reference_to",
      mainCode: MAIN,
    });
    expect(out).toBe("11 11 2 2 6 6 14 14");
  });
});
