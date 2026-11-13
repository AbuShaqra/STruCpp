// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: a date or time value converted to STRING gives its canonical IEC
 * literal (T#1h2m3s4ms, D#2024-03-05, TOD#12:34:56.789, DT#...), long forms too.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `PROGRAM Main
VAR t : TIME := T#1h2m3s4ms; lt : LTIME := LTIME#1d2h; d : DATE := D#2024-03-05; tod : TOD := TOD#12:34:56.789;
  dt : DT := DT#2024-03-05-12:34:56; b : BOOL := TRUE; ld : LDATE := LDATE#2024-03-05; z : TIME := T#0s;
  ng : TIME := T#-1500ms; ltod : LTOD := LTOD#01:02:03.000456; ldt : LDT := LDT#2000-01-01-00:00:00.5;
  old : DATE := D#1969-12-31;
  s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12 : STRING; END_VAR
s1 := TIME_TO_STRING(t); s2 := LTIME_TO_STRING(lt); s3 := DATE_TO_STRING(d); s4 := TOD_TO_STRING(tod);
s5 := DT_TO_STRING(dt); s6 := BOOL_TO_STRING(b); s7 := LDATE_TO_STRING(ld); s8 := TIME_TO_STRING(z);
s9 := TO_STRING(ng); s10 := LTOD_TO_STRING(ltod); s11 := LDT_TO_STRING(ldt); s12 := DATE_TO_STRING(old);
END_PROGRAM
`;

describe.skipIf(!hasGpp)("date and time to STRING — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-temporal-text-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const [label, options] of [
    ["no dialect", {}],
    ["iec-3", { dialect: "iec-3" }],
    ["strict", { strict: true }],
  ] as const) {
    it(`gives the canonical literal (${label})`, () => {
      const result = compile(SOURCE, {
        ...options,
        headerFileName: "generated.hpp",
      });
      expect(result.errors).toEqual([]);
      const names = [
        "S1",
        "S2",
        "S3",
        "S4",
        "S5",
        "S6",
        "S7",
        "S8",
        "S9",
        "S10",
        "S11",
        "S12",
      ];
      const stdout = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: `temporal_text_${label.replace(/\W/g, "_")}`,
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    ${names.map((n) => `std::cout << p.${n}.get().c_str() << "|";`).join("\n    ")}
    std::cout << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe(
        "T#1h2m3s4ms|LTIME#1d2h|D#2024-03-05|TOD#12:34:56.789|DT#2024-03-05-12:34:56|TRUE|LDATE#2024-03-05|T#0ms|T#-1s500ms|LTOD#01:02:03.000456|LDT#2000-01-01-00:00:00.5|D#1969-12-31|",
      );
    });
  }
});
