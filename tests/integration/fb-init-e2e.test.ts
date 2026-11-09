/**
 * E2E for FB_init (feature fb_init): compiled with g++ and run. Checks the
 * start-up order (global instances in declaration order, then the program
 * instances, members before their holder, array elements in index order),
 * the init arguments reaching FB_init inputs (a default for one not given),
 * the two flags FALSE, one run per instance across cycles, and the EXTENDS
 * chain: every FB_init runs base first, a level without one is skipped.
 * Also a member's init argument passing on its holder's FB_init input.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

export const FB_INIT_E2E_SOURCE = `VAR_GLOBAL
  trace : ARRAY[0..39] OF INT;
  n : INT;
  g1 : FB_L(tag := 1);
  ga : ARRAY[0..1] OF FB_L(tag := 2);
  gn : FB_N(tag := 3);
END_VAR

FUNCTION_BLOCK FB_L
VAR_OUTPUT seq, calls, flags : INT; END_VAR
METHOD FB_init : BOOL
VAR_INPUT bInitRetains : BOOL; bInCopyCode : BOOL; tag : INT; END_VAR
trace[n] := tag;
n := n + 1;
seq := n;
calls := calls + 1;
IF bInitRetains OR bInCopyCode THEN flags := flags + 1; END_IF;
FB_init := TRUE;
END_METHOD
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_N
VAR inner : FB_L(tag := 30); arr : ARRAY[1..2] OF FB_L(tag := 40); END_VAR
METHOD FB_init
VAR_INPUT tag : INT; END_VAR
trace[n] := tag;
n := n + 1;
IF bInitRetains OR bInCopyCode THEN trace[n] := -1; n := n + 1; END_IF;
END_METHOD
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_B0
METHOD FB_init : BOOL
VAR_INPUT bInitRetains : BOOL; bInCopyCode : BOOL; a : INT; END_VAR
trace[n] := 100 + a;
n := n + 1;
END_METHOD
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_B1 EXTENDS FB_B0
VAR m : FB_L(tag := 7); END_VAR
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_B2 EXTENDS FB_B1
METHOD FB_init : BOOL
VAR_INPUT bInitRetains : BOOL; bInCopyCode : BOOL; a : INT; b : INT; END_VAR
trace[n] := 200 + a + b;
n := n + 1;
END_METHOD
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_D
METHOD FB_init : BOOL
VAR_INPUT extra : INT := 9; END_VAR
trace[n] := extra;
n := n + 1;
END_METHOD
END_FUNCTION_BLOCK

PROGRAM PA
VAR x : FB_L(tag := 50); d : FB_B2(a := 5, b := 6); dd : FB_D; cycles : INT; END_VAR
cycles := cycles + 1;
END_PROGRAM

PROGRAM PB
VAR y : FB_L(tag := 60); grid : ARRAY[0..1, 0..1] OF FB_L(tag := 70); END_VAR
END_PROGRAM

`;

const CONFIGURATION = `CONFIGURATION C
  RESOURCE R ON PLC
    TASK T(INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM IB WITH T : PB;
    PROGRAM IA WITH T : PA;
  END_RESOURCE
END_CONFIGURATION
`;

/** Prints the trace, then per-instance results, then `extra` (printf arguments, one %d each). */
function mainCode(construct: string, extra: string[]): string {
  return `
#include <cstdio>
int main() {
${construct}
    for (int i = 0; i < static_cast<int>(strucpp::N); ++i)
        std::printf("%d ", static_cast<int>(strucpp::TRACE[i]));
    std::printf("| %d %d %d %d %d | %d %d %d |",
        static_cast<int>(strucpp::G1.SEQ), static_cast<int>(strucpp::GA[0].SEQ),
        static_cast<int>(strucpp::GA[1].SEQ), static_cast<int>(strucpp::GN.ARR[1].SEQ),
        static_cast<int>(strucpp::GN.ARR[2].SEQ),
        static_cast<int>(strucpp::G1.CALLS + strucpp::GA[0].CALLS + strucpp::GA[1].CALLS +
                         strucpp::GN.INNER.CALLS + strucpp::GN.ARR[1].CALLS + strucpp::GN.ARR[2].CALLS),
        static_cast<int>(strucpp::G1.FLAGS + strucpp::GA[0].FLAGS + strucpp::GA[1].FLAGS +
                         strucpp::GN.INNER.FLAGS + strucpp::GN.ARR[1].FLAGS + strucpp::GN.ARR[2].FLAGS),
        static_cast<int>(strucpp::N));
${extra.map((e) => `    std::printf(" %d", static_cast<int>(${e}));`).join("\n")}
    std::printf("\\n");
    return 0;
}
`;
}

describe.skipIf(!hasGpp)("FB_init, run end to end", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-fb-init-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("runs once per instance at start-up, in the configuration's order", () => {
    const result = compile(FB_INIT_E2E_SOURCE + CONFIGURATION, {
      fileName: "main.st",
      features: ["+fb_init"],
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode!,
      cppCode: result.cppCode!,
      testName: "fb_init_config",
      mainCode: mainCode(
        `    static strucpp::Configuration_C cfg;
    cfg.IA.run(); cfg.IB.run(); cfg.IA.run();`,
        [
          "cfg.IA.X.CALLS + cfg.IB.Y.CALLS + cfg.IA.D.M.CALLS",
          "cfg.IA.CYCLES",
          "cfg.IB.GRID.at(0, 1).SEQ",
          "cfg.IB.GRID.at(1, 0).SEQ",
        ],
      ),
    });
    // Trace: g1, ga[0], ga[1], then gn's members (inner, arr[1], arr[2])
    // and gn; then IB (y, grid row-major), then IA: x, d (member m, then FB_B0, FB_B2; FB_B1
    // has none), dd with its default input.
    expect(stdout).toBe(
      "1 2 2 30 40 40 3 60 70 70 70 70 50 7 105 211 9 | 1 2 3 5 6 | 6 0 17 | 3 2 10 11",
    );
  });

  it("without a CONFIGURATION, globals run with the first program constructed", () => {
    const result = compile(FB_INIT_E2E_SOURCE, {
      fileName: "main.st",
      features: ["+fb_init"],
    });
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode!,
      cppCode: result.cppCode!,
      testName: "fb_init_standalone",
      mainCode: mainCode(
        `    strucpp::Program_PA a;
    strucpp::Program_PB b;
    a.run(); b.run();`,
        ["a.X.CALLS + b.Y.CALLS", "b.GRID.at(1, 1).SEQ"],
      ),
    });
    expect(stdout).toBe(
      "1 2 2 30 40 40 3 50 7 105 211 9 60 70 70 70 70 | 1 2 3 5 6 | 6 0 17 | 2 17",
    );
  });

  it("a 4-dimensional array runs every element in index order", () => {
    const result = compile(
      `VAR_GLOBAL cnt : INT; END_VAR
FUNCTION_BLOCK FB_K
VAR_OUTPUT seq : INT; END_VAR
METHOD FB_init
VAR_INPUT k : INT; END_VAR
cnt := cnt + k;
seq := cnt;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM P
VAR a4 : ARRAY[0..1, 0..1, 0..1, 1..2] OF FB_K(k := 1); END_VAR
END_PROGRAM
`,
      { fileName: "main.st", features: ["+fb_init"] },
    );
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode!,
      cppCode: result.cppCode!,
      testName: "fb_init_4d",
      mainCode: `
#include <cstdio>
int main() {
    strucpp::Program_P p;
    std::printf("%d %d %d %d\\n", static_cast<int>(strucpp::CNT),
        static_cast<int>(p.A4[0][0][0][1].SEQ), static_cast<int>(p.A4[0][1][0][2].SEQ),
        static_cast<int>(p.A4[1][1][1][2].SEQ));
    return 0;
}
`,
    });
    expect(stdout).toBe("16 1 6 16");
  });

  it("a member's init argument passes on its holder's FB_init input, through three levels", () => {
    const result = compile(
      `INTERFACE I_X
METHOD Val : INT
END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB_Impl IMPLEMENTS I_X
VAR_INPUT k : INT; END_VAR
METHOD Val : INT
Val := k;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Inner
VAR_OUTPUT got : INT; END_VAR
VAR stored : I_X; END_VAR
METHOD FB_init : BOOL
VAR_INPUT bInitRetains : BOOL; bInCopyCode : BOOL; itf : I_X; END_VAR
stored := itf;
got := stored.Val();
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Probe
VAR_OUTPUT v : INT; END_VAR
METHOD FB_init
VAR_INPUT v0 : INT; END_VAR
v := v0;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Outer
VAR itfStored : I_X; seen : INT := 7; END_VAR
VAR inner : FB_Inner(itf := itfIn); probe : FB_Probe(v0 := seen); END_VAR
METHOD FB_init : BOOL
VAR_INPUT bInitRetains : BOOL; bInCopyCode : BOOL; itfIn : I_X; END_VAR
itfStored := itfIn;
seen := 99;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_C
VAR_OUTPUT n : INT; END_VAR
METHOD FB_init
VAR_INPUT n0 : INT; END_VAR
n := n0;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_B
VAR m : INT := 1; c : FB_C(n0 := m * 10); END_VAR
METHOD FB_init
VAR_INPUT m : INT; END_VAR
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_A3
VAR b : FB_B(m := depth + 1); END_VAR
METHOD FB_init
VAR_INPUT depth : INT := 2; END_VAR
END_METHOD
END_FUNCTION_BLOCK
PROGRAM P
VAR
  impl : FB_Impl := (k := 42);
  outer : FB_Outer(itfIn := impl);
  a : FB_A3(depth := 4);
  a2 : FB_A3;
END_VAR
END_PROGRAM
`,
      { fileName: "main.st", features: ["+fb_init"] },
    );
    expect(result.errors).toEqual([]);
    expect(
      result.warnings.map((w) => `${w.line}:${w.column} ${w.message}`),
    ).toEqual([
      "29:60 PROBE's FB_init runs before FB_OUTER.FB_init, so 'SEEN' still has its initial value here",
    ]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode!,
      cppCode: result.cppCode!,
      testName: "fb_init_pass_through",
      mainCode: `
#include <cstdio>
int main() {
    strucpp::Program_P p;
    std::printf("%d %d %d %d %d\\n", static_cast<int>(p.OUTER.INNER.GOT),
        static_cast<int>(p.OUTER.PROBE.V), static_cast<int>(p.OUTER.SEEN),
        static_cast<int>(p.A.B.C.N), static_cast<int>(p.A2.B.C.N));
    return 0;
}
`,
    });
    // inner calls through the interface its holder was given (42); probe
    // reads seen before FB_Outer.FB_init sets it (7, then 99); c gets
    // (depth + 1) * 10 through two holders, the input m shadowing member m;
    // a2 passes depth's default 2, so 30.
    expect(stdout).toBe("42 7 99 50 30");
  });

  it("with the feature off, FB_init never runs", () => {
    const off = FB_INIT_E2E_SOURCE.replace(
      /\(tag := \d+\)|\(a := 5, b := 6\)/g,
      "",
    ).replace(
      "IF bInitRetains OR bInCopyCode THEN trace[n] := -1; n := n + 1; END_IF;\n",
      "",
    );
    const result = compile(off, { fileName: "main.st" });
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((w) => w.message)).toEqual(
      Array(5).fill("FB_init is not run unless the feature fb_init is on"),
    );
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode!,
      cppCode: result.cppCode!,
      testName: "fb_init_off",
      mainCode: mainCode(
        `    strucpp::Program_PA a;
    a.run();`,
        ["a.X.CALLS + a.D.M.CALLS"],
      ),
    });
    expect(stdout).toBe("| 0 0 0 0 0 | 0 0 0 | 0");
  });
});
