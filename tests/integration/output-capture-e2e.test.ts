// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: an output captured with `o => v` from a function block or a method
 * follows the assignment rules and is copied out with the value the
 * assignment would give, in every mode.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const MODES = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
] as const;

const FB_SOURCE = (narrowing: boolean): string => `FUNCTION_BLOCK FB
VAR_OUTPUT o : WORD := 16#0102; d : DINT := 300; u : UINT := 7; END_VAR
END_FUNCTION_BLOCK
PROGRAM Main
VAR fb : FB; b : BYTE; s : SINT; l : LINT; dw : DWORD; ud : UDINT; END_VAR
fb(d => l, o => dw, u => ud);
${narrowing ? "fb(o => b, d => s);" : ""}
END_PROGRAM
`;

describe.skipIf(!hasGpp)("output capture — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-outcap-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const [label, options] of MODES) {
    const strict = label === "strict";
    it(`copies an FB output out as the assignment would (${label})`, () => {
      const result = compile(FB_SOURCE(!strict), {
        ...options,
        headerFileName: "generated.hpp",
      });
      expect(result.errors).toEqual([]);
      expect(
        result.warnings
          .map((w) => w.message)
          .filter((m) => m.startsWith("Implicit narrowing")),
      ).toEqual(
        strict
          ? []
          : [
              "Implicit narrowing conversion from WORD to BYTE",
              "Implicit narrowing conversion from DINT to SINT",
            ],
      );
      const stdout = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: `outcap_fb_${label.replace(/\W/g, "_")}`,
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.L.get() << " " << p.DW.get() << " " << p.UD.get() << " "
              << int(p.B.get()) << " " << int(p.S.get()) << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe(strict ? "300 258 7 0 0" : "300 258 7 2 44");
    });

    it(`refuses an FB output its variable cannot be assigned (${label})`, () => {
      const r = compile(
        "FUNCTION_BLOCK FB VAR_OUTPUT lt : LTIME; o : WORD; END_VAR END_FUNCTION_BLOCK\nPROGRAM Main\nVAR CONSTANT k : WORD := 1; END_VAR\nVAR fb : FB; t : TIME; END_VAR\nfb(lt => t);\nfb(o => k);\nEND_PROGRAM\n",
        options,
      );
      expect(r.errors.map((e) => e.message)).toEqual([
        "Cannot assign LTIME to TIME",
        "Cannot assign to CONSTANT variable 'K'",
      ]);
    });
  }
});
