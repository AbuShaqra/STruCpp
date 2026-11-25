// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: standard-function forms that passed the check and then failed g++ or
 * computed the wrong value:
 * - functional AND/OR/XOR on a signed integer (with a literal, a computed
 *   argument, three arguments, mixed widths);
 * - a generic call nested in another (`MAX(SEL(b, i, j), 3)`,
 *   `MOD(SEL(b, i, j), 2)`), which emitted `static_cast<IEC_ANY>`;
 * - MUX with a converted enumeration selector;
 * - LDATE_TO_LINT of a literal;
 * - an integer `**` with a negative constant exponent, and one stored in a
 *   bit string, are exact integer powers (not `pow`);
 * - `**` in a STRUCT field default.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `
TYPE E : (A, B, C); END_TYPE
TYPE SP : STRUCT a : DINT := 2 ** 10; b : INT := 3 ** 2; c : LREAL := 2 ** 40 / 3; END_STRUCT END_TYPE
PROGRAM Main
VAR
  i : INT := -6; j : INT := 3; d : DINT := -7; l : LINT := -1; si : SINT := -3;
  bit : ARRAY[1..8] OF LINT;
  b : BOOL := TRUE; k : INT := 7; m : INT := 4; dd : DINT := 9;
  sl : ARRAY[1..6] OF DINT;
  e1 : E := B; ld : LDATE := LDATE#2020-01-02;
  dates : ARRAY[1..3] OF LINT;
  two : INT := 2; mone : INT := -1;
  pw : ARRAY[1..4] OF DINT; w : WORD; bt : BYTE; lw : LWORD; dw : DWORD;
  rec : SP;
END_VAR
bit[1] := AND(i, 3);
bit[2] := OR(d, 16#10);
bit[3] := XOR(i, 5);
bit[4] := AND(si, 7);
bit[5] := AND(i, j, 2);
bit[6] := OR(i, d);
bit[7] := XOR(l, 255);
bit[8] := AND(d + 1, -2);
sl[1] := MAX(SEL(b, k, m), 3);
sl[2] := MOD(SEL(b, k, m), 3);
sl[3] := MOD(SEL(b, dd, 4), 5);
sl[4] := MAX(SEL(b, k, dd), 3);
sl[5] := MOD(MUX(1, k, m, 5), 3);
sl[6] := MUX(TO_INT(e1), 10, 20, 30);
dates[1] := LDATE_TO_LINT(LDATE#1970-01-02);
dates[2] := LDATE_TO_LINT(ld);
dates[3] := TO_LINT(LDATE#1970-01-03);
pw[1] := two ** -1;
pw[2] := mone ** -3;
pw[3] := 1 ** -5;
pw[4] := 2 ** -2;
w := two ** 3;
bt := two ** 9;
dw := 3 ** two;
lw := INT#3 ** 39;
END_PROGRAM
`;

const MIXED = `
PROGRAM Main
VAR ui : UINT := 65535; i : INT := -2; d : DINT := -7; ud : UDINT := 4000000000; si : SINT := -1;
  w : WORD := 16#F0F0; dw : DWORD := 16#0FF0FF;
  r : ARRAY[1..7] OF LINT; s : ARRAY[1..7] OF LINT; n : INT; m : INT := 0; END_VAR
r[1] := AND(ui, i);  s[1] := ui AND i;
r[2] := AND(d, ud);  s[2] := d AND ud;
r[3] := OR(d, ud);   s[3] := d OR ud;
r[4] := XOR(ui, i, 5); s[4] := (ui XOR i) XOR 5;
r[5] := AND(w, dw);  s[5] := w AND dw;
r[6] := XOR(si, ui); s[6] := si XOR ui;
r[7] := NOT(d);      s[7] := NOT d;
n := NOT(m);
END_PROGRAM
`;

const MIXED_MAIN = `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    for (int k = 1; k <= 7; ++k) std::cout << p.R[k].get() << "/" << p.S[k].get() << " ";
    std::cout << p.N.get() << std::endl;
    return 0;
}
`;

const ZERO_POWER = `
PROGRAM Main
VAR z : DINT := 0; m : DINT := -1; r : DINT; END_VAR
r := z ** m;
END_PROGRAM
`;

const MAIN = `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    for (int i = 1; i <= 8; ++i) std::cout << p.BIT[i].get() << " ";
    std::cout << "|";
    for (int i = 1; i <= 6; ++i) std::cout << p.SL[i].get() << " ";
    std::cout << "|";
    for (int i = 1; i <= 3; ++i) std::cout << p.DATES[i].get() << " ";
    std::cout << "|";
    for (int i = 1; i <= 4; ++i) std::cout << p.PW[i].get() << " ";
    std::cout << p.W.get() << " " << int(p.BT.get()) << " " << p.DW.get() << " " << p.LW.get();
    std::cout << "|" << p.REC.A.get() << " " << p.REC.B.get() << " " << (p.REC.C.get() > 366503875925.0);
    std::cout << std::endl;
    return 0;
}
`;

describe.skipIf(!hasGpp)("standard-function forms — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-stdforms-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("computes mixed-type functional AND/OR/XOR and NOT as the operators do", () => {
    const result = compile(MIXED, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "std_function_mixed_bitwise",
      mainCode: MIXED_MAIN,
    });
    expect(out).toBe(
      "65534/65534 4000000000/4000000000 -7/-7 -65532/-65532 61680/61680 -65536/-65536 0/0 1",
    );
  });

  it("faults on 0 to a negative power, as a division by zero", () => {
    const result = compile(ZERO_POWER, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "std_function_zero_power",
      mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    try { p.run(); } catch (const std::exception& e) { std::cout << e.what(); return 0; }
    std::cout << "no fault";
    return 0;
}
`,
    });
    expect(out).toContain("Division by zero");
  });

  it("builds and computes each form", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    expect(result.cppCode).not.toContain("IEC_ANY");
    expect(result.cppCode).not.toContain("std::pow");
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "std_function_forms",
      mainCode: MAIN,
    });
    const day = 86400000000000n;
    expect(out.split("|").map((p) => p.trim())).toEqual([
      "2 -7 -1 5 2 -5 -256 -6",
      "4 1 4 9 1 20",
      `${day} ${day * 18263n} ${day * 2n}`,
      "0 -1 1 0 8 0 9 4052555153018976267",
      "1024 9 1",
    ]);
  });
});
