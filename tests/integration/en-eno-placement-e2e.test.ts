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
