// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: SIZEOF and XSIZEOF of a type name give the size of a value of that
 * type, the same as of a variable of the type.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = (xsizeof: boolean): string => `TYPE ST_Status : STRUCT ready : BOOL; fault : BOOL := TRUE; code : INT; END_STRUCT END_TYPE
TYPE MYI : INT; END_TYPE
TYPE AR : ARRAY[0..3] OF INT; END_TYPE
FUNCTION F : UDINT
F := SIZEOF(ST_Status);
END_FUNCTION
PROGRAM Main
VAR n, nv, m, k, a, l, fn : UDINT; x : ULINT; s : ST_Status; END_VAR
n := SIZEOF(ST_Status); nv := SIZEOF(s); m := SIZEOF(INT); k := SIZEOF(MYI); a := SIZEOF(AR);
l := SIZEOF(LREAL); fn := F();
${xsizeof ? "x := XSIZEOF(ST_Status);" : "x := 4;"}
END_PROGRAM
`;

describe.skipIf(!hasGpp)("SIZEOF of a type name — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-sizeof-type-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const [label, options, xsizeof] of [
    ["no dialect", {}, false],
    ["vendor_operators", { features: ["+vendor_operators"] }, true],
    ["iec-3", { dialect: "iec-3" }, false],
    ["strict", { strict: true }, false],
  ] as const) {
    it(`measures a type as a value of it (${label})`, () => {
      const result = compile(SOURCE(xsizeof), {
        ...options,
        headerFileName: "generated.hpp",
      });
      expect(result.errors).toEqual([]);
      expect(result.cppCode).toContain("IEC_SIZEOF(ST_STATUS{})");
      const stdout = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: `sizeof_type_${label.replace(/\W/g, "_")}`,
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.N.get() << " " << p.NV.get() << " " << p.M.get() << " " << p.K.get() << " "
              << p.A.get() << " " << p.L.get() << " " << p.FN.get() << " " << p.X.get() << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe("4 4 2 2 8 8 4 4");
    });
  }
});
