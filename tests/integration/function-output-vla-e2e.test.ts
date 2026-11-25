// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: a FUNCTION or METHOD `VAR_OUTPUT` of type ARRAY[*] (Ed. 3 6.5.3)
 * is a view of the array bound to it, passed by value: writes reach the
 * bound array (a local, a list global, a CONFIGURATION global, 2-D, through
 * an interface); an unbound one is an empty array.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `INTERFACE I_A
METHOD Fill : INT
VAR_OUTPUT a : ARRAY[*] OF INT; END_VAR
END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB_A IMPLEMENTS I_A
METHOD Fill : INT
VAR_OUTPUT a : ARRAY[*] OF INT; END_VAR
a[UPPER_BOUND(a, 1)] := 9;
Fill := DINT_TO_INT(UPPER_BOUND(a, 1));
END_METHOD
END_FUNCTION_BLOCK
FUNCTION F : INT
VAR_OUTPUT a : ARRAY[*] OF INT; END_VAR
VAR i : DINT; END_VAR
FOR i := LOWER_BOUND(a, 1) TO UPPER_BOUND(a, 1) DO
  a[i] := DINT_TO_INT(i) * 2;
END_FOR
F := DINT_TO_INT(UPPER_BOUND(a, 1) - LOWER_BOUND(a, 1) + 1);
END_FUNCTION
FUNCTION F2 : INT
VAR_OUTPUT a : ARRAY[*, *] OF INT; END_VAR
a[1, 2] := 4;
F2 := 1;
END_FUNCTION
VAR_GLOBAL g : ARRAY[1..2, 1..2] OF INT; END_VAR
PROGRAM Main
VAR_EXTERNAL g : ARRAY[1..2, 1..2] OF INT; END_VAR
VAR
  fb : FB_A; it : I_A;
  arr : ARRAY[0..4] OF INT; loc : ARRAY[1..3] OF INT;
  o1, o2, o3, o4 : INT;
END_VAR
it := fb;
o1 := it.Fill(a => arr) + fb.Fill(a => arr);
F2(a => g);
o2 := arr[4] + g[1, 2];
o3 := F(a => loc) * 100 + loc[3];
o4 := F();
END_PROGRAM
`;

const CONFIG = `FUNCTION F : INT
VAR_OUTPUT a : ARRAY[*] OF INT; END_VAR
a[2] := 6;
F := 1;
END_FUNCTION
PROGRAM Main
VAR_EXTERNAL g : ARRAY[1..2] OF INT; END_VAR
VAR o1 : INT; END_VAR
F(a => g);
o1 := g[2];
END_PROGRAM
CONFIGURATION Cfg
VAR_GLOBAL g : ARRAY[1..2] OF INT; END_VAR
RESOURCE R ON PLC
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM inst WITH T : Main;
END_RESOURCE
END_CONFIGURATION
`;

describe("FUNCTION / METHOD VAR_OUTPUT ARRAY[*] parameters", () => {
  it("are views passed by value", () => {
    const r = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(r.errors).toEqual([]);
    expect(r.headerCode).toContain("IEC_INT F(ArrayView1D<IEC_INT> A);");
    expect(r.headerCode).toContain("IEC_INT F2(ArrayView2D<IEC_INT> A);");
    expect(r.headerCode).toMatch(/FILL\(ArrayView1D<IEC_INT> A\)/);
    expect(r.headerCode).not.toMatch(/ArrayView\dD<IEC_INT>& A/);
  });
});

describe.skipIf(!hasGpp)(
  "FUNCTION / METHOD VAR_OUTPUT ARRAY[*] — g++ e2e",
  () => {
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-outvla-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    it("writes reach the bound array", () => {
      const r = compile(SOURCE, { headerFileName: "generated.hpp" });
      expect(r.errors).toEqual([]);
      const out = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: r.headerCode,
        cppCode: r.cppCode,
        testName: "function_output_vla",
        mainCode: `#include <iostream>
int main() {
  strucpp::Program_MAIN p;
  p.run();
  std::cout << p.O1 << " " << p.O2 << " " << p.O3 << " " << p.O4 << std::endl;
  return 0;
}
`,
      });
      expect(out.trim()).toBe("8 13 306 0");
    });

    it("writes reach a CONFIGURATION global", () => {
      const r = compile(CONFIG, { headerFileName: "generated.hpp" });
      expect(r.errors).toEqual([]);
      const out = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: r.headerCode,
        cppCode: r.cppCode,
        testName: "function_output_vla_cfg",
        mainCode: `#include <iostream>
int main() {
  static strucpp::Configuration_CFG cfg;
  cfg.INST.run();
  std::cout << cfg.INST.O1.get() << std::endl;
  return 0;
}
`,
      });
      expect(out.trim()).toBe("6");
    });
  },
);
