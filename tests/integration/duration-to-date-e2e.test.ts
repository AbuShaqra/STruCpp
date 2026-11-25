// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: a duration converted to a date or date-and-time is the time since
 * 1970-01-01 (a date by whole days), and back: TIME_TO_DATE(T#2d3s) is
 * 1970-01-03, LTIME_TO_LDATE gives 2 days, DATE_TO_TIME(D#1970-01-03) is
 * T#2d. Every form and width agrees.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `
PROGRAM Main
VAR
  t : TIME := T#2d3s; lt : LTIME := LTIME#2d3s;
  d : ARRAY[1..4] OF DATE; ld : ARRAY[1..4] OF LDATE;
  dt : ARRAY[1..3] OF DT; ldt : ARRAY[1..2] OF LDT;
  tm : ARRAY[1..4] OF TIME; ltm : ARRAY[1..3] OF LTIME;
END_VAR
d[1] := TIME_TO_DATE(T#2d3s);
d[2] := TIME_TO_DATE(t);
d[3] := LTIME_TO_DATE(lt);
d[4] := TO_DATE(t);
ld[1] := LTIME_TO_LDATE(LTIME#2d3s);
ld[2] := LTIME_TO_LDATE(lt);
ld[3] := TIME_TO_LDATE(t);
ld[4] := TO_LDATE(lt);
dt[1] := TIME_TO_DT(t);
dt[2] := LTIME_TO_DT(lt);
dt[3] := TO_DT(T#1h);
ldt[1] := LTIME_TO_LDT(lt);
ldt[2] := TIME_TO_LDT(t);
tm[1] := DATE_TO_TIME(D#1970-01-03);
tm[2] := DT_TO_TIME(DT#1970-01-01-01:00:00);
tm[3] := LDATE_TO_TIME(LDATE#1970-01-03);
tm[4] := LDT_TO_TIME(LDT#1970-01-01-00:00:01.5);
ltm[1] := DATE_TO_LTIME(D#1970-01-03);
ltm[2] := LDATE_TO_LTIME(LDATE#1970-01-03);
ltm[3] := DT_TO_LTIME(DT#1970-01-01-01:00:00);
END_PROGRAM
`;

const MAIN = `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    for (int i = 1; i <= 4; ++i) std::cout << p.D[i].get().raw << " ";
    std::cout << "|";
    for (int i = 1; i <= 4; ++i) std::cout << p.LD[i].get() << " ";
    std::cout << "|";
    for (int i = 1; i <= 3; ++i) std::cout << p.DT[i].get().raw << " ";
    std::cout << "|";
    for (int i = 1; i <= 2; ++i) std::cout << p.LDT[i].get() << " ";
    std::cout << "|";
    for (int i = 1; i <= 4; ++i) std::cout << p.TM[i].get().raw << " ";
    std::cout << "|";
    for (int i = 1; i <= 3; ++i) std::cout << p.LTM[i].get() << " ";
    std::cout << std::endl;
    return 0;
}
`;

describe.skipIf(!hasGpp)("duration to and from a date — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-durdate-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("converts as the time since 1970-01-01", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "duration_to_date",
      mainCode: MAIN,
    });
    const ns = (s: number): string => String(BigInt(s * 1000) * 1000000n);
    expect(out.split("|").map((p) => p.trim())).toEqual([
      // DATE in seconds: 1970-01-03
      "172800 172800 172800 172800",
      // LDATE in days
      "2 2 2 2",
      // DT in seconds
      "172803 172803 3600",
      // LDT in ns
      `${ns(172803)} ${ns(172803)}`,
      // TIME in ms
      "172800000 3600000 172800000 1500",
      // LTIME in ns
      `${ns(172800)} ${ns(172800)} ${ns(3600)}`,
    ]);
  });
});
