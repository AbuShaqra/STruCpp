// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: a VAR_TEMP of a FUNCTION_BLOCK or PROGRAM starts from its initial
 * value at every call, and a METHOD's VAR_INST starts from its initial value
 * once, then keeps its value between calls.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `PROGRAM Sub
VAR_TEMP t : INT; END_VAR
VAR_OUTPUT o : INT; END_VAR
t := t + 1; o := t;
END_PROGRAM
FUNCTION_BLOCK FB
VAR_TEMP t : INT := 5; s : STRING := 'x'; arr : ARRAY[0..1] OF INT; END_VAR
VAR_OUTPUT o : INT; os : STRING; END_VAR
METHOD M : INT
VAR_INST k : INT := 40; v : ARRAY[0..1] OF INT := [7, 8]; END_VAR
k := k + 1; M := k * 100 + v[1];
END_METHOD
t := t + 1; s := CONCAT(s, 'y'); arr[0] := arr[0] + 1;
o := t * 10 + arr[0]; os := s;
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR fb : FB; a, b, c, d : INT; s : STRING; END_VAR
fb(); fb(); a := fb.o; s := fb.os;
Sub(); Sub(); b := Sub.o;
c := fb.M(); d := fb.M();
END_PROGRAM
`;

describe.skipIf(!hasGpp)("VAR_TEMP and VAR_INST at run time — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-pouvars-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const [label, options] of [
    ["no dialect", {}],
    ["iec-3", { dialect: "iec-3" }],
    ["strict", { strict: true }],
  ] as const) {
    it(`resets VAR_TEMP per call and initialises VAR_INST once (${label})`, () => {
      const result = compile(SOURCE, {
        ...options,
        headerFileName: "generated.hpp",
        features: ["+program_methods"],
      });
      expect(result.errors).toEqual([]);
      const stdout = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: `pouvars_${label.replace(/\W/g, "_")}`,
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.A.get() << " " << p.B.get() << " " << p.C.get() << " " << p.D.get() << " "
              << p.S.get().c_str() << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe("61 1 4108 4208 xy");
    });
  }
});
