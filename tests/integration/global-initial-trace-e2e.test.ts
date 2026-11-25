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

/**
 * List and CONFIGURATION globals created as one graph (also across two
 * CONFIGURATIONs and around the FB classes), PROGRAM code a global's
 * creation runs, and a raw copy through a REFERENCE TO input: each prints
 * the value a correct creation order gives.
 */
const ORDER_CASES: Array<{
  title: string;
  source: string;
  /** The C++ main body; the program Main's O1 by default. */
  main: string | undefined;
  features: string[];
  expected: string;
}> = [
  {
    title:
      "a CONFIGURATION global reading a list global that reads a CONFIGURATION global",
    source: `FUNCTION F : INT
VAR_EXTERNAL cnt : INT; END_VAR
cnt := cnt + 1;
F := 7;
END_FUNCTION
FUNCTION G : INT
VAR_EXTERNAL l : INT; END_VAR
G := l * 10;
END_FUNCTION
VAR_GLOBAL l : INT := F(); END_VAR
PROGRAM Main
VAR_EXTERNAL c2 : INT; l : INT; END_VAR
VAR o1, o2 : INT; END_VAR
o1 := c2; o2 := l;
END_PROGRAM
CONFIGURATION Cfg
VAR_GLOBAL c2 : INT := G(); cnt : INT; END_VAR
RESOURCE R ON PLC
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM inst WITH T : Main;
END_RESOURCE
END_CONFIGURATION
`,
    main: `static strucpp::Configuration_CFG cfg; cfg.INST.run(); std::cout << (int)cfg.INST.O1 << " " << (int)cfg.INST.O2 << std::endl;`,
    features: [],
    expected: "70 7",
  },
  {
    title: "a chain CONFIGURATION, list, CONFIGURATION",
    source: `FUNCTION_BLOCK FB_K
METHOD Get : INT
Get := 6;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION F : INT
VAR_EXTERNAL c : INT; END_VAR
F := c + 1;
END_FUNCTION
FUNCTION G : INT
VAR_EXTERNAL l : INT; END_VAR
G := l * 10;
END_FUNCTION
VAR_GLOBAL l : INT := F(); END_VAR
PROGRAM Main
VAR_EXTERNAL c2 : INT; l : INT; END_VAR
VAR o1, o2 : INT; END_VAR
o1 := c2; o2 := l;
END_PROGRAM
CONFIGURATION Cfg
VAR_GLOBAL c2 : INT := G(); c : INT := 5; END_VAR
RESOURCE R ON PLC
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM inst WITH T : Main;
END_RESOURCE
END_CONFIGURATION
`,
    main: `static strucpp::Configuration_CFG cfg; cfg.INST.run(); std::cout << (int)cfg.INST.O1 << " " << (int)cfg.INST.O2 << std::endl;`,
    features: [],
    expected: "60 6",
  },
  {
    title: "a CONFIGURATION global naming a list global that reads one",
    source: `FUNCTION F : INT
VAR_EXTERNAL dbg : BOOL; END_VAR
IF dbg THEN F := 1; ELSE F := 7; END_IF
END_FUNCTION
VAR_GLOBAL l : INT := F(); END_VAR
PROGRAM Main
VAR_EXTERNAL c2 : INT; l : INT; END_VAR
VAR o1, o2 : INT; END_VAR
o1 := c2; o2 := l;
END_PROGRAM
CONFIGURATION Cfg
VAR_GLOBAL c2 : INT := l * 10; dbg : BOOL; END_VAR
RESOURCE R ON PLC
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM inst WITH T : Main;
END_RESOURCE
END_CONFIGURATION
`,
    main: `static strucpp::Configuration_CFG cfg; cfg.INST.run(); std::cout << (int)cfg.INST.O1 << " " << (int)cfg.INST.O2 << std::endl;`,
    features: [],
    expected: "70 7",
  },
  {
    title: "a CONFIGURATION global reading a list global after an FB",
    source: `FUNCTION_BLOCK FB_K
METHOD Get : INT
Get := 6;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION F : INT
VAR_EXTERNAL lg : INT; END_VAR
F := lg * 2;
END_FUNCTION
VAR_GLOBAL hk : FB_K; lg : INT := hk.Get(); END_VAR
PROGRAM Main
VAR_EXTERNAL c : INT; lg : INT; END_VAR
VAR o1, o2 : INT; END_VAR
o1 := c; o2 := lg;
END_PROGRAM
CONFIGURATION Cfg
VAR_GLOBAL c : INT := F(); END_VAR
RESOURCE R ON PLC
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM inst WITH T : Main;
END_RESOURCE
END_CONFIGURATION
`,
    main: `static strucpp::Configuration_CFG cfg; cfg.INST.run(); std::cout << (int)cfg.INST.O1 << " " << (int)cfg.INST.O2 << std::endl;`,
    features: [],
    expected: "12 6",
  },
  {
    title: "a CONFIGURATION global calling a method of a list FB",
    source: `FUNCTION_BLOCK FB_K
VAR v : INT := 6; END_VAR
METHOD Get : INT
Get := v;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION F : INT
VAR_EXTERNAL lfb : FB_K; END_VAR
F := lfb.Get();
END_FUNCTION
VAR_GLOBAL lfb : FB_K; END_VAR
PROGRAM Main
VAR_EXTERNAL c : INT; END_VAR
VAR o1, o2 : INT; END_VAR
o1 := c; o2 := 0;
END_PROGRAM
CONFIGURATION Cfg
VAR_GLOBAL c : INT := F(); END_VAR
RESOURCE R ON PLC
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM inst WITH T : Main;
END_RESOURCE
END_CONFIGURATION
`,
    main: `static strucpp::Configuration_CFG cfg; cfg.INST.run(); std::cout << (int)cfg.INST.O1 << " " << (int)cfg.INST.O2 << std::endl;`,
    features: [],
    expected: "6 0",
  },
  {
    title:
      "a CONFIGURATION global naming a list global created after the FB classes",
    source: `FUNCTION_BLOCK FB_K
METHOD Get : INT
Get := 6;
END_METHOD
END_FUNCTION_BLOCK
VAR_GLOBAL hk : FB_K; lg : INT := hk.Get(); END_VAR
PROGRAM Main
VAR_EXTERNAL c : INT; lg : INT; END_VAR
VAR o1, o2 : INT; END_VAR
o1 := c; o2 := lg;
END_PROGRAM
CONFIGURATION Cfg
VAR_GLOBAL c : INT := lg; END_VAR
RESOURCE R ON PLC
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM inst WITH T : Main;
END_RESOURCE
END_CONFIGURATION
`,
    main: `static strucpp::Configuration_CFG cfg; cfg.INST.run(); std::cout << (int)cfg.INST.O1 << " " << (int)cfg.INST.O2 << std::endl;`,
    features: [],
    expected: "6 6",
  },
  {
    title: "a CONFIGURATION global calling a list FB's method directly",
    source: `FUNCTION_BLOCK FB_K
METHOD Get : INT
Get := 6;
END_METHOD
END_FUNCTION_BLOCK
VAR_GLOBAL hk : FB_K; lg : INT := hk.Get(); END_VAR
PROGRAM Main
VAR_EXTERNAL c : INT; lg : INT; END_VAR
VAR o1, o2 : INT; END_VAR
o1 := c; o2 := lg;
END_PROGRAM
CONFIGURATION Cfg
VAR_GLOBAL c : INT := hk.Get(); END_VAR
RESOURCE R ON PLC
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM inst WITH T : Main;
END_RESOURCE
END_CONFIGURATION
`,
    main: `static strucpp::Configuration_CFG cfg; cfg.INST.run(); std::cout << (int)cfg.INST.O1 << " " << (int)cfg.INST.O2 << std::endl;`,
    features: [],
    expected: "6 6",
  },
  {
    title: "a global of one CONFIGURATION reading one of another",
    source: `FUNCTION_BLOCK FB_K
METHOD Get : INT
Get := 6;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION F : INT
VAR_EXTERNAL b : INT; END_VAR
F := b * 2;
END_FUNCTION
VAR_GLOBAL hk : FB_K; END_VAR
PROGRAM Main
VAR_EXTERNAL a : INT; END_VAR
VAR o1 : INT; END_VAR
o1 := a;
END_PROGRAM
PROGRAM Main2
VAR_EXTERNAL b : INT; END_VAR
VAR o1 : INT; END_VAR
o1 := b;
END_PROGRAM
CONFIGURATION CfgA
VAR_GLOBAL a : INT := F(); END_VAR
RESOURCE R ON PLC
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM inst WITH T : Main;
END_RESOURCE
END_CONFIGURATION
CONFIGURATION CfgB
VAR_GLOBAL b : INT := 21; END_VAR
RESOURCE R2 ON PLC
TASK T2(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM inst2 WITH T2 : Main2;
END_RESOURCE
END_CONFIGURATION
`,
    main: `static strucpp::Configuration_CFGA cfg; cfg.INST.run(); std::cout << (int)cfg.INST.O1 << std::endl;`,
    features: [],
    expected: "42",
  },
  {
    title: "an interface set by a PROGRAM method an FB method calls",
    source: `INTERFACE I_X
METHOD M : INT
END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB_X IMPLEMENTS I_X
VAR_EXTERNAL g2 : INT; END_VAR
METHOD M : INT
M := g2 + 1;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_K
METHOD Get : INT
Get := 6;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Setup
VAR_EXTERNAL gi : I_X; fx : FB_X; END_VAR
METHOD Go : INT
gi := fx;
Go := 0;
END_METHOD
END_PROGRAM
FUNCTION_BLOCK FB_S
METHOD Run : INT
Run := Setup.Go();
END_METHOD
END_FUNCTION_BLOCK
FUNCTION F : INT
VAR_EXTERNAL gi : I_X; END_VAR
IF gi <> 0 THEN F := gi.M(); ELSE F := 99; END_IF
END_FUNCTION
VAR_GLOBAL
  gi : I_X;
  fx : FB_X;
  hk : FB_K;
  fs : FB_S;
  s : INT := fs.Run();
  x : INT := F();
  g2 : INT := hk.Get();
END_VAR
PROGRAM Main
VAR_EXTERNAL x : INT; END_VAR
VAR o1 : INT; END_VAR
o1 := x;
Setup();
END_PROGRAM
`,
    main: undefined,
    features: ["+program_methods"],
    expected: "7",
  },
  {
    title: "an interface set by a PROGRAM method a FUNCTION calls",
    source: `INTERFACE I_X
METHOD M : INT
END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB_X IMPLEMENTS I_X
VAR_EXTERNAL g2 : INT; END_VAR
METHOD M : INT
M := g2 + 1;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_K
METHOD Get : INT
Get := 6;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Setup
VAR_EXTERNAL gi : I_X; fx : FB_X; END_VAR
METHOD Go : INT
gi := fx;
Go := 0;
END_METHOD
END_PROGRAM
FUNCTION F : INT
VAR_EXTERNAL gi : I_X; END_VAR
Setup.Go();
IF gi <> 0 THEN F := gi.M(); ELSE F := 99; END_IF
END_FUNCTION
VAR_GLOBAL
  gi : I_X;
  fx : FB_X;
  hk : FB_K;
  x : INT := F();
  g2 : INT := hk.Get();
END_VAR
PROGRAM Main
VAR_EXTERNAL x : INT; END_VAR
VAR o1 : INT; END_VAR
o1 := x;
Setup();
END_PROGRAM
`,
    main: undefined,
    features: ["+program_methods"],
    expected: "7",
  },
  {
    title: "an interface set by a PROGRAM body a FUNCTION calls",
    source: `INTERFACE I_X
METHOD M : INT
END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB_X IMPLEMENTS I_X
VAR_EXTERNAL g2 : INT; END_VAR
METHOD M : INT
M := g2 + 1;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_K
METHOD Get : INT
Get := 6;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Setup
VAR_EXTERNAL gi : I_X; fx : FB_X; END_VAR
gi := fx;
END_PROGRAM
FUNCTION F : INT
VAR_EXTERNAL gi : I_X; END_VAR
Setup();
IF gi <> 0 THEN F := gi.M(); ELSE F := 99; END_IF
END_FUNCTION
VAR_GLOBAL
  gi : I_X;
  fx : FB_X;
  hk : FB_K;
  x : INT := F();
  g2 : INT := hk.Get();
END_VAR
PROGRAM Main
VAR_EXTERNAL x : INT; END_VAR
VAR o1 : INT; END_VAR
o1 := x;
END_PROGRAM
`,
    main: undefined,
    features: ["+program_methods"],
    expected: "7",
  },
  {
    title: "an interface set by a PROGRAM action a FUNCTION calls",
    source: `INTERFACE I_X
METHOD M : INT
END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB_X IMPLEMENTS I_X
VAR_EXTERNAL g2 : INT; END_VAR
METHOD M : INT
M := g2 + 1;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_K
METHOD Get : INT
Get := 6;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Setup
VAR_EXTERNAL gi : I_X; fx : FB_X; END_VAR
ACTION Go:
gi := fx;
END_ACTION
END_PROGRAM
FUNCTION F : INT
VAR_EXTERNAL gi : I_X; END_VAR
Setup.Go();
IF gi <> 0 THEN F := gi.M(); ELSE F := 99; END_IF
END_FUNCTION
VAR_GLOBAL
  gi : I_X;
  fx : FB_X;
  hk : FB_K;
  x : INT := F();
  g2 : INT := hk.Get();
END_VAR
PROGRAM Main
VAR_EXTERNAL x : INT; END_VAR
VAR o1 : INT; END_VAR
o1 := x;
END_PROGRAM
`,
    main: undefined,
    features: ["+program_methods"],
    expected: "7",
  },
  {
    title: "a global read by a PROGRAM a FUNCTION calls",
    source: `FUNCTION_BLOCK FB_K
METHOD Get : INT
Get := 6;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Setup
VAR_EXTERNAL g2 : INT; END_VAR
VAR_OUTPUT o : INT; END_VAR
o := g2;
END_PROGRAM
FUNCTION F : INT
Setup();
F := Setup.o;
END_FUNCTION
VAR_GLOBAL
  hk : FB_K;
  x : INT := F();
  g2 : INT := hk.Get();
END_VAR
PROGRAM Main
VAR_EXTERNAL x : INT; END_VAR
VAR o1 : INT; END_VAR
o1 := x;
END_PROGRAM
`,
    main: undefined,
    features: ["+program_methods"],
    expected: "6",
  },
  {
    title: "MEMCPY into an FB through a REFERENCE TO input",
    source: `FUNCTION_BLOCK FB_Y
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
FUNCTION CopyIn : INT
VAR_INPUT dst : REFERENCE TO FB_Y; END_VAR
VAR_EXTERNAL fz : FB_Z; END_VAR
MEMCPY(ADR(dst), ADR(fz), SIZEOF(fz));
CopyIn := 0;
END_FUNCTION
FUNCTION F : INT
VAR_EXTERNAL fy : FB_Y; fz : FB_Z; END_VAR
fz.Set();
CopyIn(fy);
F := fy.yp^;
END_FUNCTION
VAR_GLOBAL fy : FB_Y; fz : FB_Z; END_VAR
FUNCTION_BLOCK FB_K
METHOD Get : INT
Get := 6;
END_METHOD
END_FUNCTION_BLOCK
VAR_GLOBAL
  hk : FB_K;
  x : INT := F();
  g2 : INT := hk.Get();
END_VAR
PROGRAM Main
VAR_EXTERNAL x : INT; END_VAR
VAR o1 : INT; END_VAR
o1 := x;
END_PROGRAM
`,
    main: undefined,
    features: [],
    expected: "6",
  },
  {
    title: "RESOURCE globals a list and a CONFIGURATION global read",
    source: `FUNCTION F : INT
VAR_EXTERNAL k : INT; END_VAR
F := k * 2;
END_FUNCTION
FUNCTION G : INT
VAR_EXTERNAL rg : INT; END_VAR
G := rg + 1;
END_FUNCTION
VAR_GLOBAL l : INT := G(); END_VAR
PROGRAM Main
VAR_EXTERNAL c : INT; l : INT; END_VAR
VAR o1, o2 : INT; END_VAR
o1 := c; o2 := l;
END_PROGRAM
CONFIGURATION Cfg
VAR_GLOBAL c : INT := F(); END_VAR
RESOURCE R ON PLC
VAR_GLOBAL k : INT := 5; rg : INT := 8; END_VAR
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM inst WITH T : Main;
END_RESOURCE
END_CONFIGURATION
`,
    main: `static strucpp::Configuration_CFG cfg; cfg.INST.run(); std::cout << (int)cfg.INST.O1 << " " << (int)cfg.INST.O2 << std::endl;`,
    features: [],
    expected: "10 9",
  },
  {
    title: "a PROGRAM's VAR initial values before a global its call reads",
    source: `PROGRAM Setup
VAR k : INT := 5; arr : ARRAY[1..2] OF INT := [10, 20]; s : STRING := 'abc'; END_VAR
VAR_OUTPUT o : INT; END_VAR
o := k + arr[2] + LEN(s);
k := k + 1;
END_PROGRAM
FUNCTION F : INT
Setup();
F := Setup.o;
END_FUNCTION
VAR_GLOBAL
  x : INT := F();
END_VAR
PROGRAM Main
VAR_EXTERNAL x : INT; END_VAR
VAR o1 : INT; END_VAR
Setup();
o1 := x * 100 + Setup.o;
END_PROGRAM
`,
    main: undefined,
    features: ["+program_methods"],
    expected: "2829",
  },
  {
    title: "a PROGRAM's FB member before a global its call reads",
    source: `FUNCTION_BLOCK FB_K
VAR n : INT := 6; END_VAR
METHOD Get : INT
Get := n;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Setup
VAR fk : FB_K; END_VAR
VAR_OUTPUT o : INT; END_VAR
o := fk.Get();
END_PROGRAM
FUNCTION F : INT
Setup();
F := Setup.o;
END_FUNCTION
VAR_GLOBAL
  x : INT := F();
END_VAR
PROGRAM Main
VAR_EXTERNAL x : INT; END_VAR
VAR o1 : INT; END_VAR
o1 := x;
END_PROGRAM
`,
    main: undefined,
    features: ["+program_methods"],
    expected: "6",
  },
  {
    title:
      "a PROGRAM with a CONFIGURATION VAR_EXTERNAL called by a list global",
    source: `PROGRAM Setup
VAR_EXTERNAL cg : INT; END_VAR
VAR_OUTPUT o : INT; END_VAR
o := cg * 2;
END_PROGRAM
FUNCTION F : INT
Setup();
F := Setup.o;
END_FUNCTION
VAR_GLOBAL x : INT := F(); END_VAR
PROGRAM Main
VAR_EXTERNAL x : INT; END_VAR
VAR o1 : INT; END_VAR
o1 := x;
END_PROGRAM
CONFIGURATION Cfg
VAR_GLOBAL cg : INT := 21; END_VAR
RESOURCE R ON PLC
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM inst WITH T : Main;
END_RESOURCE
END_CONFIGURATION
`,
    main: `static strucpp::Configuration_CFG cfg; cfg.INST.run(); std::cout << (int)cfg.INST.O1 << std::endl;`,
    features: ["+program_methods"],
    expected: "42",
  },
  {
    title: "a PROGRAM called from an FB global's method",
    source: `PROGRAM Setup
VAR k : INT := 5; END_VAR
VAR_OUTPUT o : INT; END_VAR
o := k;
END_PROGRAM
FUNCTION_BLOCK FB_K
METHOD Get : INT
Setup();
Get := Setup.o;
END_METHOD
END_FUNCTION_BLOCK
VAR_GLOBAL
  hk : FB_K;
  x : INT := hk.Get();
END_VAR
PROGRAM Main
VAR_EXTERNAL x : INT; END_VAR
VAR o1 : INT; END_VAR
o1 := x;
END_PROGRAM
`,
    main: undefined,
    features: ["+program_methods"],
    expected: "5",
  },
  {
    title: "two PROGRAMs calling each other while a global is created",
    source: `FUNCTION_BLOCK FB_K
METHOD Get : INT
Get := 6;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM PA
VAR_EXTERNAL g2 : INT; END_VAR
VAR_INPUT n : INT; END_VAR
VAR_OUTPUT o : INT; END_VAR
IF n > 0 THEN PB(n := n - 1); o := PB.o; ELSE o := g2; END_IF
END_PROGRAM
PROGRAM PB
VAR_INPUT n : INT; END_VAR
VAR_OUTPUT o : INT; END_VAR
PA(n := n);
o := PA.o + 1;
END_PROGRAM
FUNCTION F : INT
PA(n := 2);
F := PA.o;
END_FUNCTION
VAR_GLOBAL
  hk : FB_K;
  x : INT := F();
  g2 : INT := hk.Get();
END_VAR
PROGRAM Main
VAR_EXTERNAL x : INT; END_VAR
VAR o1 : INT; END_VAR
o1 := x;
END_PROGRAM
`,
    main: undefined,
    features: ["+program_methods"],
    expected: "8",
  },
  {
    title:
      "a PROGRAM method a global's initial value calls and nothing else names",
    source: `PROGRAM Setup
VAR_OUTPUT o : INT := 4; END_VAR
METHOD Go : INT
o := o + 1;
Go := o;
END_METHOD
END_PROGRAM
FUNCTION F : INT
F := 2;
END_FUNCTION
VAR_GLOBAL
  s : INT := Setup.Go();
  t : INT := F();
END_VAR
PROGRAM Main
VAR_EXTERNAL s : INT; t : INT; END_VAR
VAR O1 : INT; END_VAR
O1 := s * 10 + t;
END_PROGRAM
`,
    main: undefined,
    features: ["+program_methods"],
    expected: "52",
  },
  {
    title: "a store-before-read preference that would close a cycle is dropped",
    source: `FUNCTION FE : INT
VAR_EXTERNAL g : INT; L : INT; END_VAR
g := 5;
FE := L;
END_FUNCTION
FUNCTION FL : INT
VAR_EXTERNAL g : INT; END_VAR
FL := g;
END_FUNCTION
VAR_GLOBAL
  g : INT := 1;
  E : INT := FE();
  L : INT := FL();
END_VAR
PROGRAM Main
VAR_EXTERNAL E : INT; L : INT; g : INT; END_VAR
VAR O1 : INT; END_VAR
O1 := E * 100 + L * 10 + g;
END_PROGRAM
`,
    main: undefined,
    features: [],
    expected: "115",
  },
  {
    title: "an interface global bound to an instance whose FB_init has work",
    source: `INTERFACE IGet
METHOD Get : INT
END_METHOD
END_INTERFACE
FUNCTION_BLOCK FBK IMPLEMENTS IGet
VAR n : INT := 6; END_VAR
METHOD FB_init : BOOL
VAR_INPUT bInitRetains : BOOL; bInCopyCode : BOOL; END_VAR
n := 60;
END_METHOD
METHOD Get : INT
Get := n;
END_METHOD
END_FUNCTION_BLOCK
VAR_GLOBAL inst : FBK; itf : IGet := inst; END_VAR
PROGRAM Main
VAR_EXTERNAL itf : IGet; END_VAR
VAR O1 : INT; END_VAR
O1 := itf.Get();
END_PROGRAM
`,
    main: undefined,
    features: ["+fb_init"],
    expected: "60",
  },
  {
    title: "an interface bound to an instance with FB_init, read by nothing",
    source: `INTERFACE IGet
METHOD Get : INT
END_METHOD
END_INTERFACE
FUNCTION_BLOCK FBK IMPLEMENTS IGet
VAR n : INT := 6; END_VAR
METHOD FB_init : BOOL
VAR_INPUT bInitRetains : BOOL; bInCopyCode : BOOL; END_VAR
n := 60;
END_METHOD
METHOD Get : INT
Get := n;
END_METHOD
END_FUNCTION_BLOCK
VAR_GLOBAL inst : FBK; itf : IGet := inst; g : INT := 1; END_VAR
PROGRAM Main
VAR_EXTERNAL g : INT; END_VAR
VAR O1 : INT; END_VAR
O1 := g;
END_PROGRAM
`,
    main: undefined,
    features: ["+fb_init"],
    expected: "1",
  },
  {
    title:
      "FB_init of a global created after a PROGRAM instance through another global",
    source: `FUNCTION_BLOCK FBG
VAR_INPUT a : INT; END_VAR
VAR_OUTPUT v : INT; END_VAR
METHOD FB_init : BOOL
VAR_INPUT bInitRetains : BOOL; bInCopyCode : BOOL; END_VAR
v := 50;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Setup
VAR_OUTPUT o : INT := 7; END_VAR
o := o + 1;
END_PROGRAM
FUNCTION F : INT
Setup();
F := Setup.o;
END_FUNCTION
VAR_GLOBAL
  y : INT := F();
  gfb : FBG := (a := y);
END_VAR
PROGRAM Main
VAR_EXTERNAL gfb : FBG; END_VAR
VAR O1 : INT; END_VAR
O1 := gfb.v;
END_PROGRAM
`,
    main: undefined,
    features: ["+fb_init", "+program_methods"],
    expected: "50",
  },
  {
    title:
      "FB_init of a global created after a PROGRAM instance it uses directly",
    source: `FUNCTION_BLOCK FBG
VAR_INPUT a : INT; END_VAR
VAR_OUTPUT v : INT; END_VAR
METHOD FB_init : BOOL
VAR_INPUT bInitRetains : BOOL; bInCopyCode : BOOL; END_VAR
v := 50;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Setup
VAR_OUTPUT o : INT := 7; END_VAR
o := o + 1;
END_PROGRAM
FUNCTION F : INT
Setup();
F := Setup.o;
END_FUNCTION
VAR_GLOBAL
  y : INT := F();
  gfb : FBG := (a := F());
END_VAR
PROGRAM Main
VAR_EXTERNAL gfb : FBG; END_VAR
VAR O1 : INT; END_VAR
O1 := gfb.v;
END_PROGRAM
`,
    main: undefined,
    features: ["+fb_init", "+program_methods"],
    expected: "50",
  },
];

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

    it.each(ORDER_CASES)(
      "$title",
      ({ title, source, main, features, expected }) => {
        const r = compile(source, {
          headerFileName: "generated.hpp",
          features,
        });
        expect(r.errors).toEqual([]);
        const out = compileAndRunStandalone({
          tempDir,
          pchPath,
          headerCode: r.headerCode,
          cppCode: r.cppCode,
          testName: `gtrace_order_${ORDER_CASES.findIndex((c) => c.title === title)}`,
          mainCode: `#include <iostream>
int main() {
  ${main ?? "strucpp::Program_MAIN p; p.run(); std::cout << (int)p.O1 << std::endl;"}
  return 0;
}
`,
        });
        expect(out.trim()).toBe(expected);
      },
    );

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
