/**
 * End-to-end: ADVANCE_TIME nested in a loop or IF of a TEST body advances the
 * scan-cycle time on every pass it executes. A TON driven from such a loop must
 * stay off until its preset has elapsed and come on exactly then.
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { hasGpp, runE2ETestPipeline } from "./test-helpers.js";
import { loadStlibFromFile } from "../../src/node/library-loader.js";

const IEC_STDLIB_PATH = path.resolve(
  __dirname,
  "../../libs/iec-standard-fb.stlib",
);

const SOURCE = `
PROGRAM Main
  VAR
    t : TON;
    go : BOOL;
  END_VAR
  t(IN := go, PT := T#1s);
END_PROGRAM
`;

/** Build and run `testST` against SOURCE with the IEC standard FB library. */
function run(testST: string): { stdout: string; exitCode: number } {
  return runE2ETestPipeline({
    sourceST: SOURCE,
    testST,
    testFileName: "test_advance_loops.st",
    isTestBuild: true,
    tempDirPrefix: "strucpp-advloop-",
    compileOptions: { libraries: [loadStlibFromFile(IEC_STDLIB_PATH)] },
  });
}

describe.skipIf(!hasGpp)("ADVANCE_TIME in loops and IF (e2e)", () => {
  it("advances time on every pass of FOR, WHILE and REPEAT and in IF", () => {
    const { stdout, exitCode } = run(`
TEST 'FOR loop'
  VAR m : Main; i : INT; END_VAR
  m.go := TRUE;
  m();
  FOR i := 1 TO 9 DO
    ADVANCE_TIME(T#100ms);
    m();
    ASSERT_FALSE(m.t.Q);
  END_FOR;
  ASSERT_EQ(m.t.ET, T#900ms);
  ADVANCE_TIME(T#100ms);
  m();
  ASSERT_TRUE(m.t.Q);
END_TEST

TEST 'WHILE loop'
  VAR m : Main; i : INT; END_VAR
  m.go := TRUE;
  m();
  WHILE i < 10 DO
    ASSERT_FALSE(m.t.Q);
    ADVANCE_TIME(T#100ms);
    m();
    i := i + 1;
  END_WHILE;
  ASSERT_TRUE(m.t.Q);
END_TEST

TEST 'REPEAT loop'
  VAR m : Main; i : INT; END_VAR
  m.go := TRUE;
  m();
  REPEAT
    ADVANCE_TIME(T#250ms);
    m();
    i := i + 1;
  UNTIL m.t.Q END_REPEAT;
  ASSERT_EQ(i, 4);
END_TEST

TEST 'IF branch'
  VAR m : Main; END_VAR
  m.go := TRUE;
  m();
  IF m.go THEN
    ADVANCE_TIME(T#1s);
  END_IF;
  m();
  ASSERT_TRUE(m.t.Q);
END_TEST
`);
    expect(stdout).not.toContain("[FAIL]");
    expect(stdout).toContain("4 tests, 4 passed, 0 failed");
    expect(exitCode).toBe(0);
  });

  it("does not elapse a TON before enough passes have run", () => {
    const { stdout, exitCode } = run(`
TEST 'too few passes'
  VAR m : Main; i : INT; END_VAR
  m.go := TRUE;
  m();
  FOR i := 1 TO 9 DO
    ADVANCE_TIME(T#100ms);
    m();
  END_FOR;
  ASSERT_TRUE(m.t.Q);
END_TEST
`);
    expect(stdout).toContain("[FAIL] too few passes");
    expect(exitCode).toBe(1);
  });
});
