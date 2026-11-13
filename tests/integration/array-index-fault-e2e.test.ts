// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: an array index out of bounds is a run-time fault naming the index, the
 * POU, the line and the running task; an unbound REFERENCE TO names the task.
 * STRUCPP_NO_BOUNDS_CHECK builds without the checks.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const ARRAY_SOURCE = `PROGRAM Main
VAR arr : ARRAY[0..2] OF INT; m : ARRAY[0..1, 0..1] OF INT; i : INT := 5; v : INT; END_VAR
arr[1] := 4; v := arr[1];
m[1, 1] := 3;
arr[i] := 1;
END_PROGRAM
`;

const REF_SOURCE = `FUNCTION_BLOCK FB
VAR_INPUT r : REFERENCE TO INT; END_VAR
VAR_OUTPUT o : INT; END_VAR
o := r;
END_FUNCTION_BLOCK
PROGRAM Main
VAR f : FB; END_VAR
f();
END_PROGRAM
`;

const MAIN = `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    strucpp::strucpp_set_current_task("FAST");
    try { p.run(); } catch (const std::exception& e) { std::cout << e.what(); }
    std::cout << std::endl;
    return 0;
}
`;

describe.skipIf(!hasGpp)("array index and reference faults — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-index-fault-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const [label, options] of [
    ["no dialect", {}],
    ["iec-3", { dialect: "iec-3" }],
    ["strict", { strict: true }],
  ] as const) {
    it(`names the index, POU, line and task (${label})`, () => {
      const result = compile(ARRAY_SOURCE, {
        ...options,
        headerFileName: "generated.hpp",
      });
      expect(result.errors).toEqual([]);
      const stdout = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: `index_fault_${label.replace(/\W/g, "_")}`,
        mainCode: MAIN,
      });
      expect(stdout).toBe(
        "Array index out of bounds: 5 in MAIN, line 5, task FAST",
      );
    });
  }

  it("names the task for an unbound REFERENCE TO", () => {
    const result = compile(REF_SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "ref_fault",
      mainCode: MAIN,
    });
    expect(stdout).toBe(
      "Null reference dereference in REFERENCE TO, task FAST",
    );
  });

  it("builds without the checks under STRUCPP_NO_BOUNDS_CHECK", () => {
    const result = compile(ARRAY_SOURCE.replace("arr[i] := 1;\n", ""), {
      headerFileName: "generated.hpp",
    });
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "no_bounds_check",
      extraFlags: ["-DSTRUCPP_NO_BOUNDS_CHECK"],
      mainCode: MAIN,
    });
    expect(stdout).toBe("");
  });
});
