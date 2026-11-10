/**
 * A bare call naming a method of the enclosing PROGRAM or FUNCTION_BLOCK
 * calls the method even when a FUNCTION or standard function has its name;
 * the C++ member call does too. g++ runs it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `FUNCTION F : INT
VAR_INPUT x : INT; y : INT; END_VAR
F := x * 10 + y;
END_FUNCTION
FUNCTION_BLOCK Base
METHOD F : INT
VAR_INPUT b : INT; a : INT; END_VAR
F := a * 100 + b;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK Derived EXTENDS Base
VAR_OUTPUT i, j : INT; END_VAR
i := F(a := 1, b := 2);
j := F(3, 4);
END_FUNCTION_BLOCK
FUNCTION G : INT
G := F(y := 6, x := 5);
END_FUNCTION
PROGRAM Main
VAR d : Derived; i : DINT; j, k, l : INT; m : BOOL; END_VAR
METHOD LIMIT : INT
VAR_INPUT a : INT; b : INT; END_VAR
LIMIT := a * 100 + b;
END_METHOD
d();
i := d.i + d.j * 1000;
j := LIMIT(b := 2, a := 1);
k := LIMIT(3, 4);
l := G();
m := MID(IN := 'ABC', L := 1, P := 2) = 'B';
END_PROGRAM
`;

describeIfGpp("own method over a function of its name", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-ownmethod-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("runs the method in the block and the FUNCTION outside it", () => {
    const result = compile(SOURCE, {
      headerFileName: "generated.hpp",
      features: ["+program_methods"],
    });
    expect(result.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "own_method",
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p;\n p.run();\n std::cout << p.I.get() << ' ' << p.J.get() << ' ' << p.K.get() << ' ' << p.L.get() << std::endl;\n return 0;\n}\n`,
    });
    // d.i = 102, d.j = 403; LIMIT method 102 and 304; G = 56
    expect(out).toBe("403102 102 304 56");
  });
});
