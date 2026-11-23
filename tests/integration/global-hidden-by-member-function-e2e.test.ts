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
});
