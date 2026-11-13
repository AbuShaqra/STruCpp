// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: AND, OR, XOR and NOT in a STRUCT element's default are bitwise, as the
 * same expression is in a POU variable's initial value.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `VAR_GLOBAL CONSTANT GM : WORD := 16#F0; END_VAR
TYPE ST : STRUCT
  a : WORD := 16#F0 AND 16#3C;
  o : WORD := 16#F0 OR 16#0F;
  x : WORD := 16#F0 XOR 16#FF;
  g : WORD := GM AND 16#30;
  n : WORD := NOT GM;
  nb : BOOL := NOT FALSE;
  b : BOOL := TRUE AND (1 > 0);
  c : BOOL := FALSE OR (2 < 1);
END_STRUCT END_TYPE
PROGRAM MAIN
VAR s : ST; pa : WORD := 16#F0 AND 16#3C; pn : WORD := NOT GM; END_VAR
END_PROGRAM
`;

describe.skipIf(!hasGpp)("bitwise operators in a STRUCT default — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-typeinit-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const [label, options] of [
    ["no dialect", {}],
    ["iec-3", { dialect: "iec-3" }],
    ["strict", { strict: true }],
  ] as const) {
    it(`gives a STRUCT default the value of the same POU initial value (${label})`, () => {
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
        testName: `typeinit_${label.replace(/\W/g, "_")}`,
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    const auto& s = p.S;
    std::cout << s.A << " " << s.O << " " << s.X << " " << s.G << " " << s.N << " "
              << s.NB << s.B << s.C << " " << p.PA.get() << " " << p.PN.get() << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe("48 255 15 48 65295 110 48 65295");
    });
  }
});
