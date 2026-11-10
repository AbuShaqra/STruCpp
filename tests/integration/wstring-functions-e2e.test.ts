// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * E2E: the standard string functions and `=` on WSTRING variables of
 * different lengths and WSTRING literals, next to the STRING ones. Built with
 * g++ and run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

describe.skipIf(!hasGpp)("WSTRING functions — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-wstre2e-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("builds and runs", () => {
    const result = compile(
      `
      PROGRAM Main
      VAR w : WSTRING := "abcdef"; v : WSTRING(10) := "XY"; r : WSTRING; n : INT; k : INT := 2;
        b1 : BOOL; b2 : BOOL; b3 : BOOL; b4 : BOOL; b5 : BOOL; b6 : BOOL; b7 : BOOL; b8 : BOOL; s : STRING := 'ab'; t : STRING; b9 : BOOL; END_VAR
        r := CONCAT(w, v);            b1 := r = "abcdefXY";
        r := CONCAT(v, "-", w, v);    b2 := r = "XY-abcdefXY";
        r := LEFT(w, k);              b3 := r = "ab";
        r := RIGHT(w, 2);             b4 := r = "ef";
        r := MID(w, 2, 3);            b5 := r = "cd";
        r := INSERT(w, v, 2);         b6 := r = "abXYcdef";
        r := DELETE(w, 2, 2);         b7 := r = "adef";
        r := REPLACE(w, v, 2, 2);     b8 := r = "aXYdef";
        n := FIND(w, "cd") * 100 + LEN(w) * 10 + LEN(v);
        t := CONCAT(s, 'c');          b9 := t = 'abc';
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
      testName: "wstring_functions_e2e",
      mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN p;
    p.run();
    std::cout << p.B1.get() << p.B2.get() << p.B3.get() << p.B4.get() << p.B5.get()
              << p.B6.get() << p.B7.get() << p.B8.get() << p.B9.get() << " " << p.N.get()
              << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("111111111 362");
  });
});
