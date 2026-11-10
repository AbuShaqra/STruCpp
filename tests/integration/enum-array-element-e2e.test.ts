/**
 * E2E: an ARRAY OF an enumeration declared in a POU holds the same element
 * type a STRUCT field or a named ARRAY type does (IEC_E), so REF() and ADR()
 * of an element, assignment to and from a STRUCT field array, and passing
 * the array to an open-array VAR_IN_OUT build and run.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `
TYPE E2 : (A, B, C); END_TYPE
TYPE S : STRUCT ea : ARRAY[0..2] OF E2; END_STRUCT; END_TYPE
FUNCTION CountB : INT
VAR_INPUT v : ARRAY[0..2] OF E2; END_VAR
VAR i : INT; END_VAR
FOR i := 0 TO 2 DO IF v[i] = E2#B THEN CountB := CountB + 1; END_IF; END_FOR;
END_FUNCTION
FUNCTION SetC : BOOL
VAR_IN_OUT v : ARRAY[0..2] OF E2; END_VAR
v[2] := E2#C; SetC := TRUE;
END_FUNCTION
FUNCTION Last : E2
VAR_IN_OUT v : ARRAY[*] OF E2; END_VAR
Last := v[UPPER_BOUND(v, 1)];
END_FUNCTION
FUNCTION_BLOCK FB
VAR arr : ARRAY[1..2] OF E2 := [E2#B, E2#C]; END_VAR
VAR_OUTPUT o : E2; END_VAR
o := arr[2];
END_FUNCTION_BLOCK
PROGRAM Main
VAR
  arr : ARRAY[0..2] OF E2 := [E2#A, E2#B, E2#B];
  m : ARRAY[0..1, 0..1] OF E2;
  s : S; r : REF_TO E2; p : POINTER TO E2; f : FB; ok : BOOL;
  n : INT; z : INT; e : E2; w : E2;
END_VAR
r := REF(arr[0]);
r^ := E2#C;
p := ADR(arr[1]);
p^ := E2#A;
n := CountB(arr);
ok := SetC(arr);
s.ea := arr;
arr := s.ea;
m[1, 1] := arr[2];
f();
e := Last(arr);
CASE arr[0] OF E2#C: z := 7; ELSE z := 1; END_CASE;
w := f.o;
END_PROGRAM
`;

describe("ARRAY OF enum declarations", () => {
  it("declares POU, FB and STRUCT enum arrays with the variable element type", () => {
    const r = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(r.errors).toEqual([]);
    expect(r.headerCode).toContain("Array1D<IEC_E2, 0, 2> ARR;");
    expect(r.headerCode).toContain("Array2D<IEC_E2, 0, 1, 0, 1> M;");
    expect(r.headerCode).toContain("Array1D<IEC_E2, 1, 2> ARR");
    expect(r.headerCode).toContain("Array1D<IEC_E2, 0, 2> EA");
    expect(r.headerCode).not.toMatch(/Array\dD<E2,/);
  });
});

describe.skipIf(!hasGpp)("ARRAY OF enum end to end", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-enumarr-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("REF, ADR, struct and open-array use of enum elements run", () => {
    const r = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(r.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: r.headerCode,
      cppCode: r.cppCode,
      testName: "enum_array",
      mainCode: `#include <iostream>
int main() {
  strucpp::Program_MAIN p;
  p.run();
  std::cout << (int)p.N << " " << (int)p.Z << " " << p.E.get().to_int()
            << " " << p.W.get().to_int() << " " << p.ARR[1].get().to_int()
            << " " << p.M(1, 1).get().to_int() << std::endl;
  return 0;
}
`,
    });
    expect(out).toBe("1 7 2 2 0 2");
  });
});
