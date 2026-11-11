// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: the typed literals that stay accepted keep their values: a based
 * bit pattern on a signed type is that pattern (INT#16#FFFF is -1).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `PROGRAM Main
VAR a : INT; b : SINT; c : DINT; d : BYTE; e : SINT; f : USINT; END_VAR
a := INT#16#FFFF;
b := SINT#16#80;
c := DINT#16#FFFF_FFFF;
d := BYTE#16#FF;
e := SINT#-128;
f := USINT#255;
END_PROGRAM
`;

describe.skipIf(!hasGpp)("typed literal range — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-litrange-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("builds and runs", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "typed_literal_range",
      mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN p;
    p.run();
    std::cout << p.A.get() << " " << (int)p.B.get() << " " << p.C.get() << " "
              << (int)p.D.get() << " " << (int)p.E.get() << " " << (int)p.F.get()
              << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("-1 -128 -1 255 -128 255");
  });
});
