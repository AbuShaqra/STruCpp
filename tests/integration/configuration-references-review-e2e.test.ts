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
