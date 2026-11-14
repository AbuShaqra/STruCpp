// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: DINT and LINT +, - and * wrap (two's complement) with no C++ signed
 * overflow, checked by UBSan with recovery off.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `PROGRAM Main
VAR xd : DINT := 2147483647; nd : DINT := -2147483648; one : DINT := 1; xl : LINT := 9223372036854775807;
d1, d2, d3, d4 : DINT; l1, l2 : LINT; END_VAR
d1 := xd + 1;
d2 := xd + one;
d3 := nd - one;
d4 := xd * 2;
l1 := xl + 1;
l2 := xl * xl;
END_PROGRAM
`;

describe.skipIf(!hasGpp)("integer overflow wraps — g++ UBSan e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-wrap-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("wraps DINT and LINT arithmetic in a body and in IECVar", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "intwrap",
      extraFlags: ["-fsanitize=undefined", "-fno-sanitize-recover=undefined"],
      mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    strucpp::IECVar<int32_t> a(2147483647), b(2);
    strucpp::IECVar<int64_t> c(-9223372036854775807LL - 1);
    a *= 2;
    std::cout << p.D1.get() << " " << p.D2.get() << " " << p.D3.get() << " " << p.D4.get() << " "
              << p.L1.get() << " " << p.L2.get() << " " << a.get() << " " << (a + b * b).get() << " "
              << (c - int64_t(1)).get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe(
      "-2147483648 -2147483648 2147483647 -2 -9223372036854775808 1 -2 2 9223372036854775807",
    );
  });
});
