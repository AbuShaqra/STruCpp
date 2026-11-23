// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: `TO_TIME_OF_DAY`, `TO_LTIME_OF_DAY`, `TO_DATE_AND_TIME`,
 * `TO_LDATE_AND_TIME` and the typed `<x>_TO_<long name>` conversions build
 * under g++ and give the values of `TO_TOD`, `TO_LTOD`, `TO_DT`, `TO_LDT`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

// Label, result type, conversion by its long name, the same by its short one,
// the raw value (TOD in ms, DT in s, LTOD and LDT in ns, integers as is).
const CASES: Array<[string, string, string, string, string]> = [
  [
    "TO_TIME_OF_DAY(DINT)",
    "TOD",
    "TO_TIME_OF_DAY(ms)",
    "TO_TOD(ms)",
    "45015250",
  ],
  [
    "TO_TIME_OF_DAY(DT)",
    "TOD",
    "TO_TIME_OF_DAY(dt1)",
    "TO_TOD(dt1)",
    "45015000",
  ],
  [
    "TO_TIME_OF_DAY(STRING)",
    "TOD",
    "TO_TIME_OF_DAY(st)",
    "TO_TOD(st)",
    "45015250",
  ],
  [
    "DINT_TO_TIME_OF_DAY",
    "TOD",
    "DINT_TO_TIME_OF_DAY(ms)",
    "DINT_TO_TOD(ms)",
    "45015250",
  ],
  [
    "DT_TO_TIME_OF_DAY",
    "TOD",
    "DT_TO_TIME_OF_DAY(dt1)",
    "DT_TO_TOD(dt1)",
    "45015000",
  ],
  [
    "TIME_OF_DAY_TO_DINT",
    "DINT",
    "TIME_OF_DAY_TO_DINT(tod1)",
    "TOD_TO_DINT(tod1)",
    "45015250",
  ],
  [
    "TO_LTIME_OF_DAY(TOD)",
    "LTOD",
    "TO_LTIME_OF_DAY(tod1)",
    "TO_LTOD(tod1)",
    "45015250000000",
  ],
  [
    "LDT_TO_LTIME_OF_DAY",
    "LTOD",
    "LDT_TO_LTIME_OF_DAY(ldt1)",
    "LDT_TO_LTOD(ldt1)",
    "45015000000000",
  ],
  [
    "TOD_TO_LTIME_OF_DAY",
    "LTOD",
    "TOD_TO_LTIME_OF_DAY(tod1)",
    "TOD_TO_LTOD(tod1)",
    "45015250000000",
  ],
  [
    "TO_DATE_AND_TIME(UDINT)",
    "DT",
    "TO_DATE_AND_TIME(secs)",
    "TO_DT(secs)",
    "1721046615",
  ],
  [
    "TO_DATE_AND_TIME(DATE)",
    "DT",
    "TO_DATE_AND_TIME(d1)",
    "TO_DT(d1)",
    "1721001600",
  ],
  [
    "TO_DATE_AND_TIME(STRING)",
    "DT",
    "TO_DATE_AND_TIME(sdt)",
    "TO_DT(sdt)",
    "1721046615",
  ],
  [
    "UDINT_TO_DATE_AND_TIME",
    "DT",
    "UDINT_TO_DATE_AND_TIME(secs)",
    "UDINT_TO_DT(secs)",
    "1721046615",
  ],
  [
    "DATE_AND_TIME_TO_UDINT",
    "UDINT",
    "DATE_AND_TIME_TO_UDINT(dt1)",
    "DT_TO_UDINT(dt1)",
    "1721046615",
  ],
  [
    "TO_LDATE_AND_TIME(DT)",
    "LDT",
    "TO_LDATE_AND_TIME(dt1)",
    "TO_LDT(dt1)",
    "1721046615000000000",
  ],
  [
    "DT_TO_LDATE_AND_TIME",
    "LDT",
    "DT_TO_LDATE_AND_TIME(dt1)",
    "DT_TO_LDT(dt1)",
    "1721046615000000000",
  ],
  [
    "LDATE_AND_TIME_TO_DATE_AND_TIME",
    "DT",
    "LDATE_AND_TIME_TO_DATE_AND_TIME(ldt1)",
    "LDT_TO_DT(ldt1)",
    "1721046615",
  ],
];

const SOURCE = `PROGRAM MAIN
VAR
  ms : DINT := 45015250;
  secs : UDINT := 1721046615;
  dt1 : DT := DT#2024-07-15-12:30:15;
  ldt1 : LDT := LDT#2024-07-15-12:30:15;
  tod1 : TOD := TOD#12:30:15.250;
  d1 : DATE := D#2024-07-15;
  st : STRING := 'TOD#12:30:15.250';
  sdt : STRING := 'DT#2024-07-15-12:30:15';
${CASES.map(([, type], i) => `  L${i} : ${type}; S${i} : ${type};`).join("\n")}
END_VAR
${CASES.map(([, , long, short], i) => `L${i} := ${long}; S${i} := ${short};`).join("\n")}
END_PROGRAM
`;

const PRINT = CASES.map(
  (_, i) => `    std::cout << p.L${i}.get() << " " << p.S${i}.get() << "\\n";`,
).join("\n");

describe.skipIf(!hasGpp)(
  "long date and time conversion names — g++ e2e",
  () => {
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-longconv-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    for (const options of [{}, { dialect: "iec-3" }, { strict: true }]) {
      it(`give the short names' values (${JSON.stringify(options)})`, () => {
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
          testName: `longconv_${JSON.stringify(options).replace(/\W/g, "_")}`,
          mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
${PRINT}
    return 0;
}
`,
        });
        const lines = stdout.trim().split("\n");
        expect(lines.length).toBe(CASES.length);
        CASES.forEach(([label, , , , value], i) => {
          expect(`${label}: ${lines[i]}`).toBe(`${label}: ${value} ${value}`);
        });
      });
    }
  },
);
