/**
 * E2E: a global read or written inside a class (FB, PROGRAM, method, action,
 * property accessor) that has a member function of the global's name failed
 * g++, the member function hiding the global. The global is
 * namespace-qualified; the method keeps its own name and result variable.
 * A method called on a test's SETUP variable reaches it through the setup
 * state (it was emitted bare: "'STATION' was not declared").
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import {
  hasGpp,
  createPCH,
  compileAndRunStandalone,
  runE2ETestPipeline,
} from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `VAR_GLOBAL
Reset AT %IX0.0 : BOOL;
Go : INT := 4;
Pulse : INT;
END_VAR
VAR_GLOBAL CONSTANT
Scale : INT := 10;
END_VAR
INTERFACE I_Station
METHOD Reset : BOOL
END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB_A IMPLEMENTS I_Station
VAR_OUTPUT seen, viaMethod, viaProp : BOOL; calls : INT; END_VAR
METHOD Reset : BOOL
calls := calls + 1;
Reset := TRUE;
END_METHOD
METHOD Check : BOOL
Check := Reset;
END_METHOD
METHOD Pulse : INT
Pulse := 99;
END_METHOD
PROPERTY P : BOOL
GET
P := NOT Reset;
END_GET
END_PROPERTY
seen := Reset;
viaMethod := Check();
viaProp := P;
Pulse := Pulse + 1;
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_B EXTENDS FB_A
VAR_OUTPUT derived : BOOL; END_VAR
derived := Reset;
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_C
VAR_OUTPUT o : INT; END_VAR
METHOD Scale : INT
Scale := 2;
END_METHOD
ACTION Go
o := o + 100;
END_ACTION
o := Go * Scale + Scale();
END_FUNCTION_BLOCK
PROGRAM Main
VAR a : FB_A; b : FB_B; c : FB_C; i : I_Station; r : BOOL; n : INT; END_VAR
ACTION Go
n := -1;
END_ACTION
i := a;
a();
b();
c();
r := i.Reset() AND Reset;
n := Go;
END_PROGRAM
`;

const MAIN = `#include <iostream>
int main() {
  using namespace strucpp;
  Program_MAIN p;
  auto show = [&p]() {
    std::cout << p.A.SEEN.get() << p.A.VIAMETHOD.get() << p.A.VIAPROP.get()
              << '|' << p.A.CALLS.get() << '|' << p.R.get() << '|'
              << p.B.DERIVED.get() << '|' << p.C.O.get() << '|' << p.N.get()
              << '|' << PULSE.get() << ';';
  };
  RESET = false;
  p.run();
  show();
  RESET = true;
  p.run();
  show();
  std::cout << std::endl;
  return 0;
}
`;

const GVL = `VAR_GLOBAL
Reset : BOOL := TRUE;
END_VAR
`;

const LIST_SOURCE = `FUNCTION_BLOCK FB_A
VAR_OUTPUT body, inMethod : BOOL; END_VAR
METHOD Reset : BOOL
Reset := NOT GVL_A.Reset;
END_METHOD
body := GVL_A.Reset;
inMethod := Reset();
END_FUNCTION_BLOCK
PROGRAM Main
VAR a : FB_A; m : BOOL; END_VAR
METHOD Reset : BOOL
Reset := GVL_A.Reset;
END_METHOD
a();
m := Reset();
END_PROGRAM
`;

const LIST_MAIN = `#include <iostream>
int main() {
  using namespace strucpp;
  Program_MAIN p;
  p.run();
  std::cout << p.A.BODY.get() << p.A.INMETHOD.get() << p.M.get() << std::endl;
  return 0;
}
`;

const STATION_SOURCE = `VAR_GLOBAL
Reset AT %IX0.0 : BOOL;
Pump : FB_Pump;
END_VAR
FUNCTION_BLOCK FB_Pump
VAR_OUTPUT level : INT := 7; END_VAR
METHOD Twice : INT
Twice := level * 2;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Station
VAR_OUTPUT armed : BOOL; seen : INT; END_VAR
METHOD Reset : BOOL
armed := FALSE;
Reset := TRUE;
END_METHOD
METHOD Pump : INT
Pump := 1;
END_METHOD
armed := Reset;
seen := Pump.Twice() + Pump();
END_FUNCTION_BLOCK
`;

const STATION_TEST = `SETUP
VAR station : FB_Station; END_VAR
END_SETUP
TEST 'station reads the global and calls its method'
  Reset := TRUE;
  station();
  ASSERT_TRUE(station.armed);
  ASSERT_EQ(station.seen, 15);
  ASSERT_TRUE(station.Reset());
  ASSERT_FALSE(station.armed);
  ASSERT_TRUE(Reset);
  Reset := FALSE;
  station();
  ASSERT_FALSE(station.armed);
END_TEST
`;

const SHADOW_SOURCE = `FUNCTION_BLOCK FB_T
VAR_OUTPUT n : INT; END_VAR
METHOD Bump : INT
n := n + 1;
Bump := n;
END_METHOD
END_FUNCTION_BLOCK
VAR_GLOBAL gT : FB_T; END_VAR
FUNCTION_BLOCK FB_A
VAR_EXTERNAL gT : FB_T; END_VAR
METHOD M1 : INT
VAR gT : FB_T; END_VAR
M1 := gT.Bump();
END_METHOD
METHOD M2 : INT
VAR gT : FB_T; END_VAR
gT.Bump();
gT.Bump();
M2 := gT.n;
END_METHOD
END_FUNCTION_BLOCK
`;

const SHADOW_TEST = `TEST 'a method local hides the VAR_EXTERNAL of its name'
VAR a : FB_A; r : INT; END_VAR
r := a.M1();
r := a.M1();
ASSERT_EQ(r, 1);
ASSERT_EQ(a.M2(), 2);
ASSERT_EQ(gT.n, 0);
END_TEST
`;

const STATEMENT_SOURCE = `FUNCTION_BLOCK FB_Pump
VAR_OUTPUT runs : INT; END_VAR
runs := runs + 1;
END_FUNCTION_BLOCK
VAR_GLOBAL Pump : FB_Pump; END_VAR
FUNCTION_BLOCK FB_S
VAR_OUTPUT calls, v, seen : INT; END_VAR
METHOD Pump : INT
calls := calls + 1;
Pump := 10;
END_METHOD
Pump();
v := Pump();
seen := Pump.runs;
END_FUNCTION_BLOCK
PROGRAM Main
VAR s : FB_S; END_VAR
Pump();
s();
END_PROGRAM
`;

const STATEMENT_MAIN = `#include <iostream>
int main() {
  using namespace strucpp;
  Program_MAIN p;
  p.run();
  p.run();
  std::cout << p.S.CALLS.get() << '|' << p.S.V.get() << '|' << p.S.SEEN.get()
            << '|' << PUMP.RUNS.get() << std::endl;
  return 0;
}
`;

const MANGLED_SOURCE = `FUNCTION_BLOCK FB_T
VAR_OUTPUT n : INT; END_VAR
METHOD Bump : INT
n := n + 1;
Bump := n;
END_METHOD
END_FUNCTION_BLOCK
VAR_GLOBAL GT : FB_T; CODE : FB_T; END_VAR
FUNCTION_BLOCK FB_A
VAR_OUTPUT r : INT; END_VAR
VAR_EXTERNAL GT : FB_T; END_VAR
r := GT.Bump();
END_FUNCTION_BLOCK
FUNCTION F_Code : INT
VAR_EXTERNAL CODE : FB_T; END_VAR
F_Code := CODE.Bump();
END_FUNCTION
PROGRAM Main
VAR a : FB_A; x, y, z : INT; END_VAR
a();
x := F_Code();
y := GT.Bump() + CODE.Bump();
z := GT.n * 100 + CODE.n;
END_PROGRAM
`;

const MANGLED_MAIN = `#include <iostream>
int main() {
  using namespace strucpp;
  Program_MAIN p;
  p.run();
  std::cout << p.A.R.get() << '|' << p.X.get() << '|' << p.Y.get() << '|'
            << p.Z.get() << std::endl;
  return 0;
}
`;

describeIfGpp("a global named like a member function of the class", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-gname-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("reads and writes the global, and calls the method", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "global_named_like_method",
      mainCode: MAIN,
    });
    // Reset FALSE: seen/Check() read the global (FALSE), not the method (TRUE);
    // P is NOT Reset; i.Reset() runs the method once; Go * Scale + Scale() =
    // 4 * 10 + 2; n reads the global Go, not the action; a adds 1 to the
    // global Pulse (b's own body replaces FB_A's). Reset TRUE: the reads flip.
    expect(out).toBe("001|1|0|0|42|4|1;110|2|1|1|42|4|2;");
  });

  it("reads a list-qualified global inside a method of its name", () => {
    const result = compile(LIST_SOURCE, {
      headerFileName: "generated.hpp",
      fileName: "main.st",
      additionalSources: [{ source: GVL, fileName: "GVL_A.st" }],
      features: ["+named_global_lists", "+program_methods"],
    });
    expect(result.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "list_global_named_like_method",
      mainCode: LIST_MAIN,
    });
    expect(out).toBe("101");
  });

  it("runs a station test: SETUP instance method, global and global instance", () => {
    const { stdout, exitCode } = runE2ETestPipeline({
      sourceST: STATION_SOURCE,
      testST: STATION_TEST,
      testFileName: "test_station.st",
      tempDirPrefix: "strucpp-gname-station-",
    });
    expect(stdout).toContain("1 test, 1 passed, 0 failed");
    expect(exitCode).toBe(0);
  });

  it("a method local of a VAR_EXTERNAL's mangled name is the local", () => {
    const { stdout, exitCode } = runE2ETestPipeline({
      sourceST: SHADOW_SOURCE,
      testST: SHADOW_TEST,
      testFileName: "test_shadow.st",
      tempDirPrefix: "strucpp-gname-shadow-",
    });
    expect(stdout).toContain("1 test, 1 passed, 0 failed");
    expect(exitCode).toBe(0);
  });

  it("a call statement NAME(); in a class with a method NAME calls the method", () => {
    const result = compile(STATEMENT_SOURCE, {
      headerFileName: "generated.hpp",
    });
    expect(result.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "statement_calls_method",
      mainCode: STATEMENT_MAIN,
    });
    // Two runs: the method twice per run (statement and expression); the
    // global instance only from Main, which has no method Pump.
    expect(out).toBe("4|10|2|2");
  });

  it("a dotted call on a global of a runtime name builds and runs", () => {
    const result = compile(MANGLED_SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "mangled_global_dotted_call",
      mainCode: MANGLED_MAIN,
    });
    // GT bumped by FB_A (1) then Main (2); CODE by F_Code (1) then Main (2).
    expect(out).toBe("1|1|4|202");
  });
});
