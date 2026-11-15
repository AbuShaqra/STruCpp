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
  far : DATE := D#2106-02-06; old : DATE := D#1970-01-01; xf : DATE; xo : DATE; neg : DATE;
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

// Name, value now (DATE and DT in seconds, TIME and TOD in ms), value before
// the 32-bit types (TIME and TOD in ns, DATE in days).
const EXPECTED: Array<[string, string, string]> = [
  ["DST(2024-07-15) (OSCAT)", "1", "1"],
  ["DST(2024-01-15) (OSCAT)", "0", "0"],
  ["DT_TO_DATE (seconds since 1970)", "1721001600", "19919"],
  ["DT_TO_TOD (ms since midnight)", "45015000", "45015000000000"],
  ["D#2024-01-20 - D#2024-01-15 (ms, T#5d)", "432000000", "432000000000000"],
  ["D#2024-01-15 + T#1d (seconds)", "1705363200", "19738"],
  ["alias DATE - alias DATE (ms)", "432000000", "432000000000000"],
  ["FB output DATE - DATE (ms)", "432000000", "432000000000000"],
  ["alias DATE + alias TIME (seconds)", "1705363200", "19738"],
  ["TO_DATE of an alias of DT (seconds)", "1721001600", "19919"],
  ["TO_TOD of CONCAT_DATE_TOD (ms)", "45015000", "45015000000000"],
  ["D#2106-02-06 + T#1d, the last DATE (seconds)", "4294944000", "49710"],
  ["D#1970-01-01 + T#1d (seconds)", "86400", "1"],
  [
    "D#2024-01-15 - T#36h (the day holding the instant, D#2024-01-13)",
    "1705104000",
    "19735",
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

    it("takes REFERENCE TO DATE and DT operands, as development did", () => {
      const result = compile(
        `PROGRAM Main
VAR d1 : DATE := D#2024-01-15; d2 : DATE := D#2024-01-20; dt1 : DT := DT#2024-07-15-12:30:15;
  rd : REFERENCE TO DATE; rdt : REFERENCE TO DT; c1 : TIME; c2 : DATE; c4 : TOD; c5 : DATE; END_VAR
rd REF= d1; rdt REF= dt1;
c1 := d2 - rd;
c2 := rd + T#1d;
c4 := TO_TOD(rdt);
c5 := DT_TO_DATE(rdt);
END_PROGRAM
`,
        {
          headerFileName: "generated.hpp",
          features: ["+reference_to", "+ref_assign"],
        },
      );
      expect(result.errors).toEqual([]);
      const stdout = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: "tconv_refs",
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.C1.get() << " " << p.C2.get() << " " << p.C4.get() << " " << p.C5.get() << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe("432000000 1705363200 45015000 1721001600");
    });

    for (const options of [{}, { dialect: "iec-3" }, { strict: true }]) {
      it(`moves a date by days through SEL, LIMIT, MUX, STRUCT defaults and array initialisers (${JSON.stringify(options)})`, () => {
        const result = compile(
          `TYPE SD : STRUCT a : DATE := D#2024-01-15 - T#1ms; END_STRUCT; END_TYPE
PROGRAM Main
VAR
  d : DATE := D#2024-01-15; d2 : DATE := D#2024-01-10; b : BOOL := TRUE;
  r1, r2, r3, r4 : DATE; t1 : TIME; sv : SD;
  arr : ARRAY[0..1] OF DATE := [D#2024-01-15 - T#1ms, D#2024-01-15];
END_VAR
r1 := SEL(b, d2, d) - T#1ms;
r2 := d + SEL(b, T#1d, T#2d);
t1 := SEL(b, d2, d) - d2;
r3 := LIMIT(d2, d, d) + T#1d;
r4 := MUX(0, d, d2) + T#1d;
END_PROGRAM
`,
          { ...options, headerFileName: "generated.hpp" },
        );
        expect(result.errors).toEqual([]);
        const stdout = compileAndRunStandalone({
          tempDir,
          pchPath,
          headerCode: result.headerCode,
          cppCode: result.cppCode,
          testName: `tconv_select_${Object.keys(options).join("_") || "none"}`,
          mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.R1.get() << " " << p.R2.get() << " " << p.T1.get() << " " << p.R3.get() << " "
              << p.R4.get() << " " << p.SV.A.get() << " " << p.ARR[0].get() << std::endl;
    return 0;
}
`,
        });
        expect(stdout).toBe(
          "1705190400 1705449600 432000000 1705363200 1705363200 1705190400 1705190400",
        );
      });
    }
  },
);
