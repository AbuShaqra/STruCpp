// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: DT_TO_DATE, DT_TO_TOD, DATE - DATE and DATE + TIME give the IEC values
 * under g++, and so does OSCAT's DST, which uses DT_TO_DATE. The values before
 * this change are kept beside each, for the release note.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const LIBS_DIR = path.resolve(__dirname, "../../libs");
const libsAvailable = fs.existsSync(path.join(LIBS_DIR, "oscat-basic.stlib"));

const SOURCE = `TYPE MyDate : DATE; END_TYPE
TYPE MyTime : TIME; END_TYPE
TYPE MyDT : DT; END_TYPE
FUNCTION_BLOCK FB VAR_OUTPUT o : DATE; END_VAR o := D#2024-01-20; END_FUNCTION_BLOCK
PROGRAM Main
VAR
  m1 : MyDate := D#2024-01-15; m2 : MyDate := D#2024-01-20; d1 : DATE := D#2024-01-15;
  mt : MyTime := T#1d; fb1 : FB; m : MyDT := DT#2024-07-15-12:30:15;
  t1 : TIME; t7 : TIME; x1 : DATE; r5 : DATE; r7 : TOD;
  far : DATE := D#2500-01-01; old : DATE := D#1600-01-01; xf : DATE; xo : DATE; neg : DATE;
  dt1 : DT := DT#2024-07-15-12:30:15;
  dw : DT := DT#2024-01-15-12:30:15;
  summer : BOOL; winter : BOOL; dd : DATE; tt : TOD; diff : TIME; nx : DATE;
END_VAR
summer := DST(dt1);
winter := DST(dw);
dd := DT_TO_DATE(dt1);
tt := DT_TO_TOD(dt1);
diff := D#2024-01-20 - D#2024-01-15;
nx := D#2024-01-15 + T#1d;
fb1();
t1 := m2 - m1;
t7 := fb1.o - d1;
x1 := m1 + mt;
r5 := TO_DATE(m);
r7 := TO_TOD(CONCAT_DATE_TOD(D#2024-07-15, TOD#12:30:15));
xf := far + T#1d;
xo := old + T#1d;
neg := d1 - T#36h;
END_PROGRAM
`;

// Name, value now, value before (raw nanoseconds or days, mixed up).
const EXPECTED: Array<[string, string, string]> = [
  ["DST(2024-07-15) (OSCAT)", "1", "0"],
  ["DST(2024-01-15) (OSCAT)", "0", "0"],
  ["DT_TO_DATE (days since 1970)", "19919", "1721046615000000000"],
  ["DT_TO_TOD (ns since midnight)", "45015000000000", "1721046615000000000"],
  ["D#2024-01-20 - D#2024-01-15 (ns, T#5d)", "432000000000000", "5"],
  ["D#2024-01-15 + T#1d (days since 1970)", "19738", "86400000019737"],
  ["alias DATE - alias DATE (ns)", "432000000000000", "5"],
  ["FB output DATE - DATE (ns)", "432000000000000", "5"],
  ["alias DATE + alias TIME (days)", "19738", "86400000019737"],
  ["TO_DATE of an alias of DT (days)", "19919", "1721046615000000000"],
  ["TO_TOD of CONCAT_DATE_TOD (ns)", "45015000000000", "1721046615000000000"],
  ["D#2500-01-01 + T#1d (days)", "193580", "86400000193579"],
  ["D#1600-01-01 + T#1d (days)", "-135139", "86399999864860"],
  [
    "D#2024-01-15 - T#36h (whole days, toward zero)",
    "19736",
    "-129599999980263",
  ],
];

describe.skipIf(!hasGpp || !libsAvailable)(
  "DT_TO_DATE, DT_TO_TOD and DATE arithmetic — g++ e2e",
  () => {
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-tconv-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    for (const options of [{}, { dialect: "iec-3" }, { strict: true }]) {
      it(`gives the IEC values (${JSON.stringify(options)})`, () => {
        const result = compile(SOURCE, {
          ...options,
          headerFileName: "generated.hpp",
          libraries: discoverStlibs(LIBS_DIR),
        });
        expect(result.errors).toEqual([]);
        const stdout = compileAndRunStandalone({
          tempDir,
          pchPath,
          headerCode: result.headerCode,
          cppCode: result.cppCode,
          testName: `tconv_${JSON.stringify(options).replace(/\W/g, "_")}`,
          mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.SUMMER.get() << " " << p.WINTER.get() << " " << p.DD.get() << " "
              << p.TT.get() << " " << p.DIFF.get() << " " << p.NX.get() << " "
              << p.T1.get() << " " << p.T7.get() << " " << p.X1.get() << " " << p.R5.get() << " "
              << p.R7.get() << " " << p.XF.get() << " " << p.XO.get() << " " << p.NEG.get() << std::endl;
    return 0;
}
`,
        });
        expect(stdout).toBe(EXPECTED.map(([, now]) => now).join(" "));
        expect(stdout).not.toBe(
          EXPECTED.map(([, , before]) => before).join(" "),
        );
      });
    }
  },
);
