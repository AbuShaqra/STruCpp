/**
 * E2E: the enumeration forms the new checks keep run: an enumeration and its
 * aliases bound to each other's inputs, a CASE over an alias selector with
 * labels of the enumeration and its alias, and `E#M` next to a variable
 * named E (refused as "not an enumeration" before).
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
TYPE E : (P, Q); END_TYPE
FUNCTION FA : INT
VAR_INPUT k : EA; END_VAR
IF k = Col#C THEN FA := 7; ELSE FA := 1; END_IF;
END_FUNCTION
PROGRAM Main
VAR c : Col := Col#B; ca : EA := Col#C; e : E := E#Q; i1, i2, i3 : INT; END_VAR
i1 := FA(c) * 10 + FA(ca);
CASE ca OF EA#A: i2 := 1; Col#C: i2 := 3; ELSE i2 := 9; END_CASE;
IF e = E#Q THEN i3 := 5; END_IF;
END_PROGRAM
`;

describeIfGpp("enumeration forms that run", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-enummis-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("runs", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const vars = ["I1", "I2", "I3"]
      .map((v) => `std::cout << p.${v}.get() << '|';`)
      .join(" ");
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "enum_misuse",
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p;\n p.run();\n ${vars}\n std::cout << std::endl;\n return 0;\n}\n`,
    });
    expect(out).toBe("17|3|5|");
  });
});
