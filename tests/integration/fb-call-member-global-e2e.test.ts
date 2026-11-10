// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * E2E: a function block called as a member of another instance or as a
 * file-level global, a bit selected by a named constant, and a method call
 * on a variable named like its type build with g++ and run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

describe.skipIf(!hasGpp)(
  "FB call on a member or global instance — g++ e2e",
  () => {
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-fbcallmg-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    it("builds and runs", () => {
      const result = compile(
        `
      FUNCTION_BLOCK FBS
      VAR_INPUT k : INT; END_VAR
      VAR_OUTPUT o : INT; END_VAR
        o := o + k + 1;
      END_FUNCTION_BLOCK
      FUNCTION_BLOCK FBH
      VAR sub : FBS; END_VAR
      VAR_OUTPUT so : INT; END_VAR
        so := sub.o;
      END_FUNCTION_BLOCK
      FUNCTION_BLOCK FBB
      METHOD M : INT
      VAR_INPUT x : INT; END_VAR
        M := x * 2;
      END_METHOD
      END_FUNCTION_BLOCK
      VAR_GLOBAL gfb : FBS; END_VAR
      VAR_GLOBAL CONSTANT G5 : INT := 5; END_VAR
      PROGRAM Main
      VAR CONSTANT C3 : INT := 3; END_VAR
      VAR inst : FBH; fbb : FBB; w : WORD := 16#0008; b3 : BOOL; b5 : BOOL;
        a : INT; g : INT; m : INT; END_VAR
        inst.sub();
        inst.sub(k := 5);
        inst();
        a := inst.so;
        gfb(k := 2);
        gfb(3);
        g := gfb.o;
        b3 := w.C3;
        w.C3 := FALSE;
        w.G5 := TRUE;
        b5 := w.G5;
        m := fbb.M(x := 21);
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
        testName: "fb_call_member_global",
        mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN prog;
    prog.run();
    std::cout << prog.A.get() << " " << prog.G.get() << " " << prog.B3.get() << " "
              << prog.B5.get() << " " << prog.W.get() << " " << prog.M.get() << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe("7 7 1 1 32 42");
    });
  },
);
