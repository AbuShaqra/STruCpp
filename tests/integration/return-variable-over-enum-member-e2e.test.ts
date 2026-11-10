// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * E2E: a function, method and property getter named like an enumeration
 * member assign and read their own return variable, while the bare name
 * stays the member elsewhere. Built with g++ and run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

describe.skipIf(!hasGpp)(
  "return variable over an enum member — g++ e2e",
  () => {
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-retenum-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    it("builds and runs", () => {
      const result = compile(
        `
      TYPE E_MODE : (ALPHA, BETA, GAMMA); END_TYPE
      FUNCTION ALPHA : INT
      VAR_INPUT x : INT; END_VAR
        ALPHA := x + 1;
        ALPHA := ALPHA * 2;
      END_FUNCTION
      FUNCTION_BLOCK FB
      METHOD BETA : INT
        BETA := 7;
        BETA := BETA + 1;
      END_METHOD
      PROPERTY GAMMA : INT
      GET
        GAMMA := 5;
      END_GET
      END_PROPERTY
      END_FUNCTION_BLOCK
      FUNCTION Other : E_MODE
        Other := ALPHA;
      END_FUNCTION
      PROGRAM Main
      VAR r : INT; f : FB; r2 : INT; r3 : INT; m : E_MODE := BETA; m2 : E_MODE; END_VAR
        r := ALPHA(4);
        r2 := f.BETA();
        r3 := f.GAMMA;
        m2 := Other();
        IF m = E_MODE#BETA AND m2 = E_MODE#ALPHA THEN r := r + 100; END_IF;
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
        testName: "return_variable_over_enum_member",
        mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN prog;
    prog.run();
    std::cout << prog.R.get() << " " << prog.R2.get() << " " << prog.R3.get() << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe("110 8 5");
    });
  },
);
