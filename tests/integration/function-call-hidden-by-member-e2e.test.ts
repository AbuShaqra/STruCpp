/**
 * E2E: a FUNCTION or standard function called inside a POU that has a
 * member, local or parameter of the same name (any case) failed g++, the C++
 * variable hiding the function. The call is namespace-qualified and runs.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `FUNCTION G : INT
VAR_INPUT x : INT; END_VAR
G := x + 1;
END_FUNCTION
FUNCTION H : INT
VAR_INPUT x : INT; END_VAR
H := x * 3;
END_FUNCTION
FUNCTION K : INT
VAR h : INT := 2; END_VAR
K := H(h);
END_FUNCTION
FUNCTION_BLOCK FB
VAR g : INT := 5; END_VAR
VAR_OUTPUT o : INT; END_VAR
METHOD M : INT
M := G(g) * 10;
END_METHOD
o := G(g) + M();
END_FUNCTION_BLOCK
PROGRAM Main
VAR limit : INT := 50; fbi : FB; i1, i2, i3 : INT; END_VAR
i1 := LIMIT(0, limit, 10);
i2 := K();
fbi(); i3 := fbi.o;
END_PROGRAM
`;

describeIfGpp("function calls hidden by a variable of their name", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-fnhide-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("calls the function", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "function_hidden",
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p;\n p.run();\n std::cout << p.I1.get() << '|' << p.I2.get() << '|' << p.I3.get() << std::endl;\n return 0;\n}\n`,
    });
    // LIMIT 10; H(2) = 6; G(5) + G(5) * 10 = 66
    expect(out).toBe("10|6|66");
  });
});
