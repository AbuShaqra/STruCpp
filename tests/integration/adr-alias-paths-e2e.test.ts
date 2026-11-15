// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * An address stored in a 64-bit TYPE alias or subrange (a plain integer in
 * C++) builds and holds the whole address on every store path: initial
 * values, STRUCT initialisers naming members, arguments, FB inputs, results,
 * output capture, through a pointer, REF and SEL.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `TYPE MyL : LWORD; END_TYPE
TYPE RL : ULINT(0..18446744073709551615); END_TYPE
TYPE ST_W : STRUCT f : MyL; g : LWORD; END_STRUCT; END_TYPE
FUNCTION F : MyL
VAR_INPUT d : MyL; END_VAR
F := d;
END_FUNCTION
FUNCTION FA : MyL
VAR_IN_OUT v : INT; END_VAR
FA := ADR(v);
END_FUNCTION
FUNCTION FO : BOOL
VAR_IN_OUT v : INT; END_VAR
VAR_OUTPUT o : POINTER TO INT; END_VAR
o := ADR(v);
FO := TRUE;
END_FUNCTION
FUNCTION_BLOCK FB
VAR_INPUT d : MyL; END_VAR
VAR_OUTPUT o : POINTER TO INT; r : REF_TO INT; END_VAR
VAR_IN_OUT v : INT; END_VAR
o := ADR(v);
r := REF(v);
END_FUNCTION_BLOCK
FUNCTION_BLOCK FBM
VAR_INPUT pin : POINTER TO INT; END_VAR
METHOD MO : BOOL
VAR_OUTPUT o : POINTER TO INT; END_VAR
o := pin;
MO := TRUE;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR
  x : INT; y : INT;
  lw : LWORD;
  i1 : MyL := ADR(x);
  ar : ARRAY[0..1] OF MyL := [ADR(x), 0];
  s : ST_W := (f := ADR(x), g := ADR(x));
  rl : RL;
  s2 : ST_W;
  a : ARRAY[0..1] OF MyL;
  m1 : MyL; m2 : MyL; m3 : MyL; m4 : MyL; m5 : MyL; m6 : MyL; m7 : MyL;
  l1 : LWORD; l2 : LWORD; l3 : LWORD;
  pm : POINTER TO MyL;
  fb : FB; fbm : FBM; m8 : MyL; l4 : LWORD;
  b : BOOL; c : BOOL := TRUE;
  ok : INT;
END_VAR
lw := ADR(x);
rl := ADR(x);
s2.f := ADR(x);
a[1] := ADR(x);
m1 := F(ADR(x));
m2 := FA(x);
b := FO(v := x, o => m3);
b := FO(v := x, o => l1);
fb(d := ADR(x), v := x, o => m4, r => l2);
m5 := m4;
pm := ADR(m6);
pm^ := ADR(x);
m7 := REF(x);
fbm(pin := ADR(x));
b := fbm.MO(o => m8);
b := fbm.MO(o => l4);
l3 := SEL(c, ADR(y), ADR(x));
m5 := SEL(c, ADR(y), ADR(x));
ok := 0;
IF i1 = lw THEN ok := ok + 1; END_IF
IF ar[0] = lw THEN ok := ok + 1; END_IF
IF s.f = lw THEN ok := ok + 1; END_IF
IF s.g = lw THEN ok := ok + 1; END_IF
IF rl = lw THEN ok := ok + 1; END_IF
IF s2.f = lw THEN ok := ok + 1; END_IF
IF a[1] = lw THEN ok := ok + 1; END_IF
IF m1 = lw THEN ok := ok + 1; END_IF
IF m2 = lw THEN ok := ok + 1; END_IF
IF m3 = lw THEN ok := ok + 1; END_IF
IF l1 = lw THEN ok := ok + 1; END_IF
IF m4 = lw THEN ok := ok + 1; END_IF
IF l2 = lw THEN ok := ok + 1; END_IF
IF m5 = lw THEN ok := ok + 1; END_IF
IF m6 = lw THEN ok := ok + 1; END_IF
IF m7 = lw THEN ok := ok + 1; END_IF
IF l3 = lw THEN ok := ok + 1; END_IF
IF m8 = lw THEN ok := ok + 1; END_IF
IF l4 = lw THEN ok := ok + 1; END_IF
END_PROGRAM
`;

const OO = `TYPE MyL : LWORD; END_TYPE
INTERFACE I
METHOD M : BOOL
VAR_INPUT q : MyL; END_VAR
END_METHOD
PROPERTY Pr : MyL
GET
END_GET
SET
END_SET
END_PROPERTY
END_INTERFACE
FUNCTION_BLOCK FB IMPLEMENTS I
VAR px : MyL; END_VAR
METHOD M : BOOL
VAR_INPUT q : MyL; END_VAR
M := TRUE;
END_METHOD
PROPERTY Pr : MyL
GET
Pr := px;
END_GET
SET
px := Pr;
END_SET
END_PROPERTY
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB2 EXTENDS FB
METHOD M : BOOL
VAR_INPUT q : MyL; END_VAR
VAR x : INT; END_VAR
M := SUPER^.M(ADR(x));
END_METHOD
END_FUNCTION_BLOCK
PROGRAM P
VAR x : INT; fb : FB; itf : I; b : BOOL; i : DINT; END_VAR
itf := fb;
b := fb.M(ADR(x));
b := itf.M(q := ADR(x));
fb.Pr := ADR(x);
itf.Pr := ADR(x);
END_PROGRAM
`;

describe.skipIf(!hasGpp)("addresses stored in 64-bit aliases", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-adr-alias-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("stores the whole address on every path", () => {
    const r = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(r.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: r.headerCode,
      cppCode: r.cppCode,
      testName: "adr_alias_paths",
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p; p.run();\n std::cout << p.OK.get();\n return 0;\n}\n`,
    });
    expect(out.trim()).toBe("19");
  });

  it("builds SUPER^, interface method and property stores into an alias", () => {
    const r = compile(OO, {
      headerFileName: "generated.hpp",
      features: ["+pointer_to", "+self_caret", "+property"],
    });
    expect(r.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: r.headerCode,
      cppCode: r.cppCode,
      testName: "adr_alias_oo",
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_P p; p.run();\n std::cout << (p.FB_.PX == static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&p.X)));\n return 0;\n}\n`,
    });
    expect(out.trim()).toBe("1");
  });
});
