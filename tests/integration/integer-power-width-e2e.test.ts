// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: an integer `**` is an exact integer power only where it is stored in
 * an integer; elsewhere it is a real power, whatever its size, so
 * `lr : LREAL := 2 ** 40 / 3` divides as reals as `2 ** 20 / 3` does. Into an
 * integer, the + - * around a power computed wider than its own type are
 * computed in that width too (`l : LINT := d ** 30 * 4 + 1`).
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
  lr1 : LREAL := 2 ** 40 / 3; lr2 : LREAL := 2 ** 20 / 3;
  d : DINT := 2;
  l1 : LINT := d ** 30 * 4 + 1;
  l2 : LINT := 2 ** 40 / 3;
  r : ARRAY[1..4] OF LREAL; n : ARRAY[1..6] OF LINT;
END_VAR
r[1] := 2 ** 40 / 3;
r[2] := 2 ** 20 / 3;
r[3] := 2 ** 40 + 1;
r[4] := (2 ** 40) * 3 / 2;
n[1] := d ** 30 * 4 + 1;
n[2] := d ** 31 + 1;
n[3] := -(d ** 40);
n[4] := (d ** 20 - 1) * (d ** 20);
n[5] := 2 ** 40 / 3;
n[6] := d * 1000000 * 10000;
END_PROGRAM
`;

const MAIN = `
#include <cstdio>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::printf("%.3f %.3f %lld %lld|", p.LR1.get(), p.LR2.get(),
                (long long)p.L1.get(), (long long)p.L2.get());
    for (int i = 1; i <= 4; ++i) std::printf("%.3f ", p.R[i].get());
    std::printf("|");
    for (int i = 1; i <= 6; ++i) std::printf("%lld ", (long long)p.N[i].get());
    std::printf("\\n");
    return 0;
}
`;

describe("integer power width — codegen", () => {
  it("folds a power only where it is stored as an integer", () => {
    const result = compile(SOURCE);
    expect(result.errors).toEqual([]);
    const pow40 = "std::pow(static_cast<double>(2), static_cast<double>(40))";
    expect(result.cppCode).toContain(`1) = ${pow40} / 3;`);
    expect(result.cppCode).toContain(`3) = ${pow40} + 1;`);
    expect(result.cppCode).toContain("5) = 366503875925;");
    expect(result.cppCode).toContain(
      "1) = strucpp::iec_add<LINT_t>({strucpp::iec_mul<LINT_t>({strucpp::iec_expt<LINT_t>(D, 30), 4}), 1});",
    );
    // Without a power, DINT arithmetic still wraps at DINT
    expect(result.cppCode).toContain(
      "6) = strucpp::iec_mul<DINT_t>({strucpp::iec_mul<DINT_t>({D, 1000000}), 10000});",
    );
  });
});

describe.skipIf(!hasGpp)("integer power width — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-powwidth-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("gives real powers into reals and wide integer arithmetic into LINT", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "integer_power_width",
      mainCode: MAIN,
    });
    const p40 = 2 ** 40;
    const p20 = 2 ** 20;
    expect(out).toBe(
      [
        `${(p40 / 3).toFixed(3)} ${(p20 / 3).toFixed(3)} ${2 ** 32 + 1} 366503875925`,
        `${(p40 / 3).toFixed(3)} ${(p20 / 3).toFixed(3)} ${(p40 + 1).toFixed(3)} ${((p40 * 3) / 2).toFixed(3)} `,
        `${2 ** 32 + 1} ${2 ** 31 + 1} ${-p40} ${(p20 - 1) * p20} 366503875925 -1474836480`,
      ].join("|"),
    );
  });
});
