/**
 * E2E: LOWER_BOUND / UPPER_BOUND with named arguments in reverse order, in a
 * body, a local initial value and a global initial value (an initial value
 * kept the source order, so DIM was taken for the array).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `VAR_GLOBAL
  ga : ARRAY[3..9] OF INT;
  g1 : DINT := UPPER_BOUND(DIM := 1, ARR := ga);
END_VAR
PROGRAM Main
VAR
  a : ARRAY[2..7] OF INT; m : ARRAY[1..3, -4..5] OF INT;
  l1 : DINT := LOWER_BOUND(DIM := 2, ARR := m);
  r1, r2, r3, r4, r5 : DINT;
END_VAR
r1 := UPPER_BOUND(DIM := 1, ARR := a);
r2 := LOWER_BOUND(DIM := 1, ARR := a);
r3 := UPPER_BOUND(DIM := 2, ARR := m);
r4 := l1;
r5 := g1;
END_PROGRAM
`;

describeIfGpp("LOWER_BOUND / UPPER_BOUND named arguments", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-boundnamed-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("binds ARR and DIM by name in every position", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const vars = ["R1", "R2", "R3", "R4", "R5"]
      .map((v) => `std::cout << p.${v}.get() << '|';`)
      .join(" ");
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "bound_named",
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p;\n p.run();\n ${vars}\n std::cout << std::endl;\n return 0;\n}\n`,
    });
    expect(out).toBe("7|2|5|-4|9|");
  });
});
