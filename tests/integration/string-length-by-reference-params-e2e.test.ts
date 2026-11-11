/**
 * E2E: STRING(n) in/outs and outputs of FUNCTIONs and METHODs. An argument
 * of the declared length failed g++; it binds by reference now. An argument
 * of another length is copied through a STRING(n) temporary, so a longer
 * value is truncated to n characters inside the call.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `FUNCTION FL : INT
VAR_IN_OUT s : STRING(5); END_VAR
s := CONCAT(s, 'xyz'); FL := LEN(s);
END_FUNCTION
FUNCTION FO : INT
VAR_OUTPUT o : STRING(5); END_VAR
o := 'abcdefgh'; FO := 2;
END_FUNCTION
FUNCTION_BLOCK FB
METHOD M : INT
VAR_IN_OUT s : STRING(20); END_VAR
s := CONCAT(s, '!'); M := LEN(s);
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main
VAR
  f : FB; r1, r2, r3, r4, r5 : INT;
  t5 : STRING(5) := 'ab'; u : STRING := 'abcd'; w5 : STRING(5); w : STRING;
  t20 : STRING(20) := 'abc';
END_VAR
r1 := FL(t5);
r2 := FL(s := u);
r3 := FO(o => w5);
r4 := FO(o => w);
r5 := f.M(s := t20);
END_PROGRAM
`;

describeIfGpp("STRING(n) parameters passed by reference", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-strref-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("binds or copies by length", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const ints = ["R1", "R2", "R3", "R4", "R5"]
      .map((v) => `std::cout << p.${v}.get() << '|';`)
      .join(" ");
    const strings = ["T5", "U", "W5", "W", "T20"]
      .map((v) => `std::cout << p.${v}.get().c_str() << '|';`)
      .join(" ");
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "string_ref_params",
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p;\n p.run();\n ${ints} ${strings}\n std::cout << std::endl;\n return 0;\n}\n`,
    });
    // u ('abcd', STRING) is truncated to 5 inside FL; w gets the 5-char output.
    expect(out).toBe("5|5|2|2|4|abxyz|abcdx|abcde|abcde|abc!|");
  });
});
