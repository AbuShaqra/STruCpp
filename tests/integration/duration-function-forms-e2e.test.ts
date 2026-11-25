// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: date and time forms that were refused or computed the wrong value:
 * - MUL / DIV of a TIME or LTIME by a number (IEC 61131-3 Table 35, rows 10a
 *   and 11a) build as `*` / `/`, a zero divisor faulting as `/` does;
 * - a number + an LTIME, LDATE (in days), LTOD or LDT is of the temporal type, as the
 *   temporal + the number is;
 * - a time of day and a duration convert as the time since midnight when one
 *   side is a long form (TOD_TO_LTIME(TOD#00:00:02) is 2 s in ns, not 2000).
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
  t : TIME := T#10ms; lt : LTIME := LTIME#10ms; n : INT := 4; r : REAL := 2.5;
  q : ARRAY[1..2] OF TIME; lq : ARRAY[1..3] OF LTIME;
  ldt : LDT := LDT#1970-01-01-00:00:00; ld : LDATE := LDATE#1970-01-01; lto : LTOD := LTOD#00:00:01;
  sums : ARRAY[1..5] OF LINT;
  tod1 : TOD := TOD#00:00:02.5; ltod1 : LTOD := LTOD#00:00:03.25;
  a : LTIME; b : TIME; c : TOD; d : LTOD; e : LTIME;
END_VAR
q[1] := DIV(t, 2);
q[2] := MUL(IN1 := t, IN2 := r);
lq[1] := DIV(lt, n);
lq[2] := MUL(lt, 3);
lq[3] := DIV(lt, n + 1);
sums[1] := LDT_TO_LINT(1 + ldt);
sums[2] := LDT_TO_LINT(ldt + 1);
sums[3] := LTIME_TO_LINT(2 + lt);
sums[4] := LDATE_TO_LINT(n + ld);
sums[5] := LTOD_TO_LINT(5 + lto);
a := TOD_TO_LTIME(tod1);
b := LTOD_TO_TIME(ltod1);
c := LTIME_TO_TOD(LTIME#4s);
d := TIME_TO_LTOD(T#5s);
e := TOD_TO_LTIME(TOD#00:00:02);
END_PROGRAM
`;

const MAIN = `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    for (int i = 1; i <= 2; ++i) std::cout << p.Q[i].get().raw << " ";
    std::cout << "|";
    for (int i = 1; i <= 3; ++i) std::cout << p.LQ[i].get() << " ";
    std::cout << "|";
    for (int i = 1; i <= 5; ++i) std::cout << p.SUMS[i].get() << " ";
    std::cout << "|" << p.A.get() << " " << p.B.get().raw << " " << strucpp::TOD_TO_MS(p.C)
              << " " << p.D.get() << " " << p.E.get();
    std::cout << std::endl;
    return 0;
}
`;

const ZERO = `
PROGRAM Main
VAR lt : LTIME := LTIME#10ms; z : INT := 0; lq : LTIME; END_VAR
lq := DIV(lt, z);
END_PROGRAM
`;

const REAL_FORMS = `
PROGRAM Main
VAR lt : LTIME := LTIME#10ms; r : LREAL := 3.0; lq : ARRAY[1..5] OF LTIME; END_VAR
lq[1] := MUL(lt, -1.5);
lq[2] := r * lt;
lq[3] := lt / 2.5;
lq[4] := lt * 1.0E12;
lq[5] := MUL(lt, 1.0E30);
END_PROGRAM
`;

const REAL_FORMS_MAIN = `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    for (int i = 1; i <= 5; ++i) std::cout << p.LQ[i].get() << " ";
    std::cout << std::endl;
    return 0;
}
`;

/** An LTIME divided by a REAL zero, through the function or the operator. */
const realZero = (stmt: string): string => `
PROGRAM Main
VAR lt : LTIME := LTIME#10ms; rz : REAL := 0.0; lq : LTIME; END_VAR
${stmt}
END_PROGRAM
`;

const ZERO_MAIN = `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    try { p.run(); } catch (const std::exception& e) { std::cout << e.what(); return 0; }
    std::cout << "no fault";
    return 0;
}
`;

describe.skipIf(!hasGpp)(
  "duration functions and long temporal forms — g++ e2e",
  () => {
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-durfn-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    it("computes each form in its type's unit", () => {
      const result = compile(SOURCE, { headerFileName: "generated.hpp" });
      expect(result.errors).toEqual([]);
      const out = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: "duration_function_forms",
        mainCode: MAIN,
      });
      expect(out.split("|").map((p) => p.trim())).toEqual([
        "5 25",
        "2500000 30000000 2000000",
        "1 1 10000002 345600000000000 1000000005",
        "2500000000 3250 4000 5000000000 2000000000",
      ]);
    });

    it("computes an LTIME by a REAL in double, truncated and wrapped as a TIME is", () => {
      const result = compile(REAL_FORMS, { headerFileName: "generated.hpp" });
      expect(result.errors).toEqual([]);
      const out = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: "ltime_real_forms",
        mainCode: REAL_FORMS_MAIN,
      });
      // 1E19 ns wraps modulo 2^64; 1E37 is a multiple of 2^64
      expect(out).toBe("-15000000 30000000 4000000 -8446744073709551616 0");
    });

    it("faults on an LTIME divided by a REAL zero", () => {
      for (const stmt of [
        "lq := DIV(lt, rz);",
        "lq := lt / rz;",
        "lq := lt / 0.0;",
      ]) {
        const result = compile(realZero(stmt), {
          headerFileName: "generated.hpp",
        });
        expect(result.errors).toEqual([]);
        const out = compileAndRunStandalone({
          tempDir,
          pchPath,
          headerCode: result.headerCode,
          cppCode: result.cppCode,
          testName: "ltime_real_zero",
          mainCode: ZERO_MAIN,
        });
        expect(out).toContain("Division by zero");
      }
    });

    it("faults on DIV of an LTIME by zero, as `/` does", () => {
      const result = compile(ZERO, { headerFileName: "generated.hpp" });
      expect(result.errors).toEqual([]);
      const out = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: "duration_div_zero",
        mainCode: ZERO_MAIN,
      });
      expect(out).toContain("Division by zero");
    });
  },
);
