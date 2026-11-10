// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * E2E: a variable of PROGRAM type, its program never reached by name, is
 * called with and without inputs. Built with g++ and run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

describe.skipIf(!hasGpp)("PROGRAM-typed variable call — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-progvar-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("builds and runs", () => {
    const result = compile(
      `
      PROGRAM PCount
      VAR_INPUT step : INT := 1; END_VAR
      VAR n : INT; END_VAR
        n := n + step;
      END_PROGRAM
      PROGRAM Main
      VAR p : PCount; q : PCount; r : INT; s : INT; END_VAR
        p();
        p(step := 5);
        p(2);
        q();
        r := p.n;
        s := q.n;
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
      testName: "program_variable_call",
      mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN prog;
    prog.run();
    std::cout << prog.R.get() << " " << prog.S.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("8 1");
  });
});
