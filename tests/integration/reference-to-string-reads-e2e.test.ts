/**
 * E2E: a REFERENCE TO STRING or WSTRING read as a value (string functions,
 * comparison, assignment from it) failed g++; so did a STRING variable passed
 * to a REFERENCE TO STRING input. g++ runs both now.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `FUNCTION FR : INT
VAR_INPUT r : REFERENCE TO STRING(3); END_VAR
r := CONCAT(r, 'z'); FR := LEN(r);
END_FUNCTION
PROGRAM Main
VAR
  x : STRING(3) := 'ab'; y : STRING(3) := 'q'; w : WSTRING(3) := "abc";
  rr, r2 : REFERENCE TO STRING(3); rw : REFERENCE TO WSTRING(3);
  i1, i2, i3, i4, i5 : INT; s : STRING; b : BOOL;
END_VAR
rr REF= x; rw REF= w;
i1 := LEN(rr) * 10 + LEN(rw);
s := CONCAT(rr, '-'); i2 := LEN(s);
b := rr = 'ab'; i3 := BOOL_TO_INT(b);
i4 := FR(x) * 10 + LEN(x);
r2 REF= y; i5 := FR(r2) * 10 + FIND(y, 'z');
END_PROGRAM
`;

describeIfGpp("REFERENCE TO STRING reads", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-refstr-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("reads and passes the bound string", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const vars = ["I1", "I2", "I3", "I4", "I5"]
      .map((v) => `std::cout << p.${v}.get() << '|';`)
      .join(" ");
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "reference_string_reads",
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p;\n p.run();\n ${vars}\n std::cout << std::endl;\n return 0;\n}\n`,
    });
    expect(out).toBe("23|3|1|33|22|");
  });
});
