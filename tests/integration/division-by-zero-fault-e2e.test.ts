// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: integer division by zero is a run-time fault naming the POU, the line
 * and the running task; the minimum value / -1 wraps; REAL division is plain.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `FUNCTION_BLOCK FB
VAR_INPUT z : INT; END_VAR
VAR_OUTPUT o : INT; END_VAR
o := 7 / z;
END_FUNCTION_BLOCK
PROGRAM Main
VAR a : INT := 7; q : INT; mn : DINT := DINT#-2147483648; m1 : DINT := -1; dq : DINT; f : FB; END_VAR
q := a / 2;
dq := mn / m1;
f(z := 0);
END_PROGRAM
`;

describe.skipIf(!hasGpp)("integer division by zero — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-divzero-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const [label, options] of [
    ["no dialect", {}],
    ["iec-3", { dialect: "iec-3" }],
    ["strict", { strict: true }],
  ] as const) {
    it(`raises a fault naming the POU, line and task (${label})`, () => {
      const result = compile(SOURCE, {
        ...options,
        headerFileName: "generated.hpp",
      });
      expect(result.errors).toEqual([]);
      expect(result.cppCode).toContain(
        'iec_div(7, Z, strucpp::iec_site{"FB", 4})',
      );
      const stdout = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: `divzero_${label.replace(/\W/g, "_")}`,
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    strucpp::strucpp_set_current_task("FAST");
    try { p.run(); } catch (const std::exception& e) { std::cout << e.what() << "|"; }
    std::cout << p.Q.get() << " " << p.DQ.get() << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe(
        "Division by zero in FB, line 4, task FAST|3 -2147483648",
      );
    });
  }
});
