/**
 * Interface-typed variables end to end through g++: an FB member set from
 * outside and called each cycle, a FUNCTION taking an interface input, a NULL
 * check before the call, reassignment to a second implementation, an
 * interface extending two interfaces, a shared base interface (diamond), THIS
 * passed into an interface input, a member chain and a global. A call through
 * a NULL interface raises the runtime's null-reference fault.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const TYPES = `INTERFACE ICounter
METHOD Value : INT
END_METHOD
END_INTERFACE

INTERFACE IStep
METHOD Step
END_METHOD
END_INTERFACE

INTERFACE ICounterStep EXTENDS ICounter, IStep
METHOD Name : INT
END_METHOD
END_INTERFACE

FUNCTION_BLOCK FB_Ones IMPLEMENTS ICounterStep
VAR n : INT; END_VAR
METHOD Value : INT
  Value := n;
END_METHOD
METHOD Step
  n := n + 1;
END_METHOD
METHOD Name : INT
  Name := 1;
END_METHOD
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_Tens EXTENDS FB_Ones
METHOD OVERRIDE Step
  n := n + 10;
END_METHOD
METHOD OVERRIDE Name : INT
  Name := 10;
END_METHOD
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_User
VAR_INPUT c : ICounterStep; END_VAR
VAR_OUTPUT seen : INT; END_VAR
  IF c <> NULL THEN
    c.Step();
    seen := c.Value();
  ELSE
    seen := -1;
  END_IF;
END_FUNCTION_BLOCK

FUNCTION ReadOr : INT
VAR_INPUT x : ICounter; dflt : INT; END_VAR
  IF x = NULL THEN
    ReadOr := dflt;
  ELSE
    ReadOr := x.Value();
  END_IF;
END_FUNCTION

FUNCTION_BLOCK FB_Self IMPLEMENTS ICounterStep
VAR u : FB_User; k : INT := 40; END_VAR
METHOD Value : INT
  Value := k;
END_METHOD
METHOD Step
  k := k + 2;
END_METHOD
METHOD Name : INT
  Name := 2;
END_METHOD
  u(c := THIS);
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_Holder
VAR held : ICounter; END_VAR
END_FUNCTION_BLOCK

VAR_GLOBAL
  gItf : IStep;
END_VAR
`;

const MAIN = `PROGRAM MAIN
VAR_EXTERNAL gItf : IStep; END_VAR
VAR
  ones : FB_Ones;
  tens : FB_Tens;
  user : FB_User;
  selfFb : FB_Self;
  holder : FB_Holder;
  cyc : INT;
  ic : ICounter;
  ist : IStep;
  both : ICounterStep;
  none : ICounter;
  A : INT; B : INT; C : INT; D : INT; E : INT; F : INT; G : INT;
  SAME : BOOL; DIFF : BOOL; ISNULL : BOOL;
END_VAR
  cyc := cyc + 1;
  IF cyc = 1 THEN
    user.c := ones;
  ELSIF cyc = 3 THEN
    user.c := tens;
  END_IF;
  user();
  A := user.seen;
  both := tens;
  ic := both;
  ist := both;
  B := ReadOr(ic, 0) + ReadOr(none, 1000);
  C := both.Name();
  selfFb();
  D := selfFb.u.seen;
  holder.held := ones;
  E := holder.held.Value();
  gItf := ones;
  gItf.Step();
  F := ones.Value();
  SAME := ic = both;
  DIFF := ic <> both;
  ISNULL := none = NULL;
  none := ic;
  G := none.Value();
  none := NULL;
END_PROGRAM
`;

describeIfGpp("interface-typed variables end to end", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-itfvars-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function run(
    source: string,
    mainBody: string,
    name: string,
    options: Parameters<typeof compile>[1] = {},
  ): string {
    const result = compile(source, {
      headerFileName: "generated.hpp",
      ...options,
    });
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

  const FIELDS = ["A", "B", "C", "D", "E", "F", "G", "SAME", "DIFF", "ISNULL"];
  const PRINT = ` Program_MAIN p;\n for (int i = 0; i < 4; ++i) {\n  p.run();\n  std::cout << ${FIELDS.map((v) => `p.${v}.get()`).join(' << " " << ')} << std::endl;\n }`;
  // Cycle by cycle: user.c is ones for cycles 1-2, tens from cycle 3, and
  // steps the instance it holds (gItf steps ones once more per cycle).
  // A: ones 1, 3 (gItf stepped it once), tens 10, 20; B: tens.n + 1000;
  // C: tens Name; D: FB_Self via THIS, k 42, 44...; E/F: ones before and
  // after gItf.Step; G: tens through a reassigned variable.
  const EXPECTED = [
    "1 1000 10 42 1 2 0 1 0 1",
    "3 1000 10 44 3 4 0 1 0 1",
    "10 1010 10 46 4 5 10 1 0 1",
    "20 1020 10 48 5 6 20 1 0 1",
  ].join("\n");

  it("runs under iec-3", () => {
    expect(run(TYPES + MAIN, PRINT, "itfvars_iec", { dialect: "iec-3" })).toBe(
      EXPECTED,
    );
  });

  it("runs with no dialect flag", () => {
    expect(run(TYPES + MAIN, PRINT, "itfvars_default")).toBe(EXPECTED);
  });

  it("a shared base interface (diamond) converts and dispatches", () => {
    const source = `INTERFACE IBase
METHOD Id : INT
END_METHOD
END_INTERFACE
INTERFACE ILeft EXTENDS IBase
METHOD L : INT
END_METHOD
END_INTERFACE
INTERFACE IRight EXTENDS IBase
METHOD R : INT
END_METHOD
END_INTERFACE
INTERFACE IBoth EXTENDS ILeft, IRight
END_INTERFACE
FUNCTION_BLOCK FB_Both IMPLEMENTS IBoth
METHOD Id : INT
  Id := 5;
END_METHOD
METHOD L : INT
  L := 6;
END_METHOD
METHOD R : INT
  R := 7;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Two IMPLEMENTS ILeft, IRight
METHOD Id : INT
  Id := 8;
END_METHOD
METHOD L : INT
  L := 9;
END_METHOD
METHOD R : INT
  R := 11;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR
  fb : FB_Both; two : FB_Two;
  b : IBase; il : ILeft; ir : IRight; both : IBoth;
  X : INT; Y : INT; SAME : BOOL;
END_VAR
  b := fb;
  both := fb;
  il := both;
  ir := both;
  X := b.Id() * 100 + il.L() * 10 + ir.R();
  SAME := b = both;
  b := two;
  ir := two;
  Y := b.Id() * 100 + ir.R();
END_PROGRAM
`;
    const out = run(
      source,
      ` Program_MAIN p;\n p.run();\n std::cout << p.X.get() << " " << p.Y.get() << " " << p.SAME.get() << std::endl;`,
      "itfvars_diamond",
      { dialect: "iec-3" },
    );
    expect(out).toBe("567 811 1");
  });

  it("VAR_IN_OUT of interface type: FB and method, bound to an instance or an interface variable", () => {
    const source = `${TYPES}FUNCTION_BLOCK FB_InOut
VAR_IN_OUT io : ICounter; END_VAR
VAR_OUTPUT got : INT; END_VAR
METHOD Peek : INT
VAR_IN_OUT mio : ICounter; END_VAR
  Peek := mio.Value();
END_METHOD
  got := io.Value();
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR ones : FB_Ones; tens : FB_Tens; f : FB_InOut; ic : ICounter; X : INT; Y : INT; Z : INT; END_VAR
  ones.Step();
  tens.Step();
  f(io := ones);
  X := f.got;
  ic := tens;
  Y := f.Peek(ic);
  Z := f.Peek(mio := ones);
END_PROGRAM
`;
    const out = run(
      source,
      ` Program_MAIN p;\n p.run();\n std::cout << p.X.get() << " " << p.Y.get() << " " << p.Z.get() << std::endl;`,
      "itfvars_inout",
      { dialect: "iec-3" },
    );
    expect(out).toBe("1 10 1");
  });

  it("a call through a NULL interface raises the null-reference fault", () => {
    const source = `${TYPES}PROGRAM MAIN
VAR ic : ICounter; v : INT; END_VAR
  v := ic.Value();
END_PROGRAM
`;
    const out = run(
      source,
      ` Program_MAIN p;\n try { p.run(); std::cout << "ran" << std::endl; }\n catch (const NullReferenceException&) { std::cout << "null" << std::endl; }`,
      "itfvars_null",
      { dialect: "iec-3" },
    );
    expect(out).toBe("null");
  });
});
