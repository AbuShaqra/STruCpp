// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: invoking a function block held in an element of a global array
 * (`units[0](…)`), of a named ARRAY type, through its global variable list
 * (`GVL_A.units[1](…)`) and through a member path (`h.arr[1](…)`).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const MAIN = `FUNCTION_BLOCK FB_U
VAR_INPUT step : INT; END_VAR
VAR_OUTPUT n : INT; END_VAR
n := n + step;
END_FUNCTION_BLOCK
TYPE TA : ARRAY[0..1] OF FB_U; END_TYPE
FUNCTION_BLOCK FB_H
VAR PUBLIC arr : ARRAY[0..1] OF FB_U; END_VAR
END_FUNCTION_BLOCK
VAR_GLOBAL named : TA; END_VAR
PROGRAM Main
VAR h : FB_H; r1 : INT; r2 : INT; r3 : INT; r4 : INT; END_VAR
units[0](step := 2);
units[0]();
GVL_A.units[1](step := 5);
named[1](step := 7);
h.arr[1](step := 9);
r1 := units[0].n;
r2 := GVL_A.units[1].n;
r3 := named[1].n;
r4 := h.arr[1].n;
END_PROGRAM
`;

describe.skipIf(!hasGpp)(
  "FB invocation in a global array element — g++ e2e",
  () => {
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-garrfb-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    it("builds and runs", () => {
      const result = compile(MAIN, {
        headerFileName: "generated.hpp",
        fileName: "main.st",
        additionalSources: [
          {
            source: "VAR_GLOBAL units : ARRAY[0..1] OF FB_U; END_VAR\n",
            fileName: "gvl_a.st",
            globalListName: "GVL_A",
          },
        ],
        features: ["+named_global_lists"],
      });
      expect(result.errors).toEqual([]);
      const stdout = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: "global_array_fb_call",
        mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN p;
    p.run();
    std::cout << p.R1.get() << " " << p.R2.get() << " " << p.R3.get() << " "
              << p.R4.get() << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe("4 5 7 9");
    });
  },
);
