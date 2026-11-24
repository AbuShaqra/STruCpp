// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: a STRING / WSTRING literal is the text before its `$00`, as a stored
 * string is: comparisons, LEN, CONCAT, assignment, an initial value and a
 * function argument all agree, and the check warns at the literal. g++ runs it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `FUNCTION LenOf : INT
VAR_INPUT s : STRING; END_VAR
LenOf := LEN(s);
END_FUNCTION
PROGRAM Main
VAR
  eq, eq2, ne, eqw : BOOL;
  n, n2, nw : INT;
  s, c : STRING;
  i : STRING := 'in$00it';
  w : WSTRING;
END_VAR
eq := 'a' = 'a$00b';
eq2 := 'a$00b' = 'a$00c';
ne := 'a$00b' <> 'a';
n := LEN('ab$00cd');
s := 'xy$00z';
c := CONCAT('a$00b', 'c');
n2 := LenOf('pqr$00st');
w := "uv$0000w";
nw := LEN(w);
eqw := w = "uv";
END_PROGRAM
`;

const MAIN = `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.EQ.get() << p.EQ2.get() << p.NE.get() << " " << p.N.get()
              << " " << p.S.c_str() << " " << p.C.c_str() << " " << p.I.c_str()
              << " " << p.N2.get() << " " << p.NW.get() << p.EQW.get() << std::endl;
    return 0;
}
`;

describe.skipIf(!hasGpp)("$00 ends a STRING literal — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-nul-literal-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const [label, options] of [
    ["no dialect", {}],
    ["iec-3", { dialect: "iec-3" }],
    ["strict", { strict: true }],
  ] as const) {
    it(`agrees everywhere and warns (${label})`, () => {
      const result = compile(SOURCE, {
        ...options,
        headerFileName: "generated.hpp",
      });
      expect(result.errors).toEqual([]);
      expect(
        result.warnings.filter((w) => /ends the/.test(w.message)).length,
      ).toBe(10);
      const stdout = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: `nul_literal_${label.replace(/\W/g, "_")}`,
        mainCode: MAIN,
      });
      expect(stdout).toBe("110 2 xy ac in 3 21");
    });
  }
});
