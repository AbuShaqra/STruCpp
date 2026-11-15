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

const METHOD_SOURCE = (narrowing: boolean): string => `FUNCTION_BLOCK FB
METHOD M : INT
VAR_OUTPUT mo : WORD; mq : DINT; mu : USINT; END_VAR
mo := 16#0102; mq := 300; mu := 9; M := 1;
END_METHOD
METHOD N : INT VAR b : UINT; r : INT; END_VAR r := THIS.M(mu => b); N := UINT_TO_INT(b); END_METHOD
END_FUNCTION_BLOCK
TYPE SW : STRUCT f : FB; END_STRUCT; END_TYPE
PROGRAM Main
VAR b : BYTE; s : SINT; fb : FB; n, k : INT; l, l2 : LINT; arr : ARRAY[0..1] OF FB; sw : SW; u, u2 : UINT; END_VAR
${narrowing ? "n := fb.M(mo => b);\nn := fb.M(mq => s);" : ""}
n := fb.M(mq => l, mu => u);
n := arr[0].M(mu => u2);
n := sw.f.M(mq => l2);
k := fb.N();
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

    it(`checks an FB output captured through an element, member or pointer (${label})`, () => {
      const r = compile(
        "FUNCTION_BLOCK Inner VAR_OUTPUT o : DINT; lt : LTIME; END_VAR o := 200; END_FUNCTION_BLOCK\nFUNCTION_BLOCK Mid VAR_OUTPUT inn : Inner; END_VAR END_FUNCTION_BLOCK\nTYPE SM : STRUCT m : Mid; END_STRUCT; END_TYPE\nPROGRAM Main\nVAR CONSTANT K : DINT := 1; END_VAR\nVAR ma : ARRAY[0..1] OF Mid; sm : SM; x : Inner; pf : POINTER TO Inner; t : TIME; a : SINT; d : DINT; END_VAR\nma[0].inn(o => K);\nsm.m.inn(lt => t);\npf := ADR(x);\npf^(o => K);\nma[1].inn(o => a);\nsm.m.inn(o => d);\npf^(o => d);\nEND_PROGRAM\n",
        options,
      );
      // POINTER TO is refused under iec-3; the captures are checked anyway
      const errors = r.errors
        .map((e) => e.message)
        .filter((m) => !m.startsWith("POINTER TO needs the feature"));
      expect(errors).toEqual([
        "Cannot assign to CONSTANT variable 'K'",
        "Cannot assign LTIME to TIME",
        "Cannot assign to CONSTANT variable 'K'",
        ...(strict
          ? ["Implicit conversion from DINT to SINT is not allowed; use DINT_TO_SINT"]
          : []),
      ]);
      if (!strict) {
        expect(r.warnings.map((w) => w.message)).toContain(
          "Implicit narrowing conversion from DINT to SINT",
        );
      }
    });

    it(`copies a method output out as the assignment would (${label})`, () => {
      const result = compile(METHOD_SOURCE(!strict), {
        ...options,
        headerFileName: "generated.hpp",
      });
      expect(result.errors).toEqual([]);
      const stdout = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: `outcap_m_${label.replace(/\W/g, "_")}`,
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << int(p.B.get()) << " " << int(p.S.get()) << " " << p.L.get() << " " << p.U.get() << " "
              << p.U2.get() << " " << p.L2.get() << " " << p.K.get() << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe(strict ? "0 0 300 9 9 300 9" : "2 44 300 9 9 300 9");
    });

    it(`refuses a method output its variable cannot be assigned (${label})`, () => {
      const r = compile(
        "FUNCTION_BLOCK FB\nMETHOD M : INT VAR_OUTPUT ml : LTIME; END_VAR M := 0; END_METHOD\nEND_FUNCTION_BLOCK\nPROGRAM Main\nVAR fb : FB; t : TIME; n : INT; END_VAR\nn := fb.M(ml => t);\nEND_PROGRAM\n",
        options,
      );
      expect(r.errors.map((e) => e.message)).toEqual([
        "Cannot assign LTIME to TIME",
      ]);
    });
  }
});
