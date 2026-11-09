/**
 * REAL/LREAL to integer conversions saturate (NaN gives 0) instead of hitting
 * C++ undefined behaviour; TRUNC returns DINT (REAL) / LINT (LREAL).
 * REAL_TO_BOOL keeps rounding (0.4 is FALSE).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

describeIfGpp("float to integer saturation — generated C++", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-f2i-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** Runs `body` in a PROGRAM with the given VARs and prints the named vars. */
  function run(vars: string, body: string, print: string[], name: string) {
    const source = `PROGRAM MAIN
VAR
${vars}
END_VAR
${body}
END_PROGRAM
`;
    const result = compile(source, { headerFileName: "generated.hpp" });
    expect(result.errors.map((e) => `${e.line}: ${e.message}`)).toEqual([]);
    const prints = print
      .map((p) => `std::cout << (long long)p.${p}.get() << " ";`)
      .join(" ");
    return compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: name,
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p; p.run();\n ${prints}\n return 0;\n}\n`,
    })
      .trim()
      .split(/\s+/);
  }

  it("REAL_TO_DINT / INT / UINT saturate at the target range", () => {
    const out = run(
      "a, b : DINT; c : INT; d : UINT; r : REAL;",
      `a := REAL_TO_DINT(3.0E9); b := REAL_TO_DINT(-3.0E9);
c := REAL_TO_INT(1.0E6); d := REAL_TO_UINT(-1.0);`,
      ["A", "B", "C", "D"],
      "f2i_sat",
    );
    expect(out).toEqual(["2147483647", "-2147483648", "32767", "0"]);
  });

  it("LREAL_TO_LINT saturates at both ends", () => {
    const out = run(
      "a, b : LINT;",
      "a := LREAL_TO_LINT(1.0E19); b := LREAL_TO_LINT(-1.0E19);",
      ["A", "B"],
      "f2i_lint",
    );
    expect(out).toEqual(["9223372036854775807", "-9223372036854775808"]);
  });

  it("NaN converts to 0", () => {
    const out = run(
      "a : DINT; r : REAL;",
      "r := -1.0; a := REAL_TO_DINT(SQRT(r));",
      ["A"],
      "f2i_nan",
    );
    expect(out).toEqual(["0"]);
  });

  it("REAL_TO_BOOL still rounds (0.4 FALSE, 0.6 TRUE)", () => {
    const out = run(
      "a, b : BOOL;",
      "a := REAL_TO_BOOL(0.4); b := REAL_TO_BOOL(0.6);",
      ["A", "B"],
      "f2i_bool",
    );
    expect(out).toEqual(["0", "1"]);
  });

  it("REAL_TO_INT keeps round-half-away rounding", () => {
    const out = run(
      "a, b : INT;",
      "a := REAL_TO_INT(2.5); b := REAL_TO_INT(-2.5);",
      ["A", "B"],
      "f2i_round",
    );
    expect(out).toEqual(["3", "-3"]);
  });

  it("TRUNC(-REAL#2.7) into a DINT is -2", () => {
    const out = run("a : DINT;", "a := TRUNC(-REAL#2.7);", ["A"], "trunc_real");
    expect(out).toEqual(["-2"]);
  });

  it("TRUNC(LREAL#3.0E10) into a LINT keeps all digits", () => {
    const out = run(
      "a : LINT;",
      "a := TRUNC(LREAL#3.0E10);",
      ["A"],
      "trunc_lreal",
    );
    expect(out).toEqual(["30000000000"]);
  });

  it("TRUNC of a bare REAL literal and of a literal expression saturates a DINT", () => {
    const out = run(
      "d, e : DINT; big : REAL;",
      "big := 3.0E9; d := TRUNC(3.0E9); e := TRUNC(big * 2.0);",
      ["D", "E"],
      "trunc_lit_sat",
    );
    expect(out).toEqual(["2147483647", "2147483647"]);
  });

  it("TRUNC(REAL#3.0E9) saturates at DINT max", () => {
    const out = run("a : DINT;", "a := TRUNC(REAL#3.0E9);", ["A"], "trunc_sat");
    expect(out).toEqual(["2147483647"]);
  });
});
