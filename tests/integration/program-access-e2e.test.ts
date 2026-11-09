/**
 * A PROGRAM reached by name from another POU (feature program_methods), end
 * to end through g++: MAIN calls PRG_A.Bump(), an FB reads PRG_A.cnt and
 * PRG_A's own cyclic body sees the changes, because all three name the one
 * instance. Built with and without a CONFIGURATION, as separate translation
 * units (the harness's statics and the shared instance live in different TUs),
 * and through the test pipeline.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { compile } from "../../src/index.js";
import {
  hasGpp,
  CXX_STD,
  RUNTIME_INCLUDE_PATH,
  runE2ETestPipeline,
} from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;
const ON = { features: ["+program_methods"] };

const PRG = `PROGRAM PRG_A
VAR_INPUT inp : INT; END_VAR
VAR_OUTPUT done : BOOL; END_VAR
VAR cnt : INT; seen : INT; runs : INT; END_VAR
METHOD Bump : INT
VAR_INPUT k : INT; END_VAR
  cnt := cnt + k;
  Bump := cnt;
END_METHOD
  runs := runs + 1;
  seen := cnt;
  cnt := cnt + inp;
  done := cnt > 100;
  ACTION Reset: cnt := 0; END_ACTION
END_PROGRAM
FUNCTION_BLOCK FB_R
VAR_OUTPUT got : INT; END_VAR
  got := PRG_A.cnt;
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR r : FB_R; last : INT; ret : INT; END_VAR
  ret := PRG_A.Bump(k := 5);
  r();
  last := r.got;
END_PROGRAM
`;

describeIfGpp("a PROGRAM reached by name, end to end", () => {
  let tempDir: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-progaccess-"));
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** Compile ST, then link generated.cpp, the debug table and `main` as separate TUs and run. */
  function build(source: string, mainCpp: string, name: string): string {
    const result = compile(source, { headerFileName: "generated.hpp", ...ON });
    expect(result.errors.map((e) => `${e.line}: ${e.message}`)).toEqual([]);
    const dir = path.join(tempDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "generated.hpp"), result.headerCode);
    fs.writeFileSync(path.join(dir, "generated.cpp"), result.cppCode);
    fs.writeFileSync(path.join(dir, "main.cpp"), mainCpp);
    const units = ["main.cpp", "generated.cpp"];
    if (result.debugTableCpp !== undefined && mainCpp.includes("g_config")) {
      fs.writeFileSync(
        path.join(dir, "generated_debug.cpp"),
        result.debugTableCpp,
      );
      units.push("generated_debug.cpp");
    }
    const bin = path.join(dir, "run");
    execSync(
      `g++ -std=${CXX_STD} -w -I"${RUNTIME_INCLUDE_PATH}" -I"${dir}" ${units
        .map((u) => `"${path.join(dir, u)}"`)
        .join(" ")} -o "${bin}" 2>&1`,
      { encoding: "utf-8" },
    );
    return execSync(`"${bin}"`, { encoding: "utf-8", timeout: 5000 }).trim();
  }

  it("without a CONFIGURATION: MAIN and an FB reach the instance PRG_A's body runs on", () => {
    const out = build(
      PRG,
      `#include "generated.hpp"
#include <iostream>
using namespace strucpp;
static Program_MAIN m;
int main() {
  for (int i = 0; i < 2; ++i) { m.run(); __program_PRG_A.run(); }
  std::cout << __program_PRG_A.CNT.get() << ' ' << __program_PRG_A.SEEN.get()
            << ' ' << m.LAST.get() << ' ' << m.RET.get() << ' '
            << __program_PRG_A.RUNS.get() << std::endl;
  return 0;
}
`,
      "standalone",
    );
    // Bump adds 5 per cycle; the FB and PRG_A's body each see the sum so far.
    expect(out).toBe("10 10 10 10 2");
  });

  it("with a CONFIGURATION: the task's instance is the shared one, and the debug table reads it", () => {
    const src = `${PRG}CONFIGURATION C
  RESOURCE R ON PLC
    TASK T(INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM M WITH T : MAIN;
    PROGRAM PA WITH T : PRG_A;
  END_RESOURCE
END_CONFIGURATION
`;
    const debugMap = compile(src, {
      headerFileName: "generated.hpp",
      ...ON,
    }).debugMap;
    const leaf = debugMap?.leaves.find((l) => l.path === "PA.CNT");
    expect(leaf).toBeDefined();
    const out = build(
      src,
      `#include "generated.hpp"
#include "debug_dispatch.hpp"
#include <iostream>
strucpp::Configuration_C g_config;
using namespace strucpp;
int main() {
  for (int i = 0; i < 3; ++i) { g_config.M.run(); g_config.PA.run(); }
  uint8_t buf[8] = {0};
  debug::handle_read(${leaf!.arrayIdx}, ${leaf!.elemIdx}, buf);
  int16_t viaTable = (int16_t)(buf[0] | (buf[1] << 8));
  std::cout << (&g_config.PA == &__program_PRG_A) << ' '
            << g_config.PA.SEEN.get() << ' ' << g_config.M.LAST.get() << ' '
            << viaTable << std::endl;
  return 0;
}
`,
      "configuration",
    );
    expect(out).toBe("1 15 15 15");
  });

  it("calls the program body from MAIN with inputs and an output", () => {
    const out = build(
      `${PRG}PROGRAM CALLER
VAR b : BOOL; END_VAR
  PRG_A(inp := 60, done => b);
  PRG_A.Reset();
  PRG_A(70, done => b);
END_PROGRAM
`,
      `#include "generated.hpp"
#include <iostream>
using namespace strucpp;
static Program_CALLER c;
int main() {
  c.run();
  std::cout << __program_PRG_A.RUNS.get() << ' ' << __program_PRG_A.CNT.get()
            << ' ' << c.B.get() << std::endl;
  return 0;
}
`,
      "body_call",
    );
    // First call 0+60 (done FALSE), Reset, second call 0+70 (done FALSE).
    expect(out).toBe("2 70 0");
  });

  it("through the test pipeline, a test's program variable is the shared instance", () => {
    const { stdout, exitCode } = runE2ETestPipeline({
      sourceST: PRG,
      testST: `TEST 'MAIN reaches the instance the test runs'
VAR m : MAIN; a : PRG_A; END_VAR
  m();
  a();
  ASSERT_EQ(a.seen, 5);
  ASSERT_EQ(a.cnt, 5);
  ASSERT_EQ(m.last, 5);
END_TEST
`,
      compileOptions: ON,
    });
    expect(stdout).toContain("1 passed");
    expect(exitCode).toBe(0);
  });

  it("through the test pipeline, the shared instance keeps its state from one test to the next", () => {
    const { stdout, exitCode } = runE2ETestPipeline({
      sourceST: PRG,
      testST: `SETUP
VAR a : PRG_A; END_VAR
END_SETUP
TEST 'first'
  a();
  ASSERT_EQ(a.runs, 1);
END_TEST
TEST 'second sees the run of the first'
  a();
  ASSERT_EQ(a.runs, 2);
END_TEST
`,
      compileOptions: ON,
    });
    expect(stdout).toContain("2 passed");
    expect(exitCode).toBe(0);
  });
});
