// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * TIME, DATE, TOD and DT are 4 bytes, as on the PLC: TIME and TOD in ms,
 * DATE and DT in seconds since 1970, unsigned and wrapping modulo 2^32.
 * LTIME, LDATE, LTOD and LDT keep 8 bytes. TON stays right across the wrap
 * of TIME(), and LTON runs on the 64-bit LTIME() clock.
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

const VALUES = `TYPE S_T : STRUCT b : BYTE; t : TIME; END_STRUCT; END_TYPE
PROGRAM MAIN
VAR
  szT, szD, szTod, szDt, szLt, szS : DINT;
  t : TIME := T#1s; t2 : TIME; lt : LTIME; d : DATE := D#2024-03-05;
  tod : TOD := TOD#23:00:00; dt1 : DT := DT#2024-03-05-12:00:00; dt2 : DT;
  u1, u2, u3, u4, u5, u6, u7, u8, u9, u10, u11 : UDINT;
  s1, s2, s3 : STRING;
END_VAR
szT := SIZEOF(t); szD := SIZEOF(d); szTod := SIZEOF(tod); szDt := SIZEOF(dt1);
szLt := SIZEOF(lt); szS := SIZEOF(S_T);
t2 := t - T#2s;
u1 := TIME_TO_UDINT(t2);
u2 := TIME_TO_UDINT(T#40d * 2);
lt := TIME_TO_LTIME(T#49d17h2m47s295ms);
u3 := TIME_TO_UDINT(LTIME_TO_TIME(LTIME#1ms999us));
u4 := TIME_TO_UDINT(LTIME_TO_TIME(lt + LTIME#1ms));
u5 := DT_TO_UDINT(dt1);
u6 := DATE_TO_UDINT(d);
u7 := TOD_TO_UDINT(tod + T#2h);
u8 := TIME_TO_UDINT(dt1 - DT#2024-03-05-11:59:00);
dt2 := dt1 + T#1m500ms;
u9 := DT_TO_UDINT(dt2);
u10 := TIME_TO_UDINT(STRING_TO_TIME('T#-1s'));
u11 := TIME_TO_UDINT(STRING_TO_TIME('T#1ms999us'));
s1 := TIME_TO_STRING(t2);
s2 := DT_TO_STRING(dt1);
s3 := TOD_TO_STRING(TOD#12:34:56.789);
END_PROGRAM
`;

const TIMERS = `PROGRAM MAIN
VAR
  ton1 : TON; lton1 : LTON;
  q1, q2, q3 : BOOL; et1 : TIME; lq1, lq2 : BOOL;
END_VAR
END_PROGRAM
`;

describe.skipIf(!hasGpp || !libsAvailable)("32-bit TIME, DATE, TOD and DT", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-time32-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("sizes, wraps and converts as on the PLC", () => {
    const r = compile(VALUES, {
      headerFileName: "generated.hpp",
      libraries: discoverStlibs(LIBS_DIR),
    });
    expect(r.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: r.headerCode,
      cppCode: r.cppCode,
      testName: "time32_values",
      mainCode: `#include <iostream>
int main() {
  using namespace strucpp;
  static Program_MAIN p; p.run();
  std::cout << p.SZT.get() << " " << p.SZD.get() << " " << p.SZTOD.get() << " "
            << p.SZDT.get() << " " << p.SZLT.get() << " " << p.SZS.get() << "\\n";
  std::cout << p.U1.get() << " " << p.U2.get() << " " << p.U3.get() << " "
            << p.U4.get() << " " << p.U5.get() << " " << p.U6.get() << " "
            << p.U7.get() << " " << p.U8.get() << " " << p.U9.get() << " "
            << p.U10.get() << " " << p.U11.get() << "\\n";
  std::cout << p.S1.get().c_str() << " " << p.S2.get().c_str() << " "
            << p.S3.get().c_str() << "\\n";
  return 0;
}
`,
    });
    expect(out.trim().split("\n")).toEqual([
      "4 4 4 4 8 8",
      // 1 s - 2 s wraps; 80 d wraps; LTIME#1ms999us truncates to 1 ms;
      // T#49d17h2m47s296ms wraps to 0; DT and DATE in seconds; 23:00 + 2 h
      // wraps modulo 2^32 ms, not 24 h; DT - DT in ms; DT + 1m500ms whole
      // seconds; the text 'T#-1s' wraps and 'T#1ms999us' truncates.
      "4294966296 2617032704 1 0 1709640000 1709596800 90000000 60000 1709640060 4294966296 1",
      "T#49d17h2m46s296ms DT#2024-03-05-12:00:00 TOD#12:34:56.789",
    ]);
  });

  it("keeps TON right across the wrap of TIME() and runs LTON past it", () => {
    const r = compile(TIMERS, {
      headerFileName: "generated.hpp",
      libraries: discoverStlibs(LIBS_DIR),
    });
    expect(r.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: r.headerCode,
      cppCode: r.cppCode,
      testName: "time32_timers",
      mainCode: `#include <iostream>
int main() {
  using namespace strucpp;
  static Program_MAIN p;
  const int64_t ms = 1000000LL;
  // 50 ms before TIME() wraps
  __CURRENT_TIME_NS = (4294967296LL - 50) * ms;
  p.TON1.IN = true; p.TON1.PT = TIME_t(100u); p.TON1();
  __CURRENT_TIME_NS += 60 * ms;  // TIME() is now 10 ms
  p.TON1.IN = true; p.TON1.PT = TIME_t(100u); p.TON1();
  std::cout << p.TON1.Q.get() << " " << p.TON1.ET.get().raw << " ";
  __CURRENT_TIME_NS += 40 * ms;
  p.TON1.IN = true; p.TON1.PT = TIME_t(100u); p.TON1();
  std::cout << p.TON1.Q.get() << "\\n";
  // LTON with a preset longer than TIME() can count
  __CURRENT_TIME_NS = 0;
  p.LTON1.IN = true; p.LTON1.PT = 60LL * 86400000000000LL; p.LTON1();
  __CURRENT_TIME_NS = 59LL * 86400000000000LL;
  p.LTON1.IN = true; p.LTON1.PT = 60LL * 86400000000000LL; p.LTON1();
  std::cout << p.LTON1.Q.get() << " ";
  __CURRENT_TIME_NS = 60LL * 86400000000000LL;
  p.LTON1.IN = true; p.LTON1.PT = 60LL * 86400000000000LL; p.LTON1();
  std::cout << p.LTON1.Q.get() << "\\n";
  return 0;
}
`,
    });
    expect(out.trim().split("\n")).toEqual(["0 60 1", "0 1"]);
  });
});
