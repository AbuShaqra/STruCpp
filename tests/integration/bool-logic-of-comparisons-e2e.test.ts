// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: BOOL expressions built from comparisons, bit reads and AND/OR/XOR/NOT
 * build as C++ bool and give the right values. `bool & bool` is an int in
 * C++, so NOT() of it did not build, and a bit read was a uint64_t whose
 * NOT() was its complement (always TRUE). Runs a truth table under g++.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import {
  hasGpp,
  createPCH,
  compileAndRunStandalone,
  runE2ETestPipeline,
} from "./test-helpers.js";

const SOURCE = `
TYPE E_Mode : (Idle, Run, Stop); END_TYPE

FUNCTION F_Pos : BOOL
VAR_INPUT v : DINT; END_VAR
F_Pos := v > 0;
END_FUNCTION

FUNCTION F_Id : BOOL
VAR_INPUT v : BOOL; END_VAR
F_Id := v;
END_FUNCTION

FUNCTION_BLOCK FB_Gate
VAR_INPUT inp : BOOL; END_VAR
VAR_OUTPUT q : BOOL; END_VAR
q := inp;
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_U
VAR_INPUT a, b : DINT; END_VAR
VAR_OUTPUT q, q2, q3 : BOOL; END_VAR
q := NOT ((a >= DINT#6) AND (b >= DINT#6));
q2 := NOT ((a >= 6) AND (b >= 6));
q3 := NOT (a >= DINT#6);
END_FUNCTION_BLOCK

PROGRAM Main
VAR
  a, b : DINT;
  x : BOOL;
  w : WORD;
  r1, r2 : REAL;
  t1, t2 : TIME;
  s1, s2 : STRING;
  m1, m2 : E_Mode;
  p1, p2 : POINTER TO DINT;
  gate, gate2 : FB_Gate;
  u : FB_U;
  q0, q1, q2, q3, q4, q5, q6, q7, q8, q9 : BOOL;
  q10, q11, q12, q13, q14, q15, q16, q17, q18, q19 : BOOL;
  q20, q21, q22, q23, q24, q25, q26, q27, q28, q29 : BOOL;
  q30, q31, q32, q33, q34, q35 : BOOL;
  pw : POINTER TO WORD;
  sb, rb : BYTE;
END_VAR
r1 := DINT_TO_REAL(a);
r2 := DINT_TO_REAL(b) * 0.5;
t1 := T#5s;
IF b > 2 THEN t2 := T#1s; ELSE t2 := T#9s; END_IF;
s1 := 'abc';
IF a > 2 THEN s2 := 'abc'; ELSE s2 := 'xyz'; END_IF;
m1 := Run;
IF b > 0 THEN m2 := Run; ELSE m2 := Stop; END_IF;
p1 := ADR(a);
IF x THEN p2 := ADR(a); ELSE p2 := ADR(b); END_IF;

q0 := NOT ((a >= DINT#6) AND (b >= DINT#6));
q1 := NOT ((a >= 6) AND (b >= 6));
q2 := NOT (a >= DINT#6);
q3 := NOT ((a > b) OR (r1 < r2));
q4 := NOT ((t1 >= t2) XOR (s1 = s2));
q5 := NOT ((m1 = m2) AND (p1 = p2));
q6 := NOT (((a > 0) AND x) OR (F_Pos(b) AND (a < b)));
q7 := (a > b) = (r1 > r2);
q8 := ((a > 0) AND (b > 0)) = ((r1 > 0.0) OR (t1 > t2));
q9 := F_Id((a > 0) AND (b > 0));
gate(inp := (a > 0) XOR (b > 0));
q10 := gate.q;
IF NOT ((a > 0) AND (b > 0)) THEN q11 := TRUE; ELSE q11 := FALSE; END_IF;
q12 := SEL((a > b) AND (b > 0), FALSE, TRUE);
q13 := MUX(BOOL_TO_INT((a > 0) OR (b > 0)), FALSE, TRUE);
q14 := NOT (NOT (a > 0) AND NOT (b > 0));
q15 := NOT ((a > 0) & (b > 0));
q16 := NOT (TRUE AND (a > 0));
q17 := NOT ((a > 0) AND (b > 0) AND (a <> b) OR (r1 = r2));
q18 := NOT ((a > 0) AND (b > 0)) = NOT ((a > 0) OR (b > 0));
q19 := NOT (NOT ((a > 0) XOR (b > 0)) AND x);
q20 := NOT (w.3 AND (a > 1));
q21 := NOT w.3;
q22 := NOT (w.3);
q23 := NOT (w.3 OR x);
q24 := w.3 XOR TRUE;
q25 := F_Id(w.3);
gate2(inp := w.3);
q26 := gate2.q;
q27 := NOT (w.3 XOR w.0);
q28 := NOT (F_Pos(a) AND F_Pos(b));
u(a := a, b := b);
q29 := u.q AND u.q2;
q30 := u.q3;
pw := ADR(w);
q31 := NOT (pw^.3 XOR (a > 0));
q32 := NOT (pw^.3 AND (a > 0));
q33 := NOT (pw^.3 OR (b > 5));
sb := SHL(w.3, 2);
q34 := sb = 0;
rb := ROL(w.3, 1);
q35 := BYTE_TO_INT(rb) = BOOL_TO_INT(w.3);
END_PROGRAM
`;

/** The expected q0..q35 for one input case, computed independently. */
function expected(a: number, b: number, x: boolean, w: number): boolean[] {
  const r1 = a;
  const r2 = b * 0.5;
  const t1 = 5;
  const t2 = b > 2 ? 1 : 9;
  const sEq = a > 2;
  const mEq = b > 0;
  const pEq = x;
  const w3 = ((w >> 3) & 1) === 1;
  const w0 = (w & 1) === 1;
  const pos = (v: number): boolean => v > 0;
  return [
    !(a >= 6 && b >= 6),
    !(a >= 6 && b >= 6),
    !(a >= 6),
    !(a > b || r1 < r2),
    !(t1 >= t2 !== sEq),
    !(mEq && pEq),
    !((a > 0 && x) || (pos(b) && a < b)),
    a > b === r1 > r2,
    (a > 0 && b > 0) === (r1 > 0 || t1 > t2),
    a > 0 && b > 0,
    a > 0 !== b > 0,
    !(a > 0 && b > 0),
    a > b && b > 0,
    a > 0 || b > 0,
    !(!(a > 0) && !(b > 0)),
    !(a > 0 && b > 0),
    !(a > 0),
    !((a > 0 && b > 0 && a !== b) || r1 === r2),
    !(a > 0 && b > 0) === !(a > 0 || b > 0),
    !(!(a > 0 !== b > 0) && x),
    !(w3 && a > 1),
    !w3,
    !w3,
    !(w3 || x),
    w3 !== true,
    w3,
    w3,
    !(w3 !== w0),
    !(pos(a) && pos(b)),
    !(a >= 6 && b >= 6),
    !(a >= 6),
    !(w3 !== a > 0),
    !(w3 && a > 0),
    !(w3 || b > 5),
    true,
    true,
  ];
}

const AS = [-1, 0, 3, 7];
const BS = [-2, 0, 4, 8];
const XS = [false, true];
const WS = [0, 1, 8, 9];

const MAIN = `
#include <iostream>
int main() {
    strucpp::Program_MAIN prog;
    const int as[] = {${AS.join(", ")}};
    const int bs[] = {${BS.join(", ")}};
    const int ws[] = {${WS.join(", ")}};
    for (int ia = 0; ia < 4; ++ia)
    for (int ib = 0; ib < 4; ++ib)
    for (int ix = 0; ix < 2; ++ix)
    for (int iw = 0; iw < 4; ++iw) {
        prog.A = as[ia];
        prog.B = bs[ib];
        prog.X = ix != 0;
        prog.W = static_cast<uint16_t>(ws[iw]);
        prog.run();
        const bool q[] = {
            prog.Q0, prog.Q1, prog.Q2, prog.Q3, prog.Q4, prog.Q5, prog.Q6,
            prog.Q7, prog.Q8, prog.Q9, prog.Q10, prog.Q11, prog.Q12, prog.Q13,
            prog.Q14, prog.Q15, prog.Q16, prog.Q17, prog.Q18, prog.Q19,
            prog.Q20, prog.Q21, prog.Q22, prog.Q23, prog.Q24, prog.Q25,
            prog.Q26, prog.Q27, prog.Q28, prog.Q29, prog.Q30, prog.Q31,
            prog.Q32, prog.Q33, prog.Q34, prog.Q35};
        for (bool v : q) std::cout << (v ? '1' : '0');
        std::cout << '\\n';
    }
    return 0;
}
`;

const MEMBERS_SOURCE = `TYPE ST_S : STRUCT w : WORD; v : WORD; END_STRUCT END_TYPE
FUNCTION_BLOCK FB_O
VAR_OUTPUT wOut : WORD := 16#0F0F; END_VAR
END_FUNCTION_BLOCK
PROGRAM Main
VAR
  s : ST_S; ps : POINTER TO ST_S; fb : FB_O; a : DINT := 1; w : WORD := 16#0008;
  r1, r2, r3, r4 : WORD; q : BOOL;
END_VAR
VAR CONSTANT C_BIT : INT := 3; END_VAR
s.w := 16#00FF;
s.v := 16#0F0F;
ps := ADR(s);
r1 := s.w AND s.v;
r2 := fb.wOut OR 16#F0;
r3 := GVL.wx XOR GVL.wy;
r4 := ps^.w OR ps^.v;
q := NOT (w.C_BIT AND (a > 0));
END_PROGRAM
`;

const MEMBERS_OPTIONS = {
  fileName: "main.st",
  additionalSources: [
    {
      source:
        "VAR_GLOBAL wx : WORD := 16#00FF; wy : WORD := 16#0F0F; END_VAR\n",
      fileName: "GVL.st",
    },
  ],
  features: ["+named_global_lists"],
};

describe.skipIf(!hasGpp)("BOOL logic of comparisons and bit reads", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-bool-logic-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("builds and runs the truth table with the IEC values", () => {
    const result = compile(SOURCE);
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);

    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode!,
      cppCode: result.cppCode!,
      testName: "bool_logic_truth_table",
      mainCode: MAIN,
    });

    const want: string[] = [];
    for (const a of AS)
      for (const b of BS)
        for (const x of XS)
          for (const w of WS)
            want.push(
              expected(a, b, x, w)
                .map((v) => (v ? "1" : "0"))
                .join(""),
            );
    expect(stdout.split("\n")).toEqual(want);
  });

  it("keeps WORD members, FB outputs and list globals bitwise", () => {
    const result = compile(MEMBERS_SOURCE, MEMBERS_OPTIONS);
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode!,
      cppCode: result.cppCode!,
      testName: "bool_logic_members",
      mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN prog;
    prog.run();
    std::cout << std::hex << static_cast<int>(prog.R1) << " " << static_cast<int>(prog.R2)
              << " " << static_cast<int>(prog.R3) << " " << static_cast<int>(prog.R4)
              << " " << static_cast<int>(prog.Q) << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("f fff ff0 fff 0");
  });

  it("builds and passes a test file of bit reads in BOOL logic", () => {
    const { stdout, exitCode } = runE2ETestPipeline({
      sourceST: `
TYPE ST_M : STRUCT w : WORD; END_STRUCT END_TYPE
PROGRAM P
VAR k : INT; END_VAR
k := 1;
END_PROGRAM
`,
      testST: `
TEST 'bit reads in BOOL logic'
  VAR w : WORD; m : ST_M; x : INT; p : POINTER TO WORD; END_VAR
  w := 16#0008;
  m.w := 16#0004;
  x := 3;
  p := ADR(w);
  ASSERT_TRUE(NOT (w.2 AND (x > 0)));
  ASSERT_FALSE(NOT (m.w.2 AND (x > 0)));
  ASSERT_FALSE(NOT (w.3 OR (x > 5)));
  ASSERT_FALSE(NOT (w.3));
  ASSERT_FALSE(NOT (p^.3 XOR (x > 5)));
END_TEST
`,
      testFileName: "test_bits.st",
      tempDirPrefix: "strucpp-bool-logic-test-",
    });
    expect(stdout).toContain("[PASS] bit reads in BOOL logic");
    expect(stdout).toContain("1 test, 1 passed, 0 failed");
    expect(exitCode).toBe(0);
  });
});
