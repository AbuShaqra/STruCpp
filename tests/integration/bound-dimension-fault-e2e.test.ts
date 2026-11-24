// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: LOWER_BOUND / UPPER_BOUND answer the dimension DIM names, and a DIM
 * outside 1..rank at run time is a fault naming the call, the dimension, the
 * rank, the POU, the line and the task: fixed and ARRAY[*] arrays, 1-D and
 * 2-D. STRUCPP_NO_BOUNDS_CHECK builds without the check.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `FUNCTION Up1 : DINT
VAR_IN_OUT v : ARRAY[*] OF INT; END_VAR
VAR_INPUT d : INT; END_VAR
Up1 := UPPER_BOUND(v, d);
END_FUNCTION
FUNCTION Lo2 : DINT
VAR_IN_OUT v : ARRAY[*, *] OF INT; END_VAR
VAR_INPUT d : INT; END_VAR
Lo2 := LOWER_BOUND(v, d);
END_FUNCTION
PROGRAM Main
VAR
  a1 : ARRAY[1..3] OF INT;
  m : ARRAY[1..2, 5..9] OF INT;
  m3 : ARRAY[0..1, 2..3, 7..8] OF INT;
  d : INT := 1;
  k : INT;
  r : ARRAY[0..5] OF DINT;
END_VAR
r[0] := UPPER_BOUND(a1, d);
r[1] := UPPER_BOUND(m, d + 1);
r[2] := LOWER_BOUND(m3, d + 2);
r[3] := Up1(a1, 1);
r[4] := Lo2(m, 2);
CASE k OF
1: r[5] := UPPER_BOUND(a1, d + 1);
2: r[5] := LOWER_BOUND(m, d + 2);
3: r[5] := Up1(a1, 2);
4: r[5] := Lo2(m, 0);
5: r[5] := UPPER_BOUND(m3, d + 3);
6: r[5] := UPPER_BOUND(m, d - 1);
END_CASE;
END_PROGRAM
`;

const MAIN = `
#include <iostream>
int main() {
    strucpp::strucpp_set_current_task("FAST");
    for (int k = 0; k <= 6; k++) {
        strucpp::Program_MAIN p;
        p.K = k;
        try {
            p.run();
            std::cout << p.R[0] << " " << p.R[1] << " " << p.R[2] << " "
                      << p.R[3] << " " << p.R[4] << " " << p.R[5];
        } catch (const std::exception& e) {
            std::cout << e.what();
        }
        std::cout << "|";
    }
    std::cout << std::endl;
    return 0;
}
`;

describe.skipIf(!hasGpp)("LOWER_BOUND / UPPER_BOUND DIM — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-bound-dim-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const [label, options] of [
    ["no dialect", {}],
    ["iec-3", { dialect: "iec-3" }],
    ["strict", { strict: true }],
  ] as const) {
    it(`answers DIM and faults outside 1..rank (${label})`, () => {
      const result = compile(SOURCE, {
        ...options,
        headerFileName: "generated.hpp",
      });
      expect(result.errors).toEqual([]);
      const stdout = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: `bound_dim_${label.replace(/\W/g, "_")}`,
        mainCode: MAIN,
      });
      expect(stdout.split("|")).toEqual([
        "3 9 7 3 5 0",
        "UPPER_BOUND has no dimension 2: the array has 1 in MAIN, line 26, task FAST",
        "LOWER_BOUND has no dimension 3: the array has 2 in MAIN, line 27, task FAST",
        "UPPER_BOUND has no dimension 2: the array has 1 in UP1, line 4, task FAST",
        "LOWER_BOUND has no dimension 0: the array has 2 in LO2, line 9, task FAST",
        "UPPER_BOUND has no dimension 4: the array has 3 in MAIN, line 30, task FAST",
        "UPPER_BOUND has no dimension 0: the array has 2 in MAIN, line 31, task FAST",
        "",
      ]);
    });
  }

  it("builds without the check under STRUCPP_NO_BOUNDS_CHECK (-Wall -Wextra -Werror)", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "bound_dim_unchecked",
      extraFlags: ["-Wall", "-Wextra", "-Werror", "-DSTRUCPP_NO_BOUNDS_CHECK"],
      mainCode: MAIN,
    });
    expect(stdout.split("|")[0]).toBe("3 9 7 3 5 0");
  });
});
