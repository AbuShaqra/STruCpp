// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: a function block's VAR_EXTERNAL reaching a global of the resource its
 * program instance runs in, directly and through a nested block, builds and runs.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `FUNCTION_BLOCK FB_U
VAR_EXTERNAL r2g : INT; END_VAR
VAR_OUTPUT o : INT; END_VAR
o := r2g;
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_W
VAR inner : FB_U; END_VAR
VAR_OUTPUT o : INT; END_VAR
inner();
o := inner.o;
END_FUNCTION_BLOCK
PROGRAM Main
VAR u : FB_U; w : FB_W; x : INT; y : INT; END_VAR
u();
w();
x := u.o;
y := w.o;
END_PROGRAM
PROGRAM Other
VAR z : INT; END_VAR
z := 1;
END_PROGRAM
CONFIGURATION Cfg
RESOURCE R1 ON PLC
VAR_GLOBAL r2g : INT := 7; END_VAR
TASK T1(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM inst WITH T1 : Main;
END_RESOURCE
RESOURCE R2 ON PLC

TASK T2(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM inst2 WITH T2 : Other;
END_RESOURCE
END_CONFIGURATION
`;

describe.skipIf(!hasGpp)(
  "RESOURCE global through a function block — g++ e2e",
  () => {
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-resfb-"));
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
        testName: "resource_global_through_fb",
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Configuration_CFG cfg;
    cfg.INST.run();
    std::cout << cfg.INST.X.get() << " " << cfg.INST.Y.get() << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe("7 7");
    });
  },
);
