// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: NOT of an untyped constant takes its type from where it is used: into a
 * bit string it is that width's complement; into a BOOL it stays logical.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `TYPE ST : STRUCT a : WORD := NOT 16#00F0; b : BOOL := NOT 1; arr : ARRAY[0..1] OF BYTE := [NOT 16#0F, 16#01]; END_STRUCT END_TYPE
VAR_GLOBAL gw : WORD := NOT 16#00F0; END_VAR
FUNCTION F : WORD
VAR_INPUT x : WORD; END_VAR
F := x;
END_FUNCTION
FUNCTION_BLOCK FB
VAR mb : BYTE := NOT 16#F0; END_VAR
VAR_OUTPUT o : BYTE; END_VAR
o := mb;
END_FUNCTION_BLOCK
PROGRAM Main
VAR s : ST; w, w2, w3, sa, fw, gg, pw : WORD; x, sb : BOOL; fb : FB; fo, a0 : BYTE; d : DWORD; END_VAR
pw := NOT 16#0F;
w := NOT 16#00F0;
w2 := NOT (16#00F0 OR 16#000F);
w3 := (NOT 16#00F0) AND 16#FFF0;
x := NOT TRUE;
fw := F(NOT 16#00F0);
sa := s.a; sb := s.b; a0 := s.arr[0]; gg := gw; fb(); fo := fb.o;
d := NOT 16#F;
END_PROGRAM
`;

describe.skipIf(!hasGpp)("NOT typed from its use — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-not-ctx-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const [label, options] of [
    ["no dialect", {}],
    ["iec-3", { dialect: "iec-3" }],
    ["strict", { strict: true }],
  ] as const) {
    it(`complements in a bit string, stays logical in a BOOL (${label})`, () => {
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
        testName: `notctx_${label.replace(/\W/g, "_")}`,
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.PW.get() << " " << p.W.get() << " " << p.W2.get() << " " << p.W3.get() << " "
              << p.X.get() << " " << p.FW.get() << " " << p.SA.get() << " " << p.SB.get() << " "
              << int(p.A0.get()) << " " << p.GG.get() << " " << int(p.FO.get()) << " " << p.D.get() << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe(
        "65520 65295 65280 65280 0 65295 65295 0 240 65295 15 4294967280",
      );
    });
  }
});
