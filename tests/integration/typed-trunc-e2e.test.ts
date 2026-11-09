/**
 * Typed truncation end to end (g++): TRUNC_<int> and <real>_TRUNC_<int>
 * truncate toward zero, saturate out-of-range values at the target's limits
 * and give 0 for NaN, as the REAL/LREAL to integer conversions do.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

describeIfGpp("typed truncation — generated C++", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-ttrunc-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** Runs `body` in a PROGRAM with the given VARs and prints the named vars. */
  function run(
    vars: string,
    body: string,
    print: string[],
    name: string,
    dialect?: string,
  ): string[] {
    const source = `PROGRAM MAIN
VAR
${vars}
END_VAR
${body}
END_PROGRAM
`;
    const result = compile(source, {
      headerFileName: "generated.hpp",
      dialect,
    });
    expect(result.errors.map((e) => `${e.line}: ${e.message}`)).toEqual([]);
    const prints = print
      .map((p) =>
        p.startsWith("U")
          ? `std::cout << (unsigned long long)p.${p}.get() << " ";`
          : `std::cout << (long long)p.${p}.get() << " ";`,
      )
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

  it("truncates toward zero, positive and negative, REAL and LREAL (iec-3)", () => {
    const out = run(
      "r : REAL := -2.7; lr : LREAL := 3.9; a, b, c, d : INT; e, f : DINT; g : SINT; h : LINT;",
      `a := TRUNC_INT(r); b := TRUNC_INT(lr); c := REAL_TRUNC_INT(r);
d := LREAL_TRUNC_INT(-lr); e := TRUNC_DINT(-2.5); f := LREAL_TRUNC_DINT(-LREAL#0.9);
g := REAL_TRUNC_SINT(r * 10.0); h := LREAL_TRUNC_LINT(LREAL#3.0E10 + 0.75);`,
      ["A", "B", "C", "D", "E", "F", "G", "H"],
      "ttrunc_basic",
      "iec-3",
    );
    expect(out).toEqual([
      "-2",
      "3",
      "-2",
      "-3",
      "-2",
      "0",
      "-27",
      "30000000000",
    ]);
  });

  it("saturates out-of-range values at the target's limits", () => {
    const out = run(
      "big : REAL := 1.0E6; a, b : SINT; c, d : INT; e : DINT; f : LINT; g : USINT; h : UINT;",
      `a := TRUNC_SINT(big); b := REAL_TRUNC_SINT(-big);
c := TRUNC_INT(LREAL#40000.5); d := LREAL_TRUNC_INT(-LREAL#40000.5);
e := REAL_TRUNC_DINT(3.0E9); f := LREAL_TRUNC_LINT(-LREAL#1.0E19);
g := TRUNC_USINT(-1.5); h := REAL_TRUNC_UINT(big);`,
      ["A", "B", "C", "D", "E", "F", "G", "H"],
      "ttrunc_sat",
    );
    expect(out).toEqual([
      "127",
      "-128",
      "32767",
      "-32768",
      "2147483647",
      "-9223372036854775808",
      "0",
      "65535",
    ]);
  });

  it("covers the unsigned 32/64-bit targets and NaN", () => {
    const out = run(
      "r : REAL := -1.0; ua, ub : UDINT; uc, ud : ULINT; n : DINT;",
      `ua := TRUNC_UDINT(LREAL#4000000000.9); ub := REAL_TRUNC_UDINT(-7.9);
uc := LREAL_TRUNC_ULINT(LREAL#1.0E20); ud := TRUNC_ULINT(LREAL#12345678901.5);
n := TRUNC_DINT(SQRT(r));`,
      ["UA", "UB", "UC", "UD", "N"],
      "ttrunc_unsigned",
    );
    expect(out).toEqual([
      "4000000000",
      "0",
      "18446744073709551615",
      "12345678901",
      "0",
    ]);
  });
});
