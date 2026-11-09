/**
 * E2E for REFERENCE TO inputs through g++: the call binds the input to the
 * argument, so reads and writes through it inside the callee reach the
 * caller's variable. Covers FB, function and method calls, named and
 * positional, with a local, a global, an FB member, an array element, a
 * STRUCT field, a REF_TO dereference and a forwarded REFERENCE TO as the
 * argument, REF= inside the callee, and an unbound input raising the
 * NullReference fault.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `TYPE ST_P : STRUCT x : INT; y : INT; END_STRUCT END_TYPE
TYPE MyInt : INT; END_TYPE
VAR_GLOBAL g : INT := 100; END_VAR
FUNCTION_BLOCK FB_Holder
VAR h : INT := 50; END_VAR
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_R
VAR_INPUT r : REFERENCE TO INT; k : INT; END_VAR
VAR_OUTPUT seen : INT; END_VAR
  r := r + k;
  seen := r;
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Rebind
VAR_INPUT r : REFERENCE TO INT; END_VAR
VAR own : INT := 40; END_VAR
VAR_OUTPUT o : INT; END_VAR
  r := r + 1;
  r REF= own;
  r := r + 2;
  o := own;
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Alias
VAR_INPUT r : REFERENCE TO MyInt; END_VAR
  r := r + 1000;
END_FUNCTION_BLOCK
FUNCTION F_R : INT
VAR_INPUT k : INT; r : REFERENCE TO INT; END_VAR
  r := r + k;
  F_R := r;
END_FUNCTION
FUNCTION F_Fwd : INT
VAR_INPUT r : REFERENCE TO INT; END_VAR
  F_Fwd := F_R(1, r);
END_FUNCTION
FUNCTION_BLOCK FB_M
METHOD M : INT
VAR_INPUT r : REFERENCE TO INT; k : INT; END_VAR
  r := r + k;
  M := r;
END_METHOD
METHOD Own : INT
VAR_INPUT r : REFERENCE TO INT; END_VAR
  Own := M(r, 1000);
END_METHOD
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR_EXTERNAL g : INT; END_VAR
VAR
  f : FB_R; fb2 : FB_Rebind; fal : FB_Alias; m : FB_M; hold : FB_Holder;
  n : INT := 5; arr : ARRAY[1..3] OF INT := [1, 2, 3]; p : ST_P;
  pr : REF_TO INT; q : INT := 60;
  a : INT; b : INT; c : INT; d : INT; s1 : INT; s2 : INT;
END_VAR
  p.y := 7;
  pr := REF(q);
  f(r := n, k := 1);
  s1 := f.seen;
  f(k := 2);
  f(g, 10);
  f(r := hold.h, k := 3);
  f(r := arr[2], k := 20);
  f(r := p.y, k := 30);
  s2 := f.seen;
  a := F_R(r := arr[3], k := 4);
  a := F_R(5, g);
  b := m.M(r := p.x, k := 9);
  b := m.M(hold.h, 1);
  b := m.M(pr^, 6);
  fb2(r := n);
  c := F_Fwd(n);
  d := m.Own(r := arr[1]);
  fal(r := q);
END_PROGRAM
`;

const PRINT = [
  "N",
  "HOLD.H",
  "ARR[1]",
  "ARR[2]",
  "ARR[3]",
  "P.X",
  "P.Y",
  "Q",
  "A",
  "B",
  "C",
  "D",
  "S1",
  "S2",
  "FB2.O",
]
  .map((v) => `p.${v}.get()`)
  .join(' << " " << ');

describeIfGpp("REFERENCE TO inputs bound at the call, end to end", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-refinputs-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function run(source: string, mainBody: string, name: string): string {
    const result = compile(source, { headerFileName: "generated.hpp" });
    expect(result.errors.map((e) => `${e.line}: ${e.message}`)).toEqual([]);
    return compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: name,
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n${mainBody}\n return 0;\n}\n`,
    });
  }

  it("reads and writes through the input reach every kind of argument", () => {
    const out = run(
      SOURCE,
      ` Program_MAIN p;\n p.run();\n std::cout << ${PRINT} << " " << G.get() << std::endl;`,
      "refinputs_all",
    );
    // n: 5 +1 +2 (kept binding) +1 (FB_Rebind before REF=) +1 (F_Fwd) = 10
    // hold.h 50+3+1, arr 1001/22/7, p.x 9, p.y 37, q 60+6+1000, g 100+10+5
    expect(out).toBe("10 54 1001 22 7 9 37 1066 115 66 10 1001 6 37 42 115");
  });

  it("an unbound REFERENCE TO input raises the NullReference fault", () => {
    const out = run(
      `FUNCTION_BLOCK FB_R
VAR_INPUT r : REFERENCE TO INT; k : INT; END_VAR
  r := r + k;
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_M
METHOD M : INT
VAR_INPUT r : REFERENCE TO INT; k : INT; END_VAR
  M := r + k;
END_METHOD
METHOD Skip : INT
VAR_INPUT r : REFERENCE TO INT; k : INT; END_VAR
  Skip := k;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR f : FB_R; m : FB_M; a : INT; b : INT; END_VAR
  a := m.Skip(k := 3);
  b := m.M(k := 4);
END_PROGRAM
PROGRAM SECOND
VAR f : FB_R; END_VAR
  f(k := 2);
END_PROGRAM
`,
      ` Program_MAIN p;\n try { p.run(); std::cout << "no fault"; } catch (const NullReferenceException& e) { std::cout << "fault a=" << p.A.get() << " "; }\n Program_SECOND s;\n try { s.run(); std::cout << "no fault"; } catch (const NullReferenceException& e) { std::cout << e.what(); }\n std::cout << std::endl;`,
      "refinputs_unbound",
    );
    expect(out).toBe(
      "fault a=3 Null reference dereference in REFERENCE TO",
    );
  });
});
