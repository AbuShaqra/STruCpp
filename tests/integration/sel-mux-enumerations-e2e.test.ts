/**
 * E2E: SEL and MUX of an enumeration variable next to values of its
 * enumeration were refused ("Cannot assign ANY") or failed g++; they select
 * the value and run.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `TYPE Col : (A, B, C); END_TYPE
TYPE EA : Col; END_TYPE
PROGRAM Main
VAR c : Col := Col#B; ca : EA := Col#C; g : BOOL := TRUE; r1, r2, r3 : Col; i : INT; END_VAR
r1 := SEL(g, Col#A, c);
r2 := MUX(2, Col#A, c, ca);
r3 := SEL(G := FALSE, IN1 := ca, IN0 := c);
IF SEL(g, c, Col#A) = Col#A THEN i := 1; END_IF;
IF r1 = Col#B THEN i := i + 10; END_IF;
IF r2 = Col#C THEN i := i + 100; END_IF;
IF r3 = Col#B THEN i := i + 1000; END_IF;
END_PROGRAM
`;

describeIfGpp("SEL / MUX of enumerations", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-selenum-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("selects", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "sel_mux_enum",
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p;\n p.run();\n std::cout << p.I.get() << std::endl;\n return 0;\n}\n`,
    });
    expect(out).toBe("1111");
  });
});
