// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: STRUCT field defaults naming global constants (declared after the
 * type, chained, REAL, STRING, in an ARRAY default, list-qualified) build and
 * run with the constants' values, for a local and a global of the type.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `TYPE ST : STRUCT
  a : INT := K * 2 + 1;
  r : REAL := RK / 2.0;
  s : STRING := SK;
  arr : ARRAY[0..1] OF INT := [K, GVL_C.cDefault];
END_STRUCT END_TYPE
VAR_GLOBAL CONSTANT K : INT := J + 1; RK : REAL := 3.0; SK : STRING := 'hi'; J : INT := 4; END_VAR
VAR_GLOBAL s1 : ST; END_VAR
PROGRAM Main
VAR x : INT; y : REAL; z : STRING; v : INT; l : ST; END_VAR
x := l.a * 100 + s1.a;
y := l.r;
z := l.s;
v := l.arr[0] * 100 + l.arr[1];
END_PROGRAM
`;

describe.skipIf(!hasGpp)(
  "STRUCT field defaults naming constants — g++ e2e",
  () => {
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-fielddef-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    it("builds and runs", () => {
      const result = compile(SOURCE, {
        headerFileName: "generated.hpp",
        additionalSources: [
          {
            source: "VAR_GLOBAL CONSTANT cDefault : INT := 41; END_VAR\n",
            fileName: "gvl_c.st",
            globalListName: "GVL_C",
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
        testName: "struct_field_default_globals",
        mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN p;
    p.run();
    std::cout << p.X.get() << " " << p.Y.get() << " " << p.Z.get().c_str() << " "
              << p.V.get() << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe("1111 1.5 hi 541");
    });
  },
);
