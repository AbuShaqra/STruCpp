// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: a TIME, DATE, TOD or DT divided by 0 (`/` by a number or a TIME,
 * DIV_TIME, DIVTIME; an integer or a REAL divisor) is a run-time fault naming
 * the POU, line and task, as an integer division by zero is.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `PROGRAM Main
VAR t : TIME := T#10s; tod : TOD := TOD#10:00:00; dt : DT := DT#2000-01-01-00:00:00;
  d : DATE := D#2000-01-01; z : DINT; rz : REAL; k : INT; r : TIME; rt : TOD; rd : DT; rdd : DATE;
  two : DINT := 4; zt : TIME; lt : LTIME := LTIME#1s; lz : LTIME; n : LINT; END_VAR
CASE k OF
1: r := t / z;
2: r := DIV_TIME(t, z);
3: r := t / rz;
4: rt := tod / z;
5: rd := dt / z;
6: rdd := d / z;
7: r := t / two;
8: n := DIVTIME(t, zt);
9: n := DIVTIME(lt, lz);
10: r := t / zt;
END_CASE;
END_PROGRAM
`;

describe.skipIf(!hasGpp)("TIME division by zero — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-timediv0-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const [label, options] of [
    ["no dialect", {}],
    ["iec-3", { dialect: "iec-3" }],
  ] as const) {
    it(`faults naming the POU, line and task (${label})`, () => {
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
        testName: `timediv0_${label.replace(/\W/g, "_")}`,
        mainCode: `
#include <iostream>
int main() {
    strucpp::strucpp_set_current_task("T1");
    static strucpp::Program_MAIN p;
    for (int k = 1; k <= 10; ++k) {
        try { p.K = k; p.run(); std::cout << k << " nofault " << p.R.get().raw << "|"; }
        catch (const std::exception& e) { std::cout << k << " " << e.what() << "|"; }
    }
    std::cout << std::endl;
    return 0;
}
`,
      });
      expect(stdout.split("|").filter((s) => s !== "")).toEqual([
        "1 Division by zero in MAIN, line 6, task T1",
        "2 Division by zero in MAIN, line 7, task T1",
        "3 Division by zero in MAIN, line 8, task T1",
        "4 Division by zero in MAIN, line 9, task T1",
        "5 Division by zero in MAIN, line 10, task T1",
        "6 Division by zero in MAIN, line 11, task T1",
        "7 nofault 2500",
        "8 Division by zero in MAIN, line 13, task T1",
        "9 Division by zero in MAIN, line 14, task T1",
        "10 Division by zero in MAIN, line 15, task T1",
      ]);
    });
  }
});
