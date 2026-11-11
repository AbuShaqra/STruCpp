/**
 * E2E: the REF= and REF_TO forms the new checks accept still build and run:
 * REF= of the referenced type, a REFERENCE TO rebound to another one, and a
 * REF_TO STRING(3) and an alias of it referring to each other's variables.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `TYPE S3 : STRING(3); END_TYPE
PROGRAM Main
VAR
  x : INT := 5; y : INT := 7; t3 : STRING(3) := 'abc'; sa : S3 := 'de';
  r : REF_TO INT; a, b : REFERENCE TO INT; q : REF_TO STRING(3); qa : REF_TO S3;
  i1, i2, i3, i4 : INT;
END_VAR
r REF= x; i1 := r^;
a REF= y; b REF= a; i2 := b;
q := REF(sa); i3 := LEN(q^);
qa := REF(t3); i4 := LEN(qa^);
END_PROGRAM
`;

describeIfGpp("REF= and STRING alias references", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-refeq-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("runs the accepted forms", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const vars = ["I1", "I2", "I3", "I4"]
      .map((v) => `std::cout << p.${v}.get() << '|';`)
      .join(" ");
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "ref_assign_alias",
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p;\n p.run();\n ${vars}\n std::cout << std::endl;\n return 0;\n}\n`,
    });
    expect(out).toBe("5|7|2|3|");
  });
});
