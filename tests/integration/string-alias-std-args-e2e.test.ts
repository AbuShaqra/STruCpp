// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: LEN, CONCAT and FIND on STRING aliases, compiled without libraries,
 * build and run.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `TYPE TS : STRING(20); END_TYPE
TYPE TS2 : TS; END_TYPE
PROGRAM Main
VAR t : TS := 'hello'; t2 : TS2 := 'ab'; n : INT; m : INT; k : INT; s : STRING; p : INT; END_VAR
n := LEN(t);
s := CONCAT(t, '!');
m := LEN(s);
k := LEN(t2);
p := FIND(t, 'll');
END_PROGRAM
`;

describe.skipIf(!hasGpp)("STRING alias arguments — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-stralias-"));
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
      testName: "string_alias_std_args",
      mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN p;
    p.run();
    std::cout << p.N.get() << " " << p.M.get() << " " << p.K.get() << " " << p.P.get()
              << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("5 6 2 3");
  });
});
