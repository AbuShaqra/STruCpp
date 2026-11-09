/**
 * The feature trunc_dint end to end (g++): TRUNC(LREAL) is a DINT,
 * truncated toward zero and saturated at the DINT range; without the
 * feature it stays a LINT.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

describeIfGpp("trunc_dint — generated C++", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-truncdint-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const SOURCE = `PROGRAM MAIN
VAR
  lr : LREAL := 3.0E10;
  neg : LREAL := -7.9;
  r : REAL := -2.7;
  a, b, c : LINT;
  d : DINT;
END_VAR
a := TRUNC(lr);
b := TRUNC(neg);
c := TRUNC(-lr);
d := TRUNC(r);
END_PROGRAM
`;

  function run(features: string[] | undefined, name: string): string[] {
    const result = compile(SOURCE, {
      headerFileName: "generated.hpp",
      features,
    });
    expect(result.errors.map((e) => `${e.line}: ${e.message}`)).toEqual([]);
    const prints = ["A", "B", "C", "D"]
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

  it("with trunc_dint, TRUNC(LREAL) saturates at the DINT range", () => {
    expect(run(["+trunc_dint"], "truncdint_on")).toEqual([
      "2147483647",
      "-7",
      "-2147483648",
      "-2",
    ]);
  });

  it("without it, TRUNC(LREAL) keeps every LINT digit", () => {
    expect(run(undefined, "truncdint_off")).toEqual([
      "30000000000",
      "-7",
      "-30000000000",
      "-2",
    ]);
  });
});
