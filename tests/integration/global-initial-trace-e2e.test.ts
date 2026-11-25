// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: global creation order through the code an initial value runs, for
 * CONFIGURATION globals, a list global reading a CONFIGURATION global, an
 * interface global still NULL while globals are created, and pointers
 * stored through access paths (call-reads.ts, pointer-flow.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const CFG_TAIL = `RESOURCE R ON PLC
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM inst WITH T : Main;
END_RESOURCE
END_CONFIGURATION
`;

/** A FUNCTION reading CONFIGURATION globals declared after the one calling it. */
export const CFG_CALLS = `FUNCTION F : INT
VAR_EXTERNAL gy : INT; END_VAR
F := gy * 2;
END_FUNCTION
FUNCTION G : INT
VAR_EXTERNAL pk : POINTER TO INT; END_VAR
G := pk^ * 3;
END_FUNCTION
PROGRAM Main
VAR_EXTERNAL x, z : INT; END_VAR
VAR o1, o2 : INT; END_VAR
o1 := x; o2 := z;
END_PROGRAM
CONFIGURATION Cfg
VAR_GLOBAL
  x : INT := F();
  z : INT := G();
  pk : POINTER TO INT := ADR(k);
  gy : INT := 5;
  k : INT := 4;
END_VAR
${CFG_TAIL}`;

/** A list global whose FUNCTION reads a CONFIGURATION global. */
export const LIST_READS_CFG = `FUNCTION F : INT
VAR_EXTERNAL gy : INT; END_VAR
F := gy * 2;
END_FUNCTION
VAR_GLOBAL x : INT := F(); END_VAR
PROGRAM Main
VAR_EXTERNAL x, gy : INT; END_VAR
VAR o1, o2 : INT; END_VAR
o1 := x; o2 := gy;
END_PROGRAM
CONFIGURATION Cfg
VAR_GLOBAL gy : INT := 5; END_VAR
${CFG_TAIL}`;

/** `gi` is NULL while globals are created; the guarded call runs no implementer. */
export const NULL_INTERFACE = `INTERFACE I_X
METHOD M : INT
END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB_X IMPLEMENTS I_X
VAR_EXTERNAL x : INT; END_VAR
METHOD M : INT
M := x + 1;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION F : INT
VAR_EXTERNAL gi : I_X; END_VAR
IF gi <> 0 THEN F := gi.M(); ELSE F := 7; END_IF
END_FUNCTION
VAR_GLOBAL
  gi : I_X;
  fx : FB_X;
  x : INT := F();
END_VAR
PROGRAM Main
VAR_EXTERNAL gi : I_X; fx : FB_X; x : INT; END_VAR
VAR o1, o2 : INT; END_VAR
o1 := x;
gi := fx;
o2 := gi.M();
END_PROGRAM
`;

/**
 * A STRUCT field and an array element store do not widen `p^` to every
 * address taken; `fh.hp^` reads only what the member `hp` is given.
 */
export const PATH_STORES = `TYPE ST_Q : STRUCT q : POINTER TO INT; END_STRUCT END_TYPE
FUNCTION_BLOCK FB_P
VAR p : POINTER TO INT := ADR(ga); s : ST_Q; arr : ARRAY[0..1] OF POINTER TO INT; END_VAR
VAR_EXTERNAL ga, gb : INT; END_VAR
METHOD Other : INT
s.q := ADR(gb);
arr[1] := ADR(gb);
Other := 0;
END_METHOD
METHOD Get : INT
Get := p^ + 1;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_H
VAR_OUTPUT hp : POINTER TO INT := ADR(ga); END_VAR
VAR_EXTERNAL ga : INT; END_VAR
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_R
VAR_EXTERNAL fh : FB_H; END_VAR
METHOD Get : INT
Get := fh.hp^ * 10;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_K
METHOD Get : INT
Get := 4;
END_METHOD
END_FUNCTION_BLOCK
VAR_GLOBAL
  hk : FB_K;
  fx : FB_P;
  fh : FB_H;
  fr : FB_R;
  w : INT := fr.Get();
  ga : INT := hk.Get();
  x : INT := fx.Get();
  gb : INT := x * 2 + w;
END_VAR
PROGRAM Main
VAR_EXTERNAL x, gb : INT; END_VAR
VAR o1, o2 : INT; END_VAR
o1 := x; o2 := gb;
END_PROGRAM
`;

/**
 * `x` is declared before `g2` and its code reads `g2` through a pointer held
 * in a STRUCT field, an element, a FUNCTION input or output, an FB member
 * reached through a pointer, an interface method result, a MEMCPY copy (of
 * a pointer, and of an FB holding one) and a pointer alias: `x` is created
 * after `g2` in every case.
 */
const pointerCase = (decls: string, init: string) => `${decls}
FUNCTION_BLOCK FB_K
METHOD Get : INT
Get := 6;
END_METHOD
END_FUNCTION_BLOCK
VAR_GLOBAL
  hk : FB_K;
  x : INT := ${init};
  g2 : INT := hk.Get();
END_VAR
PROGRAM Main
VAR_EXTERNAL x : INT; END_VAR
VAR o1 : INT; END_VAR
o1 := x;
END_PROGRAM
`;
const POINTER_CASES: Record<string, string> = {
  structField: pointerCase(
    `TYPE ST : STRUCT p : POINTER TO INT; END_STRUCT END_TYPE
FUNCTION_BLOCK FB_A
VAR s : ST; END_VAR
VAR_EXTERNAL g2 : INT; END_VAR
METHOD Get : INT
s.p := ADR(g2);
Get := s.p^;
END_METHOD
END_FUNCTION_BLOCK
VAR_GLOBAL fa : FB_A; END_VAR`,
    "fa.Get()",
  ),
  element: pointerCase(
    `FUNCTION F : INT
VAR arr : ARRAY[0..2] OF POINTER TO INT; k : INT := 1; END_VAR
VAR_EXTERNAL g2 : INT; END_VAR
arr[1] := ADR(g2);
F := arr[k]^;
END_FUNCTION`,
    "F()",
  ),
  fnInput: pointerCase(
    `FUNCTION RD : INT
VAR_INPUT p : POINTER TO INT; END_VAR
RD := p^;
END_FUNCTION`,
    "RD(ADR(g2))",
  ),
  fnOutput: pointerCase(
    `FUNCTION MK : INT
VAR_OUTPUT o : POINTER TO INT; END_VAR
VAR_EXTERNAL g2 : INT; END_VAR
o := ADR(g2);
MK := 0;
END_FUNCTION
FUNCTION F : INT
VAR p : POINTER TO INT; END_VAR
MK(o => p);
F := p^;
END_FUNCTION`,
    "F()",
  ),
  memberThroughPointer: pointerCase(
    `FUNCTION_BLOCK FB_H
VAR hp : POINTER TO INT; END_VAR
VAR_EXTERNAL g2 : INT; END_VAR
METHOD Set : INT
hp := ADR(g2);
Set := 0;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION F : INT
VAR_EXTERNAL pfb : POINTER TO FB_H; END_VAR
pfb^.Set();
F := pfb^.hp^;
END_FUNCTION
VAR_GLOBAL fh : FB_H; pfb : POINTER TO FB_H := ADR(fh); END_VAR`,
    "F()",
  ),
  memberStoredThroughPointer: pointerCase(
    `FUNCTION_BLOCK FB_H
VAR hp : POINTER TO INT; END_VAR
END_FUNCTION_BLOCK
FUNCTION F : INT
VAR_EXTERNAL pfb : POINTER TO FB_H; g2 : INT; END_VAR
pfb^.hp := ADR(g2);
F := pfb^.hp^;
END_FUNCTION
VAR_GLOBAL fh : FB_H; pfb : POINTER TO FB_H := ADR(fh); END_VAR`,
    "F()",
  ),
  iface: pointerCase(
    `INTERFACE I_P
METHOD GetP : POINTER TO INT
END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB_H IMPLEMENTS I_P
VAR_EXTERNAL g2 : INT; END_VAR
METHOD GetP : POINTER TO INT
GetP := ADR(g2);
END_METHOD
END_FUNCTION_BLOCK
FUNCTION F : INT
VAR_EXTERNAL gi : I_P; END_VAR
VAR t : POINTER TO INT; END_VAR
t := gi.GetP();
F := t^;
END_FUNCTION
VAR_GLOBAL fh : FB_H; gi : I_P := fh; END_VAR`,
    "F()",
  ),
  memcpy: pointerCase(
    `FUNCTION F : INT
VAR_EXTERNAL src : POINTER TO INT; END_VAR
VAR q : POINTER TO INT; END_VAR
MEMCPY(ADR(q), ADR(src), SIZEOF(q));
F := q^;
END_FUNCTION
VAR_GLOBAL src : POINTER TO INT := ADR(g2); END_VAR`,
    "F()",
  ),
  memcpyFb: pointerCase(
    `FUNCTION_BLOCK FB_Y
VAR_OUTPUT yp : POINTER TO INT; END_VAR
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Z
VAR zp : POINTER TO INT; END_VAR
VAR_EXTERNAL g2 : INT; END_VAR
METHOD Set : INT
zp := ADR(g2);
Set := 0;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION F : INT
VAR_EXTERNAL fy : FB_Y; fz : FB_Z; END_VAR
fz.Set();
MEMCPY(ADR(fy), ADR(fz), SIZEOF(fy));
F := fy.yp^;
END_FUNCTION
VAR_GLOBAL fy : FB_Y; fz : FB_Z; END_VAR`,
    "F()",
  ),
  alias: pointerCase(
    `TYPE PI : POINTER TO INT; END_TYPE
FUNCTION_BLOCK FB_A
VAR p : PI; END_VAR
VAR_EXTERNAL g2 : INT; END_VAR
METHOD Get : INT
p := ADR(g2);
Get := p^;
END_METHOD
END_FUNCTION_BLOCK
VAR_GLOBAL fa : FB_A; END_VAR`,
    "fa.Get()",
  ),
};

describe.skipIf(!hasGpp)(
  "global creation traced through code — g++ e2e",
  () => {
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-gtrace-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    const run = (name: string, source: string, config: boolean): string => {
      const r = compile(source, { headerFileName: "generated.hpp" });
      expect(r.errors).toEqual([]);
      const program = config ? "cfg.INST" : "p";
      return compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: r.headerCode,
        cppCode: r.cppCode,
        testName: name,
        mainCode: `#include <iostream>
int main() {
  ${config ? "static strucpp::Configuration_CFG cfg;" : "strucpp::Program_MAIN p;"}
  ${program}.run();
  std::cout << (int)${program}.O1 << " " << (int)${program}.O2 << std::endl;
  return 0;
}
`,
      }).trim();
    };

    it("creates a CONFIGURATION global after the globals its FUNCTION reads", () => {
      expect(run("gtrace_cfg", CFG_CALLS, true)).toBe("10 12");
    });

    it("creates a list global after the CONFIGURATION global its FUNCTION reads", () => {
      expect(run("gtrace_list_cfg", LIST_READS_CFG, true)).toBe("10 5");
    });

    it("an interface global NULL during creation runs no implementer", () => {
      expect(run("gtrace_null_iface", NULL_INTERFACE, false)).toBe("7 8");
    });

    it("a pointer stored into a STRUCT field or an element does not widen another", () => {
      expect(run("gtrace_path_stores", PATH_STORES, false)).toBe("5 50");
    });

    it.each(Object.entries(POINTER_CASES))(
      "a pointer read through %s orders by what it may point to",
      (name, source) => {
        const r = compile(source, { headerFileName: "generated.hpp" });
        expect(r.errors).toEqual([]);
        const out = compileAndRunStandalone({
          tempDir,
          pchPath,
          headerCode: r.headerCode,
          cppCode: r.cppCode,
          testName: `gtrace_ptr_${name}`,
          mainCode: `#include <iostream>
int main() {
  strucpp::Program_MAIN p;
  p.run();
  std::cout << p.O1 << std::endl;
  return 0;
}
`,
        });
        expect(out.trim()).toBe("6");
      },
    );
  },
);
