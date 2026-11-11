// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: a file define selects a branch in its own file and not in another;
 * a pragma-only define with an integer value works with hasvalue() and
 * creates no global constant, so a VAR_GLOBAL CONSTANT of the same name
 * still compiles and keeps its value.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const MAIN = `VAR_GLOBAL CONSTANT LEVEL : INT := 7; END_VAR
PROGRAM Main
VAR a : INT; b : INT; c : INT; d : INT; k : INT; END_VAR
{IF defined(FEAT)} a := 1; {ELSE} a := 2; {END_IF}
{IF hasvalue(LEVEL, '3')} c := 30; {ELSE} c := 40; {END_IF}
{IF project_defined(FEAT)} d := 5; {ELSE} d := 6; {END_IF}
b := Other();
k := LEVEL;
END_PROGRAM
`;
const OTHER = `FUNCTION Other : INT
{IF defined(FEAT)} Other := 10; {ELSE} Other := 20; {END_IF}
END_FUNCTION
`;

describe.skipIf(!hasGpp)("file and pragma-only defines — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-filedef-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("builds and runs", () => {
    const result = compile(MAIN, {
      headerFileName: "generated.hpp",
      features: ["+conditional_pragmas"],
      pragmaDefines: { LEVEL: "3" },
      filePragmaDefines: { FEAT: "" },
      additionalSources: [{ source: OTHER, fileName: "other.st" }],
    });
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "pragma_file_defines",
      mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN p;
    p.run();
    std::cout << p.A.get() << " " << p.B.get() << " " << p.C.get() << " "
              << p.D.get() << " " << p.K.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("1 20 30 6 7");
  });
});
