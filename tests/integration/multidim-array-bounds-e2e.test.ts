/**
 * E2E: LOWER_BOUND / UPPER_BOUND of fixed 2D and 3D arrays (inline and a
 * named type) failed g++: the runtime arrays had no bound by dimension.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `TYPE T2 : ARRAY[1..2, 3..4] OF INT; END_TYPE
PROGRAM Main
VAR
  m2 : ARRAY[1..3, 0..4] OF INT; m3 : ARRAY[0..1, 2..5, -1..1] OF INT; t2 : T2;
  d : DINT; r1, r2, r3, r4, r5, r6, r7 : DINT;
END_VAR
r1 := LOWER_BOUND(m2, 1); r2 := UPPER_BOUND(m2, 2);
r3 := LOWER_BOUND(m3, 3); r4 := UPPER_BOUND(m3, 2); r5 := UPPER_BOUND(m3, 1);
r6 := UPPER_BOUND(t2, 2);
d := 2; r7 := LOWER_BOUND(m2, d);
END_PROGRAM
`;

describeIfGpp("multi-dimensional array bounds", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-mdbounds-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("answers each dimension", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const vars = ["R1", "R2", "R3", "R4", "R5", "R6", "R7"]
      .map((v) => `std::cout << p.${v}.get() << '|';`)
      .join(" ");
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "multidim_bounds",
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p;\n p.run();\n ${vars}\n std::cout << std::endl;\n return 0;\n}\n`,
    });
    expect(out).toBe("1|4|-1|5|1|4|0|");
  });
});
