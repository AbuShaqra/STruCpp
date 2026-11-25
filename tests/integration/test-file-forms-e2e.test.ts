// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E (test runner): test-file forms that were refused or failed g++:
 * - ASSERT_EQ / ASSERT_NEQ on a WSTRING and on a CHAR or WCHAR beside a
 *   one-character literal (a failure prints both values; a SINT as a number);
 * - an integer `MOD(a + 1, 5)`;
 * - a TEST variable of a PROGRAM type with a VAR_EXTERNAL of a CONFIGURATION
 *   global, and a FUNCTION writing that global through VAR_EXTERNAL;
 * - a list-qualified global (`GVL.x`) in a TEST body and initial value.
 */
import { describe, it, expect } from "vitest";
import { hasGpp, runE2ETestPipeline } from "./test-helpers.js";

const CONFIG_SOURCE = `
CONFIGURATION C
VAR_GLOBAL cg : INT := 5; END_VAR
RESOURCE R ON PLC
TASK t(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM p WITH t : PExt;
END_RESOURCE
END_CONFIGURATION
FUNCTION FSet : INT
VAR_INPUT v : INT; END_VAR
VAR_EXTERNAL cg : INT; END_VAR
cg := v;
FSet := cg;
END_FUNCTION
PROGRAM PExt
VAR_EXTERNAL cg : INT; END_VAR
VAR n : INT; END_VAR
n := cg + 1;
END_PROGRAM
`;

const CONFIG_TEST = `
TEST 'a program instance reaches the configuration global'
  VAR p : PExt; END_VAR
  p();
  ASSERT_EQ(p.n, 6);
END_TEST
TEST 'a function writes the configuration global'
  VAR p : PExt; r : INT; END_VAR
  r := FSet(9);
  ASSERT_EQ(r, 9);
  p();
  ASSERT_EQ(p.n, 10);
END_TEST
TEST 'integer MOD of a computed argument'
  VAR a : INT := 7; r : INT; END_VAR
  r := MOD(a + 1, 5);
  ASSERT_EQ(r, 3);
END_TEST
TEST 'strings and characters'
  VAR w : WSTRING := "ab"; w2 : WSTRING(10) := "ab"; c : CHAR := 'x'; wc : WCHAR := "y"; END_VAR
  ASSERT_EQ(w, "ab");
  ASSERT_EQ(w, w2);
  ASSERT_NEQ(w, "abc");
  ASSERT_EQ(c, 'x');
  ASSERT_EQ('x', c);
  ASSERT_NEQ(c, 'z');
  ASSERT_EQ(wc, "y");
END_TEST
TEST 'a wstring failure'
  VAR w : WSTRING := "ab"; END_VAR
  ASSERT_EQ(w, "ac");
END_TEST
TEST 'a char failure'
  VAR c : CHAR := 'x'; END_VAR
  ASSERT_EQ(c, 'q');
END_TEST
TEST 'integer powers'
  VAR b : DINT := 3; n : DINT := 2; r : DINT; END_VAR
  ASSERT_EQ(b ** -n, 0);
  ASSERT_EQ(b ** n, 9);
  r := 1 + b ** -n;
  ASSERT_EQ(r, 1);
END_TEST
TEST 'a sint failure'
  VAR si : SINT := -5; END_VAR
  ASSERT_EQ(si, 3);
END_TEST
`;

const GVL_SOURCE = `
PROGRAM P1
VAR n : INT; END_VAR
n := GVL.x;
END_PROGRAM
`;

const GVL_TEST = `
SETUP
  VAR s : INT := GVL.x; END_VAR
END_SETUP
TEST 'list-qualified globals'
  VAR v : INT := GVL2.x; END_VAR
  ASSERT_EQ(GVL.x, 5);
  GVL.x := 7;
  ASSERT_EQ(GVL.x, 7);
  ASSERT_EQ(GVL2.x, 9);
  ASSERT_EQ(v, 9);
  ASSERT_EQ(s, 5);
  IF GVL.x > 0 THEN GVL.x := GVL.x + 1; END_IF;
  ASSERT_EQ(GVL.x, 8);
END_TEST
`;

describe.skipIf(!hasGpp)("test-file forms (e2e)", () => {
  it("builds and runs each form", () => {
    const { stdout, exitCode } = runE2ETestPipeline({
      sourceST: CONFIG_SOURCE,
      testST: CONFIG_TEST,
      testFileName: "test_forms.st",
      tempDirPrefix: "strucpp-testforms-",
    });
    expect(stdout).toContain(
      "[PASS] a program instance reaches the configuration global",
    );
    expect(stdout).toContain(
      "[PASS] a function writes the configuration global",
    );
    expect(stdout).toContain("[PASS] integer MOD of a computed argument");
    expect(stdout).toContain("[PASS] strings and characters");
    expect(stdout).toContain("[PASS] integer powers");
    expect(stdout).toContain('expected "ac", got "ab"');
    expect(stdout).toContain("expected 'q', got 'x'");
    expect(stdout).toContain("SI expected 3, got -5");
    expect(stdout).toContain("8 tests, 5 passed, 3 failed");
    expect(exitCode).toBe(1);
  });

  it("reaches a list-qualified global", () => {
    const { stdout, exitCode } = runE2ETestPipeline({
      sourceST: GVL_SOURCE,
      testST: GVL_TEST,
      testFileName: "test_gvl.st",
      tempDirPrefix: "strucpp-testgvl-",
      passSourceAst: true,
      testFeatures: ["+named_global_lists"],
      compileOptions: {
        features: ["+named_global_lists"],
        additionalSources: [
          { source: "VAR_GLOBAL x : INT := 5; END_VAR\n", fileName: "GVL.st" },
          { source: "VAR_GLOBAL x : INT := 9; END_VAR\n", fileName: "GVL2.st" },
        ],
      },
    });
    expect(stdout).toContain("1 test, 1 passed, 0 failed");
    expect(exitCode).toBe(0);
  });
});
