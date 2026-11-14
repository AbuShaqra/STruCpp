// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: integer division by zero is a run-time fault naming the POU, the line
 * and the running task; the minimum value / -1 wraps; REAL division is plain.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `FUNCTION_BLOCK FB
VAR_INPUT z : INT; END_VAR
VAR_OUTPUT o : INT; END_VAR
o := 7 / z;
END_FUNCTION_BLOCK
PROGRAM Main
VAR a : INT := 7; q : INT; mn : DINT := DINT#-2147483648; m1 : DINT := -1; dq : DINT; f : FB; END_VAR
q := a / 2;
dq := mn / m1;
f(z := 0);
END_PROGRAM
`;

describe.skipIf(!hasGpp)("integer division by zero — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-divzero-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const [label, options] of [
    ["no dialect", {}],
    ["iec-3", { dialect: "iec-3" }],
    ["strict", { strict: true }],
  ] as const) {
    it(`raises a fault naming the POU, line and task (${label})`, () => {
      const result = compile(SOURCE, {
        ...options,
        headerFileName: "generated.hpp",
      });
      expect(result.errors).toEqual([]);
      expect(result.cppCode).toContain(
        'iec_div(7, Z, strucpp::iec_site{"FB", 4})',
      );
      const stdout = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: `divzero_${label.replace(/\W/g, "_")}`,
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    strucpp::strucpp_set_current_task("FAST");
    try { p.run(); } catch (const std::exception& e) { std::cout << e.what() << "|"; }
    std::cout << p.Q.get() << " " << p.DQ.get() << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe(
        "Division by zero in FB, line 4, task FAST|3 -2147483648",
      );
    });
  }

  const SITES = `FUNCTION_BLOCK FBX
VAR_INPUT z : DINT; END_VAR
VAR_OUTPUT o : DINT; END_VAR
METHOD M : DINT
M := 10 / z;
END_METHOD
ACTION Act:
o := 7 / z;
END_ACTION
END_FUNCTION_BLOCK
PROGRAM Main
VAR a : DINT := 7; z : DINT; r : DINT; w : WORD := 7; wz : WORD; wr : WORD; f : FBX; k : INT; END_VAR
CASE k OF
1: r := DIV(a, z);
2: wr := w / wz;
3: r := f.M();
4: f.Act();
5: r := DIV(IN1 := a, IN2 := z);
6: r := a MOD z;
END_CASE;
END_PROGRAM
PROGRAM PInit
VAR z : DINT := 0; r : DINT := 5 / z; END_VAR
r := r + 1;
END_PROGRAM
`;

  it("faults on DIV() and a bit string `/`, naming FB.M, FB.ACT and the POU of an initial value", () => {
    const result = compile(SITES, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "divzero_sites",
      mainCode: `
#include <iostream>
int main() {
    strucpp::strucpp_set_current_task("T1");
    for (int k = 1; k <= 6; ++k) {
        try { static strucpp::Program_MAIN p; p.K = k; p.run(); std::cout << k << " nofault " << p.R.get() << "|"; }
        catch (const std::exception& e) { std::cout << k << " " << e.what() << "|"; }
    }
    try { strucpp::Program_PINIT q; std::cout << "init nofault"; }
    catch (const std::exception& e) { std::cout << "init " << e.what(); }
    std::cout << std::endl;
    return 0;
}
`,
    });
    expect(stdout.split("|")).toEqual([
      "1 Division by zero in MAIN, line 14, task T1",
      "2 Division by zero in MAIN, line 15, task T1",
      "3 Division by zero in FBX.M, line 5, task T1",
      "4 Division by zero in FBX.ACT, line 8, task T1",
      "5 Division by zero in MAIN, line 18, task T1",
      // MOD by 0 gives 0 (Table 29, note e), no fault
      "6 nofault 0",
      "init Division by zero in PINIT, line 23, task T1",
    ]);
  });

  it("builds without exceptions and passes the site to iec_runtime_fault", () => {
    const result = compile(SITES, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "divzero_no_exceptions",
      extraFlags: ["-fno-exceptions"],
      mainCode: `
#include <cstdio>
#include <cstdlib>
namespace strucpp {
[[noreturn]] void iec_runtime_fault(IecFault reason, const char* context) noexcept {
    std::printf("fault %d %s\\n", static_cast<int>(reason), context != nullptr ? context : "");
    std::exit(0);
}
}
int main() {
    strucpp::strucpp_set_current_task("FAST");
    static strucpp::Program_MAIN p;
    p.K = 3;
    p.run();
    std::printf("nofault\\n");
    return 0;
}
`,
    });
    expect(stdout).toBe("fault 3 Division by zero in FBX.M, line 5, task FAST");
  });
});
