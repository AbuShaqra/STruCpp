// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: interface, property and call-result forms that passed the check and
 * then failed in g++ (or were not parsed): `itf = fb`, a VAR_INST receiver,
 * `FP()^`, `F().M();`, selectors after `THIS^.M()`, interface receivers in
 * member chains and EXTENDS, property bits, `j.PJ.M()`, `h.P^`, a parameter
 * named like its STRUCT, a STRUCT default `GC.3`, and `s.f.M()` with a library
 * STRUCT and FB. g++ and run.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile, compileStlib } from "../../src/index.js";
import { loadStlibArchive } from "../../src/library/library-loader.js";
import { discoverStlibs } from "../../src/node/library-loader.js";
import type { StlibArchive } from "../../src/library/library-manifest.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

interface Case {
  title: string;
  name: string;
  features: string[];
  source: string;
  main: string;
  expected: string;
}

const CASES: Case[] = [
  {
    title: "compares an interface with the instance it refers to",
    name: "oop_c1",
    features: [],
    source: `INTERFACE I_A
  METHOD Get : INT
  END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB_A IMPLEMENTS I_A
  METHOD Get : INT
    Get := 7;
  END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main
VAR
  fb : FB_A; fb2 : FB_A;
  itf : I_A;
  b1, b2 : BOOL;
END_VAR
itf := fb;
b1 := itf = fb;
b2 := itf <> fb2;
END_PROGRAM
`,
    main: "Program_MAIN p; p.run(); std::cout << (int)p.B1 << (int)p.B2;",
    expected: "11",
  },
  {
    title: "calls a method on a method's VAR_INST instance",
    name: "oop_c2",
    features: [],
    source: `FUNCTION_BLOCK FB_C
VAR_OUTPUT n : INT; END_VAR
  METHOD Bump : INT
    n := n + 1;
    Bump := n;
  END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_H
VAR_OUTPUT r : INT; END_VAR
  METHOD Tick : INT
  VAR_INST cnt : FB_C; END_VAR
    cnt.Bump();
    Tick := cnt.Bump();
    r := cnt.n;
  END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main
VAR h : FB_H; x : INT; END_VAR
h.Tick();
x := h.Tick();
END_PROGRAM
`,
    main: 'Program_MAIN p; p.run(); std::cout << (int)p.X << " " << (int)p.H.R;',
    expected: "4 4",
  },
  {
    title: "reads and writes through ^ after a FUNCTION call",
    name: "oop_c5",
    features: ["+call_result_access"],
    source: `TYPE S : STRUCT x : INT; y : INT; END_STRUCT END_TYPE
VAR_GLOBAL gs : S := (x := 4, y := 5); END_VAR
FUNCTION FP : POINTER TO S
FP := ADR(gs);
END_FUNCTION
PROGRAM Main
VAR a : INT; END_VAR
a := FP()^.x;
FP()^.y := 9;
END_PROGRAM
`,
    main: 'Program_MAIN p; p.run(); std::cout << (int)p.A << " " << (int)GS.Y;',
    expected: "4 9",
  },
  {
    title:
      "reads and writes through ^ after FUNCTION and METHOD calls, a bit included",
    name: "oop_c5b",
    features: ["+call_result_access"],
    source: `TYPE S : STRUCT x : INT; y : INT; END_STRUCT END_TYPE
VAR_GLOBAL gi : INT := 6; gs : S; END_VAR
FUNCTION FPI : POINTER TO INT
FPI := ADR(gi);
END_FUNCTION
FUNCTION FRI : REF_TO INT
FRI := REF(gi);
END_FUNCTION
FUNCTION_BLOCK FB
  METHOD MP : POINTER TO S
    MP := ADR(gs);
  END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main
VAR a, b, c : INT; f : FB; bb : BOOL; p : POINTER TO INT; END_VAR
a := FPI()^ + 1;
FPI()^ := 13;
b := FRI()^;
f.MP()^.x := 21;
c := f.MP()^.x + gs.x;
bb := FPI()^.0;
END_PROGRAM
`,
    main: 'Program_MAIN p; p.run(); std::cout << (int)p.A << " " << (int)p.B << " " << (int)p.C << (int)p.BB;',
    expected: "7 13 421",
  },
  {
    title: "calls a method on a call result as a statement",
    name: "oop_c6",
    features: [],
    source: `INTERFACE I_C
  METHOD Inc : INT
  END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB_C IMPLEMENTS I_C
VAR_OUTPUT n : INT; END_VAR
  METHOD Inc : INT
    n := n + 1; Inc := n;
  END_METHOD
  METHOD Self : I_C
    Self := THIS^;
  END_METHOD
END_FUNCTION_BLOCK
VAR_GLOBAL g : FB_C; END_VAR
FUNCTION GetC : I_C
GetC := g;
END_FUNCTION
PROGRAM Main
VAR x : INT; END_VAR
GetC().Inc();
GetC().Inc();
g.Self().Inc();
x := GetC().Inc();
END_PROGRAM
`,
    main: 'Program_MAIN p; p.run(); std::cout << (int)p.X << " " << (int)G.N;',
    expected: "4 4",
  },
  {
    title: "takes selectors after THIS^.M() and SUPER^.M()",
    name: "oop_c7",
    features: ["+call_result_access", "+self_caret"],
    source: `TYPE S : STRUCT x : INT; y : INT; END_STRUCT END_TYPE
INTERFACE I_C
  METHOD Inc : INT
  END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB_B
  METHOD Base : S
    Base.x := 30;
  END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_C EXTENDS FB_B IMPLEMENTS I_C
VAR_OUTPUT n : INT; a : INT; b : INT; c : INT; END_VAR
  METHOD Inc : INT
    n := n + 1; Inc := n;
  END_METHOD
  METHOD Self : I_C
    Self := THIS^;
  END_METHOD
  METHOD GetS : S
    GetS.x := 7; GetS.y := 8;
  END_METHOD
  METHOD Run
    THIS^.Self().Inc();
    THIS.Self().Inc();
    a := THIS^.GetS().y + THIS.GetS().x;
    b := THIS^.Self().Inc();
    c := SUPER^.Base().x;
  END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main
VAR f : FB_C; END_VAR
f.Run();
END_PROGRAM
`,
    main: 'Program_MAIN p; p.run(); std::cout << (int)p.F.N << " " << (int)p.F.A << " " << (int)p.F.B << " " << (int)p.F.C;',
    expected: "3 15 3 30",
  },
  {
    title: "calls through interface results, elements and member chains",
    name: "oop_c8c",
    features: [],
    source: `INTERFACE I_M
  METHOD M : INT
  VAR_INPUT a : INT; END_VAR
  END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB_M IMPLEMENTS I_M
  METHOD M : INT
  VAR_INPUT a : INT; END_VAR
    M := a;
  END_METHOD
  METHOD Me : I_M
    Me := THIS^;
  END_METHOD
END_FUNCTION_BLOCK
TYPE S : STRUCT f : FB_M; END_STRUCT END_TYPE
VAR_GLOBAL gs : S; END_VAR
FUNCTION GetI : I_M
GetI := gs.f;
END_FUNCTION
PROGRAM Main
VAR fb : FB_M; x : INT; i : I_M; arr : ARRAY[1..2] OF I_M; END_VAR
fb.Me().M(1);
x := fb.Me().M(2);
x := GetI().M(3);
GetI().M(4);

x := gs.f.Me().M(7);
arr[1] := fb;
x := arr[1].M(6) + fb.Me().M(2);
END_PROGRAM
`,
    main: "Program_MAIN p; p.run(); std::cout << (int)p.X;",
    expected: "8",
  },
  {
    title: "binds a VAR_OUTPUT of a method an interface inherits",
    name: "oop_c10",
    features: [],
    source: `INTERFACE I_X
  METHOD M : INT
  VAR_INPUT a : INT; END_VAR
  VAR_OUTPUT o : INT; END_VAR
  END_METHOD
END_INTERFACE
INTERFACE I_Y EXTENDS I_X
  METHOD K : INT
  END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB_Y IMPLEMENTS I_Y
  METHOD M : INT
  VAR_INPUT a : INT; END_VAR
  VAR_OUTPUT o : INT; END_VAR
    o := a * 2; M := a + 1;
  END_METHOD
  METHOD K : INT
    K := 3;
  END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main
VAR fb : FB_Y; iy : I_Y; x, y, z : INT; END_VAR
iy := fb;
x := iy.M(8);
iy.M(a := 5, o => y);
z := iy.M(a := 1, o => y) + iy.K();
END_PROGRAM
`,
    main: 'Program_MAIN p; p.run(); std::cout << (int)p.X << " " << (int)p.Y << " " << (int)p.Z;',
    expected: "9 2 5",
  },
  {
    title: "reads a bit of a property and a constant's bit in a STRUCT default",
    name: "oop_c11",
    features: [],
    source: `VAR_GLOBAL CONSTANT GC : WORD := 16#0018; END_VAR
TYPE S : STRUCT f1 : BOOL := GC.3; f2 : BOOL := GC.0; END_STRUCT END_TYPE
FUNCTION_BLOCK FB_P
VAR w : WORD := 16#0010; END_VAR
  PROPERTY P : WORD
    GET
      P := w;
    END_GET
  END_PROPERTY
END_FUNCTION_BLOCK
PROGRAM Main
VAR fb : FB_P; b1, b2 : BOOL; s : S; END_VAR
b1 := fb.P.4;
b2 := fb.P.3;
END_PROGRAM
`,
    main: "Program_MAIN p; p.run(); std::cout << (int)p.B1 << (int)p.B2 << (int)p.S_.F1 << (int)p.S_.F2;",
    expected: "1010",
  },
  {
    title: "reads and writes bits of a property, own and of an instance",
    name: "oop_c11e",
    features: [],
    source: `FUNCTION_BLOCK FB_P
VAR w : WORD := 16#0010; END_VAR
VAR_OUTPUT b : BOOL; c : BOOL; END_VAR
  PROPERTY P : WORD
    GET
      P := w;
    END_GET
    SET
      w := P;
    END_SET
  END_PROPERTY
b := THIS.P.4;
c := P.4;
P.1 := TRUE;
THIS.P.2 := TRUE;
END_FUNCTION_BLOCK
PROGRAM Main
VAR fb : FB_P; END_VAR
fb();
fb.P.0 := TRUE;
END_PROGRAM
`,
    main: 'Program_MAIN p; p.run(); std::cout << (int)p.FB.B << (int)p.FB.C << " " << (int)p.FB.get_P();',
    expected: "11 23",
  },
  {
    title: "calls a method through an interface-typed property",
    name: "oop_c12",
    features: [],
    source: `INTERFACE I_M
  METHOD M : INT
  VAR_INPUT a : INT; END_VAR
  END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB_M IMPLEMENTS I_M
  METHOD M : INT
  VAR_INPUT a : INT; END_VAR
    M := a * 3;
  END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_J
VAR inner : FB_M; END_VAR
  PROPERTY PJ : I_M
    GET
      PJ := inner;
    END_GET
  END_PROPERTY
  PROPERTY PF : FB_M
    GET
      PF := inner;
    END_GET
  END_PROPERTY
END_FUNCTION_BLOCK
PROGRAM Main
VAR j : FB_J; x, y : INT; END_VAR
x := j.PJ.M(2);
j.PJ.M(4);
y := j.PF.M(5);
END_PROGRAM
`,
    main: 'Program_MAIN p; p.run(); std::cout << (int)p.X << " " << (int)p.Y;',
    expected: "6 15",
  },
  {
    title: "names a parameter like its STRUCT type",
    name: "oop_c13",
    features: [],
    source: `TYPE MyS : STRUCT a : INT; END_STRUCT END_TYPE
FUNCTION F1 : INT
VAR_INPUT MyS : MyS; END_VAR
F1 := MyS.a;
END_FUNCTION
FUNCTION F2 : INT
VAR_IN_OUT MyS : MyS; END_VAR
MyS.a := MyS.a + 1;
F2 := MyS.a;
END_FUNCTION
FUNCTION_BLOCK FB
VAR_INPUT MyS : MyS; END_VAR
VAR_OUTPUT o : INT; END_VAR
  METHOD M : INT
  VAR_INPUT MyS : MyS; END_VAR
    M := MyS.a * 10;
  END_METHOD
o := MyS.a;
END_FUNCTION_BLOCK
PROGRAM Main
VAR s : MyS := (a := 4); x, y, z, w : INT; fb : FB; END_VAR
x := F1(s);
y := F2(s);
fb(MyS := s);
z := fb.o;
w := fb.M(s);
w := w + F1(MyS := s);
END_PROGRAM
`,
    main: 'Program_MAIN p; p.run(); std::cout << (int)p.X << " " << (int)p.Y << " " << (int)p.Z << " " << (int)p.W;',
    expected: "4 5 5 55",
  },
  {
    title: "binds alias in-outs of an interface METHOD called through elements",
    name: "oop_c14c",
    features: [],
    source: `TYPE MyI : INT; END_TYPE
TYPE MyStr : STRING(20); END_TYPE
INTERFACE I_A
  METHOD M : INT
  VAR_IN_OUT v : MyI; s : MyStr; END_VAR
  END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB_A IMPLEMENTS I_A
  METHOD M : INT
  VAR_IN_OUT v : MyI; s : MyStr; END_VAR
    v := v + 1; s := CONCAT(s, 'x');
    M := v;
  END_METHOD
END_FUNCTION_BLOCK
TYPE SH : STRUCT i : I_A; END_STRUCT END_TYPE
PROGRAM Main
VAR fb : FB_A; arr : ARRAY[1..1] OF I_A; h : SH; x : MyI := 4; y : INT; st : STRING(20) := 'a'; s2 : MyStr; n : INT; i2 : INT; END_VAR
arr[1] := fb; h.i := fb;
y := arr[1].M(x, st);
arr[1].M(x, s2);
h.i.M(v := x, s := st);
h.i.M(i2, st);
n := LEN(st);
END_PROGRAM
`,
    main: 'Program_MAIN p; p.run(); std::cout << (int)p.X << " " << (int)p.Y << " " << (int)p.N;',
    expected: "7 5 4",
  },
  {
    title: "reads and writes through a POINTER TO property",
    name: "oop_c16",
    features: [],
    source: `TYPE S : STRUCT a : INT; END_STRUCT END_TYPE
FUNCTION_BLOCK FB_H
VAR v : INT := 5; s : S; END_VAR
  PROPERTY P : POINTER TO INT
    GET
      P := ADR(v);
    END_GET
  END_PROPERTY
  PROPERTY PS : POINTER TO S
    GET
      PS := ADR(s);
    END_GET
  END_PROPERTY
END_FUNCTION_BLOCK
PROGRAM Main
VAR h : FB_H; x, y : INT; END_VAR
x := h.P^;
h.P^ := 8;
h.PS^.a := 3;
y := h.P^ + h.PS^.a;
END_PROGRAM
`,
    main: 'Program_MAIN p; p.run(); std::cout << (int)p.X << " " << (int)p.Y;',
    expected: "5 11",
  },
  {
    title:
      "reads and writes properties and bits of array elements, an index call evaluated once",
    name: "oop_elem_props",
    features: [],
    source: `FUNCTION_BLOCK FB_P
VAR w : WORD := 16#0010; END_VAR
VAR_OUTPUT gets : INT; sets : INT; END_VAR
PROPERTY P : WORD
GET gets := gets + 1; P := w; END_GET
SET sets := sets + 1; w := P; END_SET
END_PROPERTY
END_FUNCTION_BLOCK
VAR_GLOBAL arr : ARRAY[0..3] OF FB_P; calls : INT; wa : ARRAY[0..3] OF WORD; END_VAR
FUNCTION Idx : INT calls := calls + 1; Idx := 1; END_FUNCTION
PROGRAM Main
VAR b : BOOL; i : INT := 2; END_VAR
arr[Idx()].P.2 := TRUE;
wa[Idx()].3 := TRUE;
arr[i].P := 16#00FF;
b := arr[i].P.3;
END_PROGRAM
`,
    main: 'Program_MAIN p; p.run(); std::cout << (int)ARR[1].get_P() << " " << (int)WA[1] << " c" << CALLS << " s" << ARR[1].SETS << " " << (int)ARR[2].get_P() << " " << (int)p.B;',
    expected: "20 8 c2 s1 255 1",
  },
  {
    title: "calls a method through the block's own interface property",
    name: "oop_own_prop",
    features: [],
    source: `INTERFACE I_J METHOD M : INT END_METHOD END_INTERFACE
FUNCTION_BLOCK FB_T IMPLEMENTS I_J
VAR_OUTPUT k : INT; END_VAR
METHOD M : INT k := k + 1; M := k; END_METHOD
END_FUNCTION_BLOCK
VAR_GLOBAL gi : INT := 5; END_VAR
FUNCTION_BLOCK FB_H
VAR t : FB_T; END_VAR
VAR_OUTPUT gets : INT; END_VAR
PROPERTY P : POINTER TO INT
GET gets := gets + 1; P := ADR(gi); END_GET
END_PROPERTY
PROPERTY PJ : I_J
GET gets := gets + 1; PJ := t; END_GET
END_PROPERTY
METHOD Inner : INT Inner := PJ.M(); PJ.M(); END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main
VAR h : FB_H; a, b, c : INT; END_VAR
b := h.PJ.M();
h.PJ.M();
c := h.Inner();
END_PROGRAM
`,
    main: 'Program_MAIN p; p.run(); std::cout << p.A << " " << GI << " " << p.B << " " << p.C << " g" << p.H.GETS;',
    expected: "0 5 1 3 g4",
  },
];

const LIB = `FUNCTION_BLOCK FB_L
VAR_OUTPUT n : INT; END_VAR
  METHOD M : INT
  VAR_INPUT a : INT; b : INT := 10; END_VAR
  VAR_OUTPUT o : INT; END_VAR
  VAR_IN_OUT io : INT; END_VAR
    n := n + a + b; o := a * 2; io := io + 1; M := n;
  END_METHOD
END_FUNCTION_BLOCK
TYPE S_L : STRUCT f : FB_L; k : INT; END_STRUCT END_TYPE
`;

const LIB_PROGRAM = `PROGRAM Main
VAR s : S_L; x, y, z, w : INT; END_VAR
x := s.f.M(a := 3, o => y, io := w);
s.f.M(io := w, a := 1);
z := s.f.M(1, 2, y, w);
END_PROGRAM
`;

const LIBS_DIR = path.resolve(__dirname, "../../libs");

const mainOf = (body: string): string => `
#include <iostream>
int main() {
    using namespace strucpp;
    ${body}
    std::cout << std::endl;
    return 0;
}
`;

describe.skipIf(!hasGpp)(
  "interfaces, properties and call results — g++ e2e",
  () => {
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-oopcalls-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    for (const c of CASES) {
      it(c.title, () => {
        const result = compile(c.source, {
          headerFileName: "generated.hpp",
          features: c.features,
        });
        expect(result.errors).toEqual([]);
        const stdout = compileAndRunStandalone({
          tempDir,
          pchPath,
          headerCode: result.headerCode,
          cppCode: result.cppCode,
          testName: c.name,
          mainCode: mainOf(c.main),
        });
        expect(stdout).toBe(c.expected);
      });
    }

    it.skipIf(!fs.existsSync(path.join(LIBS_DIR, "oscat-basic.stlib")))(
      "stores a library STRUCT FUNCTION result (CADD) in a variable and a FUNCTION result",
      () => {
        const result = compile(
          `FUNCTION F2 : COMPLEX VAR_INPUT a, b : COMPLEX; END_VAR F2 := CADD(a, b); END_FUNCTION
PROGRAM Main
VAR c, d, e : COMPLEX; END_VAR
c.RE := 3.0; c.IM := 4.0; d := F2(c, c); e := CADD(c, c);
END_PROGRAM
`,
          {
            headerFileName: "generated.hpp",
            libraries: discoverStlibs(LIBS_DIR),
          },
        );
        expect(result.errors).toEqual([]);
        const stdout = compileAndRunStandalone({
          tempDir,
          pchPath,
          headerCode: result.headerCode,
          cppCode: result.cppCode,
          testName: "oop_cadd",
          mainCode: mainOf(
            'Program_MAIN p; p.run(); std::cout << p.D.RE << " " << p.D.IM << " " << p.E.RE;',
          ),
        });
        expect(stdout).toBe("6 8 6");
      },
    );

    it("binds named and positional arguments of s.f.M() with a library STRUCT and FB", () => {
      const lib = compileStlib([{ source: LIB, fileName: "lib.st" }], {
        name: "chainlib",
        version: "1.0.0",
        namespace: "chainlib",
      });
      expect(lib.errors).toEqual([]);
      const archive = JSON.parse(JSON.stringify(lib.archive)) as StlibArchive;
      const result = compile(LIB_PROGRAM, {
        headerFileName: "generated.hpp",
        libraries: [loadStlibArchive(archive)],
      });
      expect(result.errors).toEqual([]);
      const stdout = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: "oop_lib_chain",
        mainCode: mainOf(
          'Program_MAIN p; p.run(); std::cout << (int)p.X << " " << (int)p.Y << " " << (int)p.Z << " " << (int)p.W;',
        ),
      });
      expect(stdout).toBe("13 2 27 3");
    });
  },
);
