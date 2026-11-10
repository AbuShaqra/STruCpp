// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * E2E: function blocks implementing an interface (and the interface it
 * EXTENDS) only through methods and properties of a base FB, called through
 * interface variables. Built with g++ and run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

describe.skipIf(!hasGpp)("interface through a base FB — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-ifacebase-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("builds and runs", () => {
    const result = compile(
      `
      INTERFACE I_A
      METHOD Get : INT
      VAR_INPUT k : INT; END_VAR
      VAR_IN_OUT io : INT; END_VAR
      END_METHOD
      PROPERTY Q : INT
      GET
      END_GET
      SET
      END_SET
      END_PROPERTY
      END_INTERFACE
      INTERFACE I_B EXTENDS I_A
      METHOD Put
      VAR_INPUT v : INT; END_VAR
      END_METHOD
      END_INTERFACE
      FUNCTION_BLOCK FBBase
      VAR x : INT := 5; END_VAR
      METHOD Get : INT
      VAR_INPUT k : INT; END_VAR
      VAR_IN_OUT io : INT; END_VAR
        io := io + 1;
        Get := x + k;
      END_METHOD
      METHOD Put
      VAR_INPUT v : INT; END_VAR
        x := v;
      END_METHOD
      PROPERTY Q : INT
      GET
       Q := x * 2;
      END_GET
      SET
       x := Q;
      END_SET
      END_PROPERTY
      END_FUNCTION_BLOCK
      FUNCTION_BLOCK FBMid EXTENDS FBBase
      END_FUNCTION_BLOCK
      FUNCTION_BLOCK FBE EXTENDS FBMid IMPLEMENTS I_B
      END_FUNCTION_BLOCK
      FUNCTION_BLOCK FBD EXTENDS FBBase IMPLEMENTS I_A
      END_FUNCTION_BLOCK
      PROGRAM Main
      VAR d : FBD; e : FBE; r : INT; ib : I_B; ia : I_A; a : INT; b : INT; c : INT; n : INT; END_VAR
        ib := e;
        ib.Put(7);
        a := ib.Get(1, n);
        ia := e;
        ia.Q := 4;
        b := ia.Q;
        c := n;
        ia := d;
        r := ia.Get(2, n) + ia.Q;
      END_PROGRAM
    `,
      { headerFileName: "generated.hpp", features: ["+property"] },
    );
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "interface_through_base_fb",
      mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN prog;
    prog.run();
    std::cout << prog.A.get() << " " << prog.B.get() << " " << prog.C.get() << " "
              << prog.N.get() << " " << prog.R.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("8 8 1 2 17");
  });
});
