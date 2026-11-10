/**
 * A FUNCTION call with a named argument that names no parameter dropped the
 * argument and ran with the default (F(a := 1, bb := 2) gave a + 5), and
 * `PRG_A.nope()` inside PRG_A failed g++. Both are refused now; the correctly
 * named forms still compile and run, which g++ proves here.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = (call: string): string => `FUNCTION F_ADD : INT
VAR_INPUT a : INT; b : INT := 5; END_VAR
VAR_OUTPUT o : INT; END_VAR
F_ADD := a * 10 + b;
o := a + b;
END_FUNCTION
PROGRAM Main
VAR r : INT; q : INT; s : INT; END_VAR
METHOD M : INT
VAR_INPUT p : INT; END_VAR
M := p * 2;
END_METHOD
${call}
END_PROGRAM
`;

describe("unknown named arguments on function calls are refused", () => {
  it("a misspelled input no longer runs with the default", () => {
    const r = compile(SOURCE("r := F_ADD(a := 1, bb := 2, o => q);"), {
      features: ["+program_methods"],
    });
    expect(r.errors.map((e) => e.message)).toEqual([
      "Function 'F_ADD' has no parameter named 'BB'",
    ]);
  });

  it("an unknown method of the program by its own name", () => {
    const r = compile(SOURCE("r := MAIN.Nope(p := 1);"), {
      features: ["+program_methods"],
    });
    expect(r.errors.map((e) => e.message)).toEqual([
      "PROGRAM MAIN has no method or action 'NOPE'",
    ]);
  });
});

describeIfGpp("named function and self-qualified method calls run", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-fnnamed-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("binds the declared names, out of order, and the default", () => {
    const result = compile(
      SOURCE(
        "r := F_ADD(o => q, b := 2, a := 1) + F_ADD(a := 3) * 100; s := MAIN.M(p := 4);",
      ),
      { headerFileName: "generated.hpp", features: ["+program_methods"] },
    );
    expect(result.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "fn_named",
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p;\n p.run();\n std::cout << p.R.get() << ' ' << p.Q.get() << ' ' << p.S.get() << std::endl;\n return 0;\n}\n`,
    });
    // 12 + 35 * 100; q = 1 + 2; s = 4 * 2
    expect(out).toBe("3512 3 8");
  });
});
