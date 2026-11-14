/**
 * REFERENCE TO initial values and VAR_EXTERNAL CONFIGURATION globals in a
 * program's initial values (g++): an FB copy rebinds its self-bound
 * references, REF and ADR of an external bind its storage, structure
 * initializers and bit access read it; the forms that cannot bind are refused.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const errors = (src: string): string[] =>
  compile(src).errors.map((e) => `${e.line}:${e.column}: ${e.message}`);

const CFG = `CONFIGURATION Cfg
VAR_GLOBAL x : INT := 4; y : INT := 9; s : ST_P; w : WORD := 16#0009; END_VAR
RESOURCE Res ON PLC
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM Inst WITH T : MAIN;
END_RESOURCE
END_CONFIGURATION
`;

describe.skipIf(!hasGpp)("REFERENCE TO and VAR_EXTERNAL initial values", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-cfg-review-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const run = (src: string, name: string, main: string): string[] => {
    const r = compile(src, { headerFileName: "generated.hpp" });
    expect(r.errors).toEqual([]);
    return compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: r.headerCode,
      cppCode: r.cppCode,
      testName: name,
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n ${main}\n return 0;\n}\n`,
    })
      .trim()
      .split(/\s+/);
  };
  const p = (e: string): string => `std::cout << (long long)(${e}) << " ";`;

  it("rebinds an FB's self-bound reference in a copy (#0)", () => {
    const src = `FUNCTION_BLOCK FB_A
VAR_INPUT y : INT := 3; END_VAR
VAR r : REFERENCE TO INT := REF(y); END_VAR
VAR_OUTPUT q : INT; END_VAR
r := r + 10;
q := y;
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR fbs : ARRAY[0..1] OF FB_A := [(y := 1), (y := 2)]; f1 : FB_A := (y := 100); f2 : FB_A; END_VAR
fbs[1]();
f2 := f1;
f2();
END_PROGRAM
`;
    expect(
      run(
        src,
        "cfgrev_fbcopy",
        `Program_MAIN m; m.run(); ${["m.FBS.at(1).Q.get()", "m.FBS.at(1).Y.get()", "m.F1.Y.get()", "m.F2.Y.get()", "m.F2.Q.get()"].map(p).join(" ")}`,
      ),
    ).toEqual(["12", "12", "100", "110", "110"]);
  });

  it("binds REF and ADR of an external, reads it in initializers and bits (#1, #4-#7)", () => {
    const src = `TYPE ST_P : STRUCT a : INT; END_STRUCT; END_TYPE
FUNCTION_BLOCK FB2
VAR_INPUT inp : INT; END_VAR
END_FUNCTION_BLOCK
${CFG}PROGRAM MAIN
VAR_EXTERNAL y : INT; s : ST_P; x : INT; w : WORD; END_VAR
VAR
  ry : REFERENCE TO INT := REF(y);
  rs : REFERENCE TO INT := REF(s.a);
  px : POINTER TO INT := ADR(x);
  ls : ST_P := (a := x);
  fb : FB2 := (inp := x);
  bit0 : BOOL := w.0;
  b3 : BOOL;
  o1, o2, o3 : INT;
END_VAR
ry := 5;
rs := 6;
o1 := y;
o2 := s.a;
o3 := px^;
b3 := w.3;
END_PROGRAM
`;
    expect(
      run(
        src,
        "cfgrev_externals",
        `Configuration_CFG c; c.INST.run(); ${["O1", "O2", "O3", "BIT0", "B3"].map((v) => p(`c.INST.${v}.get()`)).join(" ")} ${p("c.INST.LS.A.get()")} ${p("c.INST.FB.INP.get()")}`,
      ),
    ).toEqual(["5", "6", "4", "1", "1", "4", "4"]);
  });
  it("rebinds by offset in a copy, with a run-time index (recheck #1)", () => {
    const fbx = `FUNCTION_BLOCK FB_X
VAR_INPUT i : INT := 0; END_VAR
VAR arr : ARRAY[0..2] OF INT; r : REFERENCE TO INT := REF(arr[i]); END_VAR
r := r + 1;
END_FUNCTION_BLOCK
`;
    expect(
      run(
        `${fbx}PROGRAM MAIN
VAR a : FB_X; b : FB_X; fa : ARRAY[0..1] OF FB_X := [(i := 2), (i := 2)]; END_VAR
a(); a.i := 7;
b := a;
b();
fa[1]();
END_PROGRAM
`,
        "cfgrev_offset",
        `Program_MAIN m; m.run(); ${["m.A.ARR.at(0).get()", "m.B.ARR.at(0).get()", "m.FA.at(1).ARR.at(0).get()"].map(p).join(" ")}`,
      ),
    ).toEqual(["1", "2", "1"]);
  });

  it("rebinds a POINTER TO bound to its own member in a copy (recheck #3)", () => {
    expect(
      run(
        `FUNCTION_BLOCK FB_P
VAR_INPUT y : INT := 3; END_VAR
VAR p : POINTER TO INT := ADR(y); END_VAR
p^ := p^ + 10;
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR fa : ARRAY[0..1] OF FB_P := [(y := 1), (y := 2)]; END_VAR
fa[1]();
END_PROGRAM
`,
        "cfgrev_pointer",
        `Program_MAIN m; m.run(); ${p("m.FA.at(1).Y.get()")}`,
      ),
    ).toEqual(["12"]);
  });

  it("rebinds an ARRAY OF POINTER TO and a POINTER TO POINTER TO in a copy (recheck 3 #1, #2)", () => {
    const main = (): string =>
      `Program_MAIN m; m.run(); ${["m.A.Y.get()", "m.B.Y.get()", "m.FA.at(1).Y.get()"].map(p).join(" ")}`;
    const prog = (fb: string): string => `PROGRAM MAIN
VAR a, b : ${fb}; fa : ARRAY[0..1] OF ${fb} := [(y := 1), (y := 2)]; END_VAR
a(); b := a; b(); fa[1]();
END_PROGRAM
`;
    expect(
      run(
        `FUNCTION_BLOCK FB_AP
VAR_INPUT y : INT := 3; END_VAR
VAR z : INT; ap : ARRAY[0..1] OF POINTER TO INT := [ADR(y), ADR(z)]; END_VAR
ap[0]^ := ap[0]^ + 10;
END_FUNCTION_BLOCK
${prog("FB_AP")}`,
        "cfgrev_arrptr",
        main(),
      ),
    ).toEqual(["13", "23", "12"]);
    expect(
      run(
        `FUNCTION_BLOCK FB_PP
VAR_INPUT y : INT := 3; END_VAR
VAR p : POINTER TO INT := ADR(y); pp : POINTER TO POINTER TO INT := ADR(p); END_VAR
pp^^ := pp^^ + 10;
END_FUNCTION_BLOCK
${prog("FB_PP")}`,
        "cfgrev_ptrptr",
        main(),
      ),
    ).toEqual(["13", "23", "12"]);
  });

  it("rebinds a member typed by a REFERENCE TO alias in a copy (recheck 3 #6)", () => {
    expect(
      run(
        `TYPE T_R : REFERENCE TO INT; END_TYPE
TYPE T_R2 : T_R; END_TYPE
FUNCTION_BLOCK FB
VAR_INPUT y : INT := 3; END_VAR
VAR r : T_R := REF(y); r2 : T_R2 := REF(y); END_VAR
r := r + 10;
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR a, b : FB; fa : ARRAY[0..1] OF FB := [(y := 1), (y := 2)]; END_VAR
a(); b := a; b(); fa[1]();
END_PROGRAM
`,
        "cfgrev_alias_copy",
        `Program_MAIN m; m.run(); ${["m.A.Y.get()", "m.B.Y.get()", "m.FA.at(1).Y.get()", "&m.B.R2.target() == &m.B.Y"].map(p).join(" ")}`,
      ),
    ).toEqual(["13", "23", "12", "1"]);
  });

  it("reads an FB's VAR_EXTERNAL in its initial values (recheck #2)", () => {
    expect(
      run(
        `CONFIGURATION Cfg
VAR_GLOBAL x : INT := 4; END_VAR
RESOURCE Res ON PLC
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM Inst WITH T : MAIN;
END_RESOURCE
END_CONFIGURATION
FUNCTION_BLOCK FB_A
VAR_EXTERNAL x : INT; END_VAR
VAR rx : REFERENCE TO INT := REF(x); px : POINTER TO INT := ADR(x); v : INT := x; END_VAR
VAR_OUTPUT o, ov : INT; END_VAR
rx := rx + 10; o := px^; ov := v;
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR a : FB_A; END_VAR
a();
END_PROGRAM
`,
        "cfgrev_fbext",
        `Configuration_CFG c; c.INST.run(); ${p("c.INST.A.O.get()")} ${p("c.INST.A.OV.get()")}`,
      ),
    ).toEqual(["14", "4"]);
  });

  it("binds a member named like its type, an alias and NULL (recheck #5, #6, #9)", () => {
    expect(
      run(
        `TYPE Pt : STRUCT a : INT; END_STRUCT; END_TYPE
TYPE T_R : REFERENCE TO INT; END_TYPE
VAR_GLOBAL gn : REFERENCE TO INT := NULL; END_VAR
FUNCTION_BLOCK FB_In
VAR_OUTPUT q : INT; END_VAR
q := q + 1;
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_A
VAR
  FB_In : FB_In;
  Pt : Pt;
  rq : REFERENCE TO INT := REF(FB_In.q);
  rp : REFERENCE TO Pt := REF(Pt);
  rn : REFERENCE TO INT := NULL;
END_VAR
VAR_OUTPUT o : INT; END_VAR
FB_In(); rq := rq + 10; rp.a := rp.a + 1; o := FB_In.q + Pt.a;
END_FUNCTION_BLOCK
FUNCTION FF : INT
VAR rn : REFERENCE TO INT := NULL; END_VAR
FF := 1;
END_FUNCTION
PROGRAM MAIN
VAR fb1, fb2 : FB_A; x, y, z : INT; w : INT := 1; r2 : T_R := REF(w); END_VAR
fb1(); fb2 := fb1; fb2(); x := fb1.o; y := fb2.o;
r2 := 9;
z := FF();
END_PROGRAM
`,
        "cfgrev_names",
        `Program_MAIN m; m.run(); ${["m.X.get()", "m.Y.get()", "m.W.get()", "m.Z.get()"].map(p).join(" ")}`,
      ),
    ).toEqual(["12", "24", "9", "1"]);
  });
});

describe("REFERENCE TO initial values that cannot bind", () => {
  it("refuses a value other than REF(x) or NULL everywhere (#2)", () => {
    expect(
      errors(`VAR_GLOBAL g : INT := 6; gr : REFERENCE TO INT := g; END_VAR
FUNCTION F : INT
VAR z : INT := 4; r : REFERENCE TO INT := z; END_VAR
F := z;
END_FUNCTION
FUNCTION_BLOCK FB
VAR y : INT; r : REFERENCE TO INT := y; n : REFERENCE TO INT := NULL; END_VAR
END_FUNCTION_BLOCK
PROGRAM MAIN VAR x : INT := 5; rp : REFERENCE TO INT := x; END_VAR END_PROGRAM
`).sort(),
    ).toEqual(
      [
        "1:51: REFERENCE TO 'GR' is bound by its initial value only with REF(x); use REF(x)",
        "3:43: REFERENCE TO 'R' is bound by its initial value only with REF(x); use REF(x)",
        "7:38: REFERENCE TO 'R' is bound by its initial value only with REF(x); use REF(x)",
        "9:57: REFERENCE TO 'RP' is bound by its initial value only with REF(x); use REF(x)",
      ].sort(),
    );
  });

  it("refuses a bit of a variable (#3)", () => {
    expect(
      errors(`PROGRAM MAIN
VAR w : WORD; rb : REFERENCE TO BOOL := REF(w.3); r2 : REFERENCE TO BOOL; END_VAR
r2 REF= w.4;
END_PROGRAM
`),
    ).toEqual([
      "2:45: REFERENCE TO 'RB' cannot be bound to a bit of a variable: a bit has no address of its own",
      "3:9: REF= cannot be bound to a bit of a variable: a bit has no address of its own",
    ]);
  });

  it("refuses a global two CONFIGURATIONs declare (#8)", () => {
    expect(
      errors(`TYPE ST_P : STRUCT a : INT; END_STRUCT; END_TYPE
${CFG}CONFIGURATION Cfg2
VAR_GLOBAL x : INT := 5; END_VAR
RESOURCE Res ON PLC
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM Inst WITH T : MAIN;
END_RESOURCE
END_CONFIGURATION
PROGRAM MAIN
VAR_EXTERNAL x : INT; END_VAR
END_PROGRAM
`),
    ).toEqual([
      "10:12: Global 'X' of CONFIGURATION CFG2 is also declared in CONFIGURATION CFG; rename one of them",
    ]);
  });
});

describe("REFERENCE TO initial values: recheck refusals", () => {
  it("refuses a non-REF value through an alias (recheck #6)", () => {
    expect(
      errors(`TYPE T_R : REFERENCE TO INT; END_TYPE
PROGRAM Main
VAR x : INT := 1; r2 : T_R := x; END_VAR
END_PROGRAM
`),
    ).toEqual([
      "3:31: REFERENCE TO 'R2' is bound by its initial value only with REF(x); use REF(x)",
    ]);
  });

  it("refuses a VAR_IN_OUT in an initial value (recheck #7)", () => {
    expect(
      errors(`FUNCTION_BLOCK FB_A
VAR_IN_OUT io : INT; END_VAR
VAR rio : REFERENCE TO INT := REF(io); END_VAR
END_FUNCTION_BLOCK
PROGRAM Main VAR fb : FB_A; v : INT; END_VAR fb(io := v); END_PROGRAM
`),
    ).toEqual([
      "3:35: REFERENCE TO 'RIO' cannot be bound to the VAR_IN_OUT 'IO' in its initial value: it is bound only by a call; use REF= in the body",
    ]);
  });

  it("refuses a constant (recheck #8)", () => {
    expect(
      errors(`VAR_GLOBAL CONSTANT gk : INT := 9; END_VAR
PROGRAM Main
VAR CONSTANT k : INT := 3; END_VAR
VAR rk : REFERENCE TO INT := REF(k); rg : REFERENCE TO INT := REF(gk); r3 : REFERENCE TO INT; x : INT; END_VAR
r3 REF= k;
x := rk + rg;
END_PROGRAM
`),
    ).toEqual([
      "4:34: REFERENCE TO 'RK' cannot be bound to the constant 'K'",
      "4:67: REFERENCE TO 'RG' cannot be bound to the constant 'GK'",
      "5:9: REF= cannot be bound to the constant 'K'",
    ]);
  });

  it("accepts list-qualified globals of a CONFIGURATION global's name (recheck #4)", () => {
    const r = compile(
      `PROGRAM Main
VAR y : INT; END_VAR
y := GVL_A.x + GVL_B.x;
END_PROGRAM
CONFIGURATION C
VAR_GLOBAL x : INT := 5; END_VAR
RESOURCE R ON PLC TASK T(INTERVAL := T#10ms, PRIORITY := 1); PROGRAM P WITH T : Main; END_RESOURCE
END_CONFIGURATION
`,
      {
        fileName: "main.st",
        features: ["+named_global_lists"],
        additionalSources: [
          {
            fileName: "GVL_A.st",
            source: "VAR_GLOBAL x : INT := 1; END_VAR\n",
          },
          {
            fileName: "GVL_B.st",
            source: "VAR_GLOBAL x : INT := 2; END_VAR\n",
          },
        ],
      },
    );
    expect(r.errors).toEqual([]);
  });
});

describe("initial values: recheck 3 refusals", () => {
  it("refuses an FB initial value that reads or addresses its VAR_IN_OUT (#7)", () => {
    expect(
      errors(`FUNCTION_BLOCK FB_A
VAR_IN_OUT io : INT; END_VAR
VAR p : POINTER TO INT := ADR(io); v : INT := io + 1; END_VAR
END_FUNCTION_BLOCK
PROGRAM Main VAR fb : FB_A; v : INT := 3; END_VAR fb(io := v); END_PROGRAM
`),
    ).toEqual([
      "3:31: The initial value of 'P' cannot use the VAR_IN_OUT 'IO': it is bound only by a call; assign it in the body",
      "3:47: The initial value of 'V' cannot use the VAR_IN_OUT 'IO': it is bound only by a call; assign it in the body",
    ]);
  });

  it("refuses ADR of a constant, as an initial value and in a body (#8)", () => {
    expect(
      errors(`PROGRAM MAIN
VAR CONSTANT k : INT := 3; END_VAR
VAR p : POINTER TO INT := ADR(k); p2 : POINTER TO INT; x : INT; END_VAR
p2 := ADR(k);
p^ := 7; x := k;
END_PROGRAM
`),
    ).toEqual([
      "3:31: ADR() cannot take the constant 'K': a constant has no storage to write through",
      "4:11: ADR() cannot take the constant 'K': a constant has no storage to write through",
    ]);
  });
});
