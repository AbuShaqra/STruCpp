// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: DINT and LINT +, - and * wrap (two's complement) with no C++ signed
 * overflow, checked by UBSan with recovery off. Narrow integer arithmetic is
 * computed in DINT and cut only where it is stored.
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

  it("wraps through an alias, a subrange, a dereference and an array of an alias", () => {
    const result = compile(
      `TYPE MyD : DINT; END_TYPE
TYPE MyL : LINT; END_TYPE
TYPE Rng : DINT(0..2147483647); END_TYPE
PROGRAM Main
VAR a : MyD := 2147483647; b : MyL := 9223372036854775807; rg : Rng := 2147483647;
v : DINT := 2147483647; p : POINTER TO DINT; arr : ARRAY[0..1] OF MyD := [2147483647, 1];
n : DINT := -2147483648; r1 : MyD; r2 : MyL; r3, r4, r5 : DINT; END_VAR
r1 := a + a;
r2 := b * b;
r3 := rg + 1;
p := ADR(v);
r4 := p^ * 2;
arr[1] := arr[0] + arr[0];
r5 := -n;
END_PROGRAM
`,
      { headerFileName: "generated.hpp" },
    );
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "intwrapalias",
      extraFlags: ["-fsanitize=undefined", "-fno-sanitize-recover=undefined"],
      mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.R1 << " " << p.R2 << " " << p.R3.get() << " " << p.R4.get() << " "
              << p.ARR[1] << " " << p.R5.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("-2 1 -2147483648 -2 -2 -2147483648");
  });

  it("computes narrow arithmetic in DINT and cuts it where it is stored", () => {
    const result = compile(
      `PROGRAM Main
VAR i : INT := 32767; m : INT := -32768; si : SINT := 127; u : UINT := 65535;
d1, d2, d3, d4, d5, d6, d7 : DINT; i1, i2, i3, i4 : INT; END_VAR
d1 := i + 1;
d2 := i + i;
d3 := i * 2;
d4 := -m;
d5 := INT#32767 + INT#1;
d6 := si + si;
d7 := u + u;
i1 := i + 1;
i2 := i + i;
i3 := i * 2;
i4 := -m;
END_PROGRAM
`,
      { headerFileName: "generated.hpp" },
    );
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "intwrapnarrow",
      extraFlags: ["-fsanitize=undefined", "-fno-sanitize-recover=undefined"],
      mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.D1.get() << " " << p.D2.get() << " " << p.D3.get() << " " << p.D4.get() << " "
              << p.D5.get() << " " << p.D6.get() << " " << p.D7.get() << " " << p.I1.get() << " "
              << p.I2.get() << " " << p.I3.get() << " " << p.I4.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe(
      "32768 65534 65534 32768 32768 254 131070 -32768 -2 -2 -32768",
    );
  });

  it("evaluates the operands of a wrapped operation left to right", () => {
    const result = compile(
      `FUNCTION BumpD : DINT
VAR_IN_OUT r : DINT; END_VAR
VAR_INPUT d : DINT; END_VAR
r := r + d;
BumpD := r;
END_FUNCTION
FUNCTION BumpI : INT
VAR_IN_OUT r : INT; END_VAR
VAR_INPUT d : INT; END_VAR
r := r + d;
BumpI := r;
END_FUNCTION
PROGRAM Main
VAR ad : ARRAY[0..1] OF DINT := [3, 4]; ai : ARRAY[0..1] OF INT := [3, 4];
wd, nd, ud : DINT; wi, ni, ui : INT; END_VAR
wd := BumpD(ad[1], 100) + ad[1];
wi := BumpI(ai[1], 100) + ai[1];
nd := (BumpD(ad[0], 1) + ad[0]) * ad[0];
ni := ai[0] - BumpI(ai[0], 10);
ud := -BumpD(ad[0], 1) - ad[0];
ui := -(BumpI(ai[0], 1) * 2) + ai[0];
END_PROGRAM
`,
      { headerFileName: "generated.hpp" },
    );
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "intwraporder",
      extraFlags: ["-fsanitize=undefined", "-fno-sanitize-recover=undefined"],
      mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.WD.get() << " " << p.WI.get() << " " << p.ND.get() << " " << p.NI.get() << " "
              << p.UD.get() << " " << p.UI.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("208 208 32 -10 -10 -14");
  });
});
