// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: the Table 36 functions concatenate and split dates and times correctly
 * under g++ (leap day, pre-1970 date, Sunday is 0), and with OSCAT loaded its
 * own DAY_OF_WEEK (Sunday is 7) is the one that runs.
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

const SOURCE = `PROGRAM Main
VAR
  d : DATE; old : DATE; t : TOD; lt : LTOD; dt : DT; ldt : LDT; ok : BOOL;
  y : UINT; mo : USINT; dd : USINT; h : USINT; mi : USINT; s : USINT; ms : UINT;
  oy : UINT; omo : USINT; odd : USINT; sun : INT; wed : INT;
  ty : UINT; tmo : USINT; tdd : USINT; th : USINT; tmi : USINT; ts : USINT; tms : UINT;
END_VAR
d := CONCAT_DATE(2024, 2, 29);
old := CONCAT_DATE(1969, 12, 31);
t := CONCAT_TOD(12, 30, 15, 250);
lt := CONCAT_LTOD(12, 30, 15, 250);
dt := CONCAT_DT(2024, 2, 29, 12, 30, 15, 250);
ldt := CONCAT_DATE_LTOD(d, lt);
ok := SPLIT_DATE(IN := d, YEAR => y, MONTH => mo, DAY => dd);
ok := SPLIT_DATE(IN := old, YEAR => oy, MONTH => omo, DAY => odd);
ok := SPLIT_LDT(IN := ldt, YEAR => ty, MONTH => tmo, DAY => tdd, HOUR => th, MINUTE => tmi, SECOND => ts, MILLISECOND => tms);
sun := DAY_OF_WEEK(D#2024-01-14);
wed := DAY_OF_WEEK(old);
END_PROGRAM
`;

const MAIN = `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.D.get() << " " << p.OLD.get() << " " << p.T.get() << " " << p.LT.get()
              << " " << p.DT.get() << " " << p.LDT.get() << " "
              << p.Y.get() << "-" << int(p.MO.get()) << "-" << int(p.DD.get()) << " "
              << p.OY.get() << "-" << int(p.OMO.get()) << "-" << int(p.ODD.get()) << " "
              << p.TY.get() << "-" << int(p.TMO.get()) << "-" << int(p.TDD.get()) << "T"
              << int(p.TH.get()) << ":" << int(p.TMI.get()) << ":" << int(p.TS.get()) << "."
              << p.TMS.get() << " " << p.SUN.get() << " " << p.WED.get() << std::endl;
    return 0;
}
`;

describe.skipIf(!hasGpp || !libsAvailable)(
  "Table 36 date and time functions — g++ e2e",
  () => {
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-t36-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    const run = (libs: string, options: object): string => {
      const all = discoverStlibs(LIBS_DIR);
      const libraries =
        libs === "oscat"
          ? all
          : all.filter((a) => a.manifest.name !== "oscat-basic");
      const result = compile(SOURCE, {
        ...options,
        headerFileName: "generated.hpp",
        libraries,
      });
      expect(result.errors).toEqual([]);
      return compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: `t36_${libs}_${JSON.stringify(options).replace(/\W/g, "_")}`,
        mainCode: MAIN,
      });
    };

    const values = (sun: number, wed: number): string =>
      [
        "19782",
        "-1",
        "45015250000000",
        "45015250000000",
        "1709209815250000000",
        "1709209815250000000",
        "2024-2-29",
        "1969-12-31",
        "2024-2-29T12:30:15.250",
        String(sun),
        String(wed),
      ].join(" ");

    for (const options of [{}, { dialect: "iec-3" }, { strict: true }]) {
      it(`computes the IEC values (${JSON.stringify(options)})`, () => {
        expect(run("none", options)).toBe(values(0, 3));
      });
    }

    it("runs OSCAT's DAY_OF_WEEK when OSCAT is loaded", () => {
      // OSCAT counts Monday 1 to Sunday 7, and reads a pre-1970 date through a
      // DWORD, so 1969-12-31 comes out 6: its own results, unchanged.
      expect(run("oscat", {})).toBe(values(7, 6));
    });
  },
);
