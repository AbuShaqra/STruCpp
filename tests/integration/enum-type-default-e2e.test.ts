// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * E2E: an enumeration type whose default is type-qualified
 * (`TYPE E2 : (A, B, C) := E2#B; END_TYPE`) gives that value to every
 * variable and STRUCT field of the type declared without one. Built with g++
 * and run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

describe.skipIf(!hasGpp)("type-qualified enumeration default — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-enumdef-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("builds and runs", () => {
    const result = compile(
      `
      TYPE E2 : (A, B, C) := E2#B; END_TYPE
      TYPE E4 : INT (X := 10, Y := 20) := E4#Y; END_TYPE
      TYPE ST : STRUCT f : E2; END_STRUCT END_TYPE
      PROGRAM Main
      VAR e : E2; g : E4; s : ST; isB : BOOL; fieldB : BOOL; isY : BOOL; n : INT; END_VAR
        isB := e = E2#B;
        fieldB := s.f = E2#B;
        isY := g = E4#Y;
        n := TO_INT(g);
      END_PROGRAM
      `,
      { headerFileName: "generated.hpp" },
    );
    expect(result.errors.map((e) => `${e.line}: ${e.message}`)).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "enum_type_default",
      mainCode: `#include <iostream>
int main() {
  using namespace strucpp;
  Program_MAIN p;
  p.run();
  std::cout << p.ISB.get() << " " << p.FIELDB.get() << " " << p.ISY.get()
            << " " << p.N.get() << std::endl;
  return 0;
}
`,
    });
    expect(out).toBe("1 1 1 20");
  });
});
