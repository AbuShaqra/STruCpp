// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: LDATE, LTOD and LDT literals, arithmetic, mixing with the short forms
 * and conversions build and run under g++, and their leaves reach the
 * debugger with the DATE, TOD and DT tags.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `PROGRAM Main
VAR
  ld : LDATE := LDATE#2024-01-15;
  ld2 : LDATE := LD#2024-01-20;
  lt : LTOD := LTOD#12:30:15.5;
  lt2 : LTOD := LTIME_OF_DAY#1:2:3;
  ldt : LDT := LDT#2024-01-15-12:30:00;
  ldt2 : LDT := LDATE_AND_TIME#2024-01-16-00:00:00;
  dt1 : DT := DT#2024-01-15-12:00:00;
  dd : LTIME; dl : LTIME; dt : LTIME; moved : LDT; next : LDATE;
  day : LDATE; tod : LTOD; joined : LDT; fromdt : LDT; x : BOOL; n : LINT;
END_VAR
dd := ld2 - ld;
dl := lt - lt2;
dt := ldt2 - ldt;
moved := ldt + LT#1h + T#30m;
next := ld + LT#1d;
day := LDT_TO_LDATE(ldt);
tod := LDT_TO_LTOD(ldt);
joined := LDATE_TO_LDT(ld);
fromdt := dt1;
x := ldt > dt1;
n := LDATE_TO_LINT(ld);
END_PROGRAM
`;

describe.skipIf(!hasGpp)("LDATE, LTOD and LDT — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-ldates-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const [label, options] of [
    ["no dialect", {}],
    ["iec-3", { dialect: "iec-3" }],
    ["strict", { strict: true }],
  ] as const) {
    it(`builds and runs (${label})`, () => {
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
        testName: `ldates_${label.replace(/\W/g, "_")}`,
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.DD.get() << " " << p.DL.get() << " " << p.DT.get() << " "
              << p.MOVED.get() << " " << p.NEXT.get() << " " << p.DAY.get() << " "
              << p.TOD.get() << " " << p.JOINED.get() << " " << p.FROMDT.get() << " "
              << p.X.get() << " " << p.N.get() << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe(
        [
          "432000000000000",
          "41292500000000",
          "41400000000000",
          "1705327200000000000",
          "19738",
          "19737",
          "45000000000000",
          "1705276800000000000",
          "1705320000000000000",
          "1",
          "1705276800000000000",
        ].join(" "),
      );
    });
  }

  it("describes the leaves to the debugger by their short tags", () => {
    const result = compile(
      `${SOURCE}
CONFIGURATION C
RESOURCE R ON PLC
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM inst WITH T : Main;
END_RESOURCE
END_CONFIGURATION`,
      { headerFileName: "generated.hpp" },
    );
    expect(result.errors).toEqual([]);
    const type = (p: string): string | undefined =>
      result.debugMap!.leaves.find((l) => l.path === p)?.type;
    expect([type("INST.LD"), type("INST.LT"), type("INST.LDT")]).toEqual([
      "DATE",
      "TOD",
      "DT",
    ]);
  });
});
