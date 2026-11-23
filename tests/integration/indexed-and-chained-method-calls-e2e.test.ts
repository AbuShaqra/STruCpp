/**
 * E2E (g++): a method result through an indexed interface or FB element has
 * the method's enum type (assignment, CASE, comparison, function and FB
 * argument), and a method called on a method result binds its outputs.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `TYPE E_St : (Idle, Run); END_TYPE
INTERFACE I_S
METHOD State : E_St
END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB_A IMPLEMENTS I_S
VAR_INPUT st : E_St; END_VAR
METHOD State : E_St
State := st;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_In
VAR_INPUT st : E_St; END_VAR
VAR_OUTPUT o : INT; END_VAR
o := SEL(st = E_St.Run, 1, 2);
END_FUNCTION_BLOCK
FUNCTION F_Ord : INT
VAR_INPUT v : E_St; END_VAR
F_Ord := SEL(v = E_St.Run, 10, 20);
END_FUNCTION
TYPE S_H : STRUCT items : ARRAY[1..2] OF I_S; END_STRUCT END_TYPE
INTERFACE I_M
METHOD M : INT
VAR_INPUT a : INT; END_VAR
VAR_OUTPUT o : INT; END_VAR
END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB IMPLEMENTS I_M
VAR k : INT; END_VAR
METHOD M : INT
VAR_INPUT a : INT; END_VAR
VAR_OUTPUT o : INT; END_VAR
k := k + a;
M := k; o := a * 2;
END_METHOD
METHOD Me : FB
Me := THIS^;
END_METHOD
METHOD Itf : I_M
Itf := THIS^;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION FF : FB
END_FUNCTION
PROGRAM Main
VAR
  a, r : FB_A; e1, e2 : E_St; n, f, g, i, cnt : INT; b, b1, b2 : BOOL; h : S_H; fi : FB_In;
  fbarr : ARRAY[1..2] OF FB_A; m : ARRAY[1..2, 1..2] OF I_S;
  fb : FB; y, x, z, w, q : INT;
END_VAR
VAR_TEMP one : I_S; arr : ARRAY[1..2] OF I_S; END_VAR
a.st := E_St.Run; r.st := E_St.Idle;
one := a; arr[1] := a; arr[2] := r; m[2, 1] := r; h.items[2] := a;
fbarr[2].st := E_St.Run;
e1 := one.State();
e2 := arr[1].State();
b1 := e1 = E_St.Run;
b2 := e2 = E_St.Run;
b := arr[1].State() = E_St.Run;
CASE arr[1].State() OF E_St.Run: n := 1; E_St.Idle: n := 2; END_CASE
f := F_Ord(arr[2].State()) + F_Ord(fbarr[2].State()) + F_Ord(m[2, 1].State());
fi(st := h.items[2].State());
g := fi.o;
FOR i := 1 TO 2 DO
  CASE arr[i].State() OF E_St.Run: cnt := cnt + 1; E_St.Idle: cnt := cnt + 100; END_CASE
END_FOR
y := fb.Me().M(5);
x := FF().Me().M(6);
z := fb.Itf().M(7);
w := fb.Me().Itf().M(a := 8, o => q);
END_PROGRAM
`;

describe.skipIf(!hasGpp)(
  "method calls through indexed elements and on method results — g++ e2e",
  () => {
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-idxcall-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    it("builds and runs", () => {
      const result = compile(SOURCE, { headerFileName: "generated.hpp" });
      expect(result.errors).toEqual([]);
      const stdout = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: "indexed_and_chained_method_calls",
        mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN p;
    p.run();
    std::cout << (p.B1.get() ? 1 : 0) << " "
              << (p.B2.get() ? 1 : 0) << " " << (p.B.get() ? 1 : 0)
              << " " << p.N.get() << " " << p.F.get() << " " << p.G.get()
              << " " << p.CNT.get() << " " << p.Y.get() << " " << p.X.get()
              << " " << p.Z.get() << " " << p.W.get() << " " << p.Q.get()
              << std::endl;
    return 0;
}
`,
      });
      // SEL(G, IN0, IN1) gives IN1 when G is TRUE. Me returns a copy (k from 0);
      // Itf refers to fb itself, so z leaves k = 7 in fb and its copy in w.
      expect(stdout).toBe("1 1 1 1 40 2 101 5 6 7 15 16");
    });
  },
);
