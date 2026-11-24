// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: a FUNCTION, METHOD or property getter whose result is not assigned on
 * every path returns the result type's default, never falling off the end of
 * the C++ function: an INTERFACE result is NULL. An assignment to an
 * INTERFACE method result does not leave the method; RETURN returns what was
 * assigned. Built with -fsanitize=undefined and run.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `INTERFACE I
METHOD M : INT
END_METHOD
END_INTERFACE
INTERFACE J
METHOD GetI : I
VAR_INPUT b : BOOL; END_VAR
END_METHOD
END_INTERFACE
TYPE ST : STRUCT a : INT := 3; END_STRUCT END_TYPE
TYPE EP : (P1, P2); END_TYPE
TYPE ED : (D1, D2, D3) := D2; END_TYPE
TYPE MI : INT; END_TYPE
TYPE SR : INT (3..9); END_TYPE
FUNCTION_BLOCK FBX IMPLEMENTS I, J
VAR_OUTPUT n : INT; END_VAR
METHOD M : INT
M := 7;
END_METHOD
METHOD GetI : I
VAR_INPUT b : BOOL; END_VAR
IF b THEN GetI := THIS^; END_IF
n := n + 1;
END_METHOD
METHOD Early : I
Early := THIS^;
RETURN;
n := 100;
END_METHOD
METHOD Bare : I
RETURN;
END_METHOD
METHOD GetP : POINTER TO INT
END_METHOD
METHOD GetS : STRING
END_METHOD
PROPERTY PI : I
GET
END_GET
END_PROPERTY
END_FUNCTION_BLOCK
FUNCTION FI : I
VAR_INPUT b : BOOL; END_VAR
END_FUNCTION
FUNCTION FP : POINTER TO INT
END_FUNCTION
FUNCTION FR : REFERENCE TO INT
END_FUNCTION
FUNCTION FS : ST
END_FUNCTION
FUNCTION MakeFb : FBX
END_FUNCTION
FUNCTION FSTR : STRING
END_FUNCTION
FUNCTION FEP : EP
END_FUNCTION
FUNCTION FED : ED
END_FUNCTION
FUNCTION FMI : MI
END_FUNCTION
FUNCTION FSR : SR
END_FUNCTION
PROGRAM Main
VAR
  f : FBX; j : J; i : I; p : POINTER TO INT; s : ST; ff : FBX;
  str : STRING; ep : EP; ed : ED; mi : MI; sr : SR; x : INT;
  r : ARRAY[0..19] OF BOOL;
END_VAR
i := f.GetI(FALSE); r[0] := i = 0;
i := f.GetI(TRUE); r[1] := (i <> 0) AND (f.n = 2);
j := f; i := j.GetI(FALSE); r[2] := (i = 0) AND (f.n = 3);
x := j.GetI(TRUE).M(); r[3] := x = 7;
i := f.Early(); r[4] := (i <> 0) AND (f.n = 4);
i := f.Bare(); r[5] := i = 0;
i := FI(FALSE); r[6] := i = 0;
p := FP(); r[7] := p = 0;
p := f.GetP(); r[8] := p = 0;
s := FS(); r[9] := s.a = 3;
ff := MakeFb(); r[10] := ff.n = 0;
str := FSTR(); r[11] := str = '';
str := f.GetS(); r[12] := str = '';
ep := FEP(); r[13] := ep = P1;
ed := FED(); r[14] := ed = D2;
mi := FMI(); r[15] := mi = 0;
sr := FSR(); r[16] := sr = 3;
i := f.PI; r[17] := i = 0;
r[18] := TRUE;
r[19] := TRUE;
END_PROGRAM
`;

const MAIN = `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    for (int k = 0; k <= 19; k++) std::cout << (p.R[k] ? "1" : "0");
    std::cout << std::endl;
    return 0;
}
`;

describe.skipIf(!hasGpp)(
  "unassigned results — g++ -fsanitize=undefined e2e",
  () => {
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-unassigned-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    it("returns each type's default; an INTERFACE result is NULL", () => {
      const result = compile(SOURCE, { headerFileName: "generated.hpp" });
      expect(result.errors).toEqual([]);
      const stdout = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: "unassigned_results",
        extraFlags: [
          "-fsanitize=undefined",
          "-fno-sanitize-recover=all",
          "-Werror=return-type",
        ],
        mainCode: MAIN,
      });
      expect(stdout).toBe("11111111111111111111");
    });

    it("declares an INTERFACE method result as a nullable IEC_ITF", () => {
      const result = compile(SOURCE, { headerFileName: "generated.hpp" });
      expect(result.headerCode).toContain(
        "virtual IEC_ITF<I> GETI(IEC_BOOL B)",
      );
      expect(result.cppCode).toContain("IEC_ITF<I> FBX::GETI(IEC_BOOL B) {");
      expect(result.cppCode).toContain("    IEC_ITF<I> GETI_result;");
      expect(result.cppCode).toContain("    IEC_ED FED_result = ED::D2;");
      expect(result.cppCode).toContain("    SR FSR_result{3};");
      expect(result.cppCode).not.toContain("return *this;");
    });
  },
);
