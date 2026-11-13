// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: a store outside a subrange is a run-time fault naming the variable,
 * the value, the range, the POU and the line; stores inside it go through.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `TYPE SR : INT (0..10); END_TYPE
TYPE SA : SR; END_TYPE
TYPE ST : STRUCT f : SR; END_STRUCT END_TYPE
PROGRAM Main
VAR s : SR := 5; v : INT := 42; x : INT (1..3) := 2; a : SA; t : ST; ok : SR; END_VAR
ok := 7;
a := 9;
t.f := 10;
x := 3;
s := v;
END_PROGRAM
`;

describe.skipIf(!hasGpp)("subrange store — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-subrange-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const [label, options] of [
    ["no dialect", {}],
    ["iec-3", { dialect: "iec-3" }],
    ["strict", { strict: true }],
  ] as const) {
    it(`faults outside the range (${label})`, () => {
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
        testName: `subrange_${label.replace(/\W/g, "_")}`,
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    try { p.run(); } catch (const std::exception& e) { std::cout << e.what() << "|"; }
    std::cout << p.OK << " " << p.A << " " << p.X << " " << p.T.F << " " << p.S << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe(
        "Value 42 outside 0..10 stored in S in MAIN, line 10|7 9 3 10 5",
      );
    });
  }
});
