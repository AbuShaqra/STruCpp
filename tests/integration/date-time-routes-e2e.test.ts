// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: date and time arithmetic and conversions run under g++ with the
 * values the PLC gives. A DATE or DT before 1970 wraps modulo 2^32 seconds
 * and every route to the same day or second gives the same value (literal
 * arithmetic, CONCAT_*, STRING_TO_*, an LDATE or LDT and an integer
 * conversion); a wrapped DATE moves by whole days. LDATE and LDT keep dates
 * before 1970 (signed 64-bit).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const LIBS_DIR = path.resolve(__dirname, "../../libs");
const libsAvailable = fs.existsSync(
  path.join(LIBS_DIR, "iec-standard-fb.stlib"),
);

const SOURCE = `PROGRAM Main
VAR
  d : ARRAY[1..12] OF DATE; dt : ARRAY[1..8] OF DT; r : ARRAY[1..24] OF LINT;
  tm : ARRAY[1..6] OF TIME; tod : TOD;
  oneDay : TIME := T#1d; s : STRING := '1969-12-31'; ld : LDATE; ld2 : LDATE;
  ldt : LDT; lt : LTIME; ok : BOOL;
  y : UINT; mo : USINT; dd : USINT; h : USINT; mi : USINT; se : USINT; ms : UINT;
END_VAR
(* 1969-12-31 as a DATE, by every route *)
d[1] := CONCAT_DATE(1969, 12, 31);
d[2] := D#1970-01-01 - T#1d;
d[3] := D#1970-01-01 - oneDay;
d[4] := STRING_TO_DATE('1969-12-31');
d[5] := STRING_TO_DATE(s);
d[6] := LDATE_TO_DATE(LDATE#1969-12-31);
d[7] := LINT_TO_DATE(-86400);
(* 1969-12-30, and back to 1970 *)
d[8] := CONCAT_DATE(1969, 12, 30);
d[9] := D#1970-01-01 - T#2d;
d[10] := d[2] - T#1d;
d[11] := d[9] + T#2d;
d[12] := d[2] + T#36h;
(* 1969-12-31-23:59:58 as a DT, by every route *)
dt[1] := CONCAT_DT(1969, 12, 31, 23, 59, 58, 0);
dt[2] := DT#1970-01-01-00:00:00 - T#2s;
dt[3] := STRING_TO_DT('DT#1969-12-31-23:59:58');
dt[4] := LDT_TO_DT(LDT#1969-12-31-23:59:58);
dt[5] := LINT_TO_DT(-2);
dt[6] := CONCAT_DATE_TOD(CONCAT_DATE(1969, 12, 31), TOD#23:59:58);
dt[7] := dt[2] + T#2s;
dt[8] := DT#2024-02-29-12:00:00 + T#1d12h;
(* Table 30 arithmetic of the 32-bit types *)
tm[1] := DT#2024-03-01-00:00:00 - DT#2024-02-28-12:00:00;
tm[2] := TOD#12:00:00 - TOD#11:59:59.250;
tm[3] := D#2024-03-01 - D#2024-02-28;
tm[4] := T#1s * 3 + T#500ms;
tm[5] := T#10s / 4;
tm[6] := T#1h - T#1m;
tod := TOD#23:00:00 + T#30m;
(* LDATE and LDT before 1970 *)
ld := LDATE#1969-12-31;
r[1] := LDATE_TO_LINT(ld);
ld2 := ld + LTIME#1d;
r[2] := LDATE_TO_LINT(ld2);
ld2 := LDATE#1900-03-01;
r[3] := LDATE_TO_LINT(ld2);
lt := LDATE#1969-12-31 - LDATE#1970-01-01;
r[4] := LTIME_TO_LINT(lt);
ldt := LDT#1969-12-31-23:59:59.5;
r[5] := LDT_TO_LINT(ldt);
lt := ldt - LDT#1970-01-01-00:00:00;
r[6] := LTIME_TO_LINT(lt);
ld2 := LDT_TO_LDATE(ldt);
r[7] := LDATE_TO_LINT(ld2);
r[8] := LTOD_TO_LINT(LDT_TO_LTOD(ldt));
r[9] := LDT_TO_LINT(CONCAT_LDT(1900, 3, 1, 12, 30, 15, 250));
ok := SPLIT_LDT(IN := LDT#1900-03-01-12:30:15.250, YEAR => y, MONTH => mo, DAY => dd, HOUR => h, MINUTE => mi, SECOND => se, MILLISECOND => ms);
r[10] := UINT_TO_LINT(y) * 10000 + USINT_TO_LINT(mo) * 100 + USINT_TO_LINT(dd);
r[11] := USINT_TO_LINT(h) * 10000000 + USINT_TO_LINT(mi) * 100000 + USINT_TO_LINT(se) * 1000 + UINT_TO_LINT(ms);
ld2 := LDATE#1969-12-31 - T#36h;
r[12] := LDATE_TO_LINT(ld2);
r[13] := LDT_TO_LINT(LDT#1970-01-01-00:00:00 - LTIME#1d);
r[14] := LDT_TO_LINT(DATE_TO_LDT(D#1970-01-01) - LTIME#1s);
END_PROGRAM
`;

const MAIN = `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    for (int i = 1; i <= 12; ++i) std::cout << p.D[i].get().raw << " ";
    std::cout << "|";
    for (int i = 1; i <= 8; ++i) std::cout << p.DT[i].get().raw << " ";
    std::cout << "|";
    for (int i = 1; i <= 6; ++i) std::cout << p.TM[i].get().raw << " ";
    std::cout << p.TOD.get().raw << "|";
    for (int i = 1; i <= 14; ++i) std::cout << p.R[i].get() << " ";
    std::cout << std::endl;
    return 0;
}
`;

const NS_PER_DAY = 86400000000000n;

describe.skipIf(!hasGpp || !libsAvailable)(
  "date and time routes and arithmetic — g++ e2e",
  () => {
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-dt-routes-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    for (const options of [{}, { dialect: "iec-3" }, { strict: true }]) {
      it(`gives the PLC's values on every route (${JSON.stringify(options)})`, () => {
        const result = compile(SOURCE, {
          ...options,
          headerFileName: "generated.hpp",
          libraries: discoverStlibs(LIBS_DIR).filter(
            (a) => a.manifest.name !== "oscat-basic",
          ),
        });
        expect(result.errors).toEqual([]);
        const out = compileAndRunStandalone({
          tempDir,
          pchPath,
          headerCode: result.headerCode,
          cppCode: result.cppCode,
          testName: `dt_routes_${JSON.stringify(options).replace(/\W/g, "_")}`,
          mainCode: MAIN,
        });
        const [dates, dts, times, longs] = out
          .split("|")
          .map((part) => part.trim().split(" "));
        // -86400 s and -172800 s modulo 2^32; back to 1970 by + T#2d; a
        // wrapped day + T#36h is the next day (1970-01-01)
        const dayM1 = String(2 ** 32 - 86400);
        const dayM2 = String(2 ** 32 - 2 * 86400);
        expect(dates).toEqual([
          ...Array<string>(7).fill(dayM1),
          dayM2,
          dayM2,
          dayM2,
          "0",
          "0",
        ]);
        // -2 s modulo 2^32 on every route, back to 0 by + T#2s; then
        // 2024-03-02-00:00:00 (leap day + 1.5 d)
        expect(dts).toEqual([
          ...Array<string>(6).fill(String(2 ** 32 - 2)),
          "0",
          "1709337600",
        ]);
        // TIME and TOD in ms
        expect(times).toEqual([
          String(36 * 3600 * 1000),
          "750",
          String(2 * 86400 * 1000),
          "3500",
          "2500",
          "3540000",
          String(23.5 * 3600 * 1000),
        ]);
        // LDATE, LDT, LTOD and LTIME in ns, signed
        expect(longs).toEqual([
          String(-NS_PER_DAY),
          "0",
          String(-25508n * NS_PER_DAY),
          String(-NS_PER_DAY),
          "-500000000",
          "-500000000",
          String(-NS_PER_DAY),
          String(NS_PER_DAY - 500000000n),
          String(-25508n * NS_PER_DAY + 45015250000000n),
          "19000301",
          "123015250",
          String(-3n * NS_PER_DAY),
          String(-NS_PER_DAY),
          "-1000000000",
        ]);
      });
    }
  },
);
