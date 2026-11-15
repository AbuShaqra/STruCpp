// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * EN/ENO on a call statement or a whole right-hand side: with EN FALSE the
 * call is not made (its inputs are not evaluated, the target keeps its value)
 * and ENO is FALSE; with EN TRUE the call runs and ENO is TRUE. A method of an
 * array element or STRUCT member (`arr[1].M(...)`, `s.fb.M(...)`) dropped EN
 * and ENO before. Nested CHAR/WCHAR MAX/GT keep theirs. g++ runs it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `FUNCTION Tr : INT
VAR_INPUT id : INT; END_VAR
VAR_IN_OUT log : INT; END_VAR
log := log * 10 + id;
Tr := id;
END_FUNCTION
FUNCTION_BLOCK FB1
VAR_OUTPUT runs : INT; END_VAR
METHOD M : INT
VAR_INPUT x : INT; END_VAR
runs := runs + 1;
M := x * 2;
END_METHOD
END_FUNCTION_BLOCK
TYPE ST_H : STRUCT fb : FB1; END_STRUCT END_TYPE
PROGRAM Main
VAR
  log : INT;
  r1 : INT := 7; r2 : INT := 7; r3 : INT := 7; r4 : INT := 7; r5 : INT := 7;
  r6 : INT; r7 : INT; r8 : INT; r9 : INT;
  e1, e2, e3, e4, e5, e6, e7, e8, e9, e10, e11, e12 : BOOL := TRUE;
  arr : ARRAY[1..2] OF FB1; s : ST_H;
  c1 : CHAR := CHAR#'a'; c2 : CHAR := CHAR#'b'; c3 : CHAR := CHAR#'c';
  c4 : CHAR := CHAR#'z'; t : BOOL := TRUE;
END_VAR
Tr(EN := FALSE, id := Tr(1, log), log := log, ENO => e1);
r1 := Tr(EN := FALSE, id := Tr(2, log), log := log, ENO => e2);
r2 := MAX(EN := FALSE, IN1 := Tr(3, log), IN2 := 9, ENO => e3);
r3 := arr[1].M(EN := FALSE, x := 4, ENO => e4);
arr[1].M(EN := FALSE, x := 4, ENO => e5);
r4 := s.fb.M(EN := FALSE, x := 4, ENO => e6);
s.fb.M(EN := FALSE, x := 4, ENO => e7);
r5 := MAX(EN := TRUE, IN1 := Tr(5, log), IN2 := 3, ENO => e8);
r6 := arr[2].M(EN := TRUE, x := 6, ENO => e9);
r7 := s.fb.M(EN := TRUE, x := 7, ENO => e10);
s.fb.M(EN := TRUE, x := 1, ENO => e10);
c4 := MAX(c1, MAX(EN := FALSE, IN1 := c2, IN2 := c3, ENO => e11));
t := GT(EN := FALSE, IN1 := c3, IN2 := c1, ENO => e12) OR FALSE;
r8 := arr[1].runs;
r9 := s.fb.runs;
END_PROGRAM
`;

describeIfGpp("EN/ENO on a call statement or whole right-hand side", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-en-eno-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("skips the call and clears ENO when EN is FALSE", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const ints = ["LOG", "R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9"]
      .map((v) => `std::cout << p.${v}.get() << ' ';`)
      .join(" ");
    const bools = Array.from({ length: 12 }, (_, i) => `E${i + 1}`)
      .map((v) => `std::cout << p.${v}.get();`)
      .join(" ");
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "en_eno_placement",
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p;\n p.run();\n ${ints}\n ${bools}\n std::cout << ' ' << (int)p.C4.get() << ' ' << p.T.get() << std::endl;\n return 0;\n}\n`,
    });
    // log 5: only the EN TRUE input ran; r1..r4 keep 7; r5 = MAX(5, 3);
    // r6, r7 the method results; arr[1] never ran, s.fb ran twice.
    // ENO: FALSE for each EN FALSE call, TRUE for the EN TRUE ones (e10 last).
    // c4 = MAX('a', default CHAR 0) = 'a' (97); t = FALSE.
    expect(out).toBe("5 7 7 7 7 5 12 14 0 2 000000011100 97 0");
  });
});

// Whole right-hand side stored through a scalar VAR_EXTERNAL (->write), a
// property setter, a bit, a composite shared global and a subrange check:
// the EN guard wraps the same store the assignment makes without EN/ENO.
const STORES = `TYPE SR : INT (0..10); END_TYPE
TYPE ST_S : STRUCT a : INT; b : INT; END_STRUCT END_TYPE
FUNCTION Tr : INT
VAR_INPUT id : INT; END_VAR
VAR_IN_OUT log : INT; END_VAR
log := log * 10 + id;
Tr := id;
END_FUNCTION
FUNCTION Fs : ST_S
VAR_INPUT x : INT; END_VAR
Fs.a := x; Fs.b := x + 1;
END_FUNCTION
FUNCTION Fb_ : BOOL
VAR_INPUT x : INT; END_VAR
Fb_ := x > 0;
END_FUNCTION
FUNCTION_BLOCK FB1
VAR pv : INT := 7; END_VAR
METHOD M : INT
VAR_INPUT x : INT; END_VAR
M := x;
END_METHOD
PROPERTY P : INT
GET
P := pv;
END_GET
SET
pv := P;
END_SET
END_PROPERTY
END_FUNCTION_BLOCK
PROGRAM Main
VAR_EXTERNAL g1 : INT; g2 : INT; g3 : INT; g4 : INT; gs : ST_S; gt : ST_S; END_VAR
VAR
  log : INT; arr : ARRAY[1..2] OF FB1; fx : FB1; fy : FB1;
  w : WORD := 16#0000; v : WORD := 16#0000;
  sa : SR := 3; sb : SR := 3; sc : SR := 3;
  e : ARRAY[1..12] OF BOOL := [12(TRUE)];
  pr : INT; py : INT; eok : BOOL;
END_VAR
g1 := Tr(EN := TRUE, id := 2, log := log, ENO => e[1]);
g2 := Tr(EN := FALSE, id := Tr(1, log), log := log, ENO => e[2]);
g3 := arr[1].M(EN := TRUE, x := 4, ENO => e[3]);
g4 := arr[1].M(EN := FALSE, x := Tr(1, log), ENO => e[4]);
fx.P := Tr(EN := FALSE, id := Tr(1, log), log := log, ENO => e[5]);
fy.P := Tr(EN := TRUE, id := 9, log := log, ENO => e[6]);
w.3 := Fb_(EN := FALSE, x := Tr(1, log), ENO => e[7]);
v.3 := Fb_(EN := TRUE, x := 5, ENO => e[8]);
gs := Fs(EN := FALSE, x := Tr(1, log), ENO => e[9]);
gt := Fs(EN := TRUE, x := 5, ENO => e[10]);
sa := Tr(EN := FALSE, id := 20, log := log, ENO => e[11]);
sb := Tr(EN := TRUE, id := 8, log := log, ENO => e[12]);
pr := fx.P; py := fy.P;
sc := Tr(EN := TRUE, id := 20, log := log, ENO => eok);
END_PROGRAM
CONFIGURATION Cfg
VAR_GLOBAL g1 : INT := 5; g2 : INT := 5; g3 : INT := 5; g4 : INT := 5;
  gs : ST_S := (a := 1, b := 1); gt : ST_S := (a := 1, b := 1); END_VAR
RESOURCE R ON PLC
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM inst WITH T : Main;
END_RESOURCE
END_CONFIGURATION
`;

describeIfGpp("EN/ENO around every kind of assignment store", () => {
  let tempDir: string;
  let out: Record<string, string>;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-en-eno-st-"));
    const pchPath = createPCH(tempDir);
    const result = compile(STORES, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const text = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "en_eno_stores",
      mainCode: `#include <iostream>
int main() {
    using namespace strucpp;
    static Configuration_CFG cfg;
    auto& p = cfg.INST;
    try { p.run(); } catch (const std::exception& e) { std::cout << "fault=" << e.what() << "\\n"; }
    std::cout << "log=" << p.LOG.get() << "\\ng=" << p.G1->read() << ' ' << p.G2->read() << ' '
              << p.G3->read() << ' ' << p.G4->read() << "\\nprop=" << p.PR.get() << ' '
              << p.PY.get() << "\\nbit=" << p.W.get() << ' ' << p.V.get() << "\\nglobal=";
    p.GS->with_lock([&](auto* s) { std::cout << s->A << ',' << s->B << ' '; });
    p.GT->with_lock([&](auto* s) { std::cout << s->A << ',' << s->B; });
    std::cout << "\\nsubrange=" << p.SA << ' ' << p.SB << ' ' << p.SC << "\\neno=";
    for (int i = 1; i <= 12; ++i) std::cout << p.E[i].get();
    std::cout << ' ' << p.EOK.get() << std::endl;
    return 0;
}
`,
    });
    out = Object.fromEntries(
      text
        .trim()
        .split("\n")
        .map((line) => [
          line.slice(0, line.indexOf("=")),
          line.slice(line.indexOf("=") + 1),
        ]),
    );
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes a scalar VAR_EXTERNAL through the shared global", () => {
    // FUNCTION and arr[1].M: EN TRUE writes (2, 4), EN FALSE keeps 5
    expect(out.g).toBe("2 5 4 5");
    expect(out.eno?.slice(0, 4)).toBe("1010");
  });

  it("guards a property, a bit and a composite shared global", () => {
    // EN FALSE: fx.P keeps 7, w.3 stays 0, gs keeps (1,1); EN TRUE: 9, 8, (5,6)
    expect(out.prop).toBe("7 9");
    expect(out.bit).toBe("0 8");
    expect(out.global).toBe("1,1 5,6");
    expect(out.eno?.slice(4, 10)).toBe("010101");
    // Only the EN TRUE calls ran: Tr(2), Tr(9), Tr(8), Tr(20)
    expect(out.log).toBe("3000");
  });

  it("checks a subrange store", () => {
    // sa keeps 3, sb 8; sc := 20 faults as without EN, keeps 3, ENO not set
    expect(out.fault).toBe(
      "Value 20 outside 0..10 stored in SC in MAIN, line 54",
    );
    expect(out.subrange).toBe("3 8 3");
    expect(out.eno).toBe("101001010101 0");
  });
});
