// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: two STRING (or WSTRING) literals compare by text, and LEN keeps its
 * argument, in a body, a variable's initial value and a STRUCT default.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `TYPE ST_Z : STRUCT a : BOOL := 'zz' > 'aa'; b : BOOL := 'aa' > 'zz'; c : BOOL := LEN('abc') = 3; d : BOOL := 'ab' = 'ab'; e : BOOL := "ab" < "b"; END_STRUCT END_TYPE
PROGRAM Main
VAR s : ST_Z; pa : BOOL := 'zz' > 'aa'; pb : BOOL := 'aa' > 'zz'; pc : BOOL := LEN('abc') = 3; pe : BOOL := 'ab' <> 'ab'; ba, bb, sa, sb, sc, sd, se : BOOL; bl : INT; END_VAR
ba := 'zz' > 'aa'; bb := 'aa' > 'zz'; bl := LEN('abcd');
sa := s.a; sb := s.b; sc := s.c; sd := s.d; se := s.e;
END_PROGRAM
`;

describe.skipIf(!hasGpp)("literal STRING comparison — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-litstr-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const [label, options] of [
    ["no dialect", {}],
    ["iec-3", { dialect: "iec-3" }],
    ["strict", { strict: true }],
  ] as const) {
    it(`compares the text of two literals (${label})`, () => {
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
        testName: `litstr_${label.replace(/\W/g, "_")}`,
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.PA.get() << p.PB.get() << p.PC.get() << p.PE.get() << " "
              << p.BA.get() << p.BB.get() << " " << p.BL.get() << " "
              << p.SA.get() << p.SB.get() << p.SC.get() << p.SD.get() << p.SE.get() << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe("1010 10 4 10111");
    });
  }
});
