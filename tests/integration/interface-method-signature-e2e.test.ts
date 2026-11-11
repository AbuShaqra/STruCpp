/**
 * Interface implementations the signature check accepts build and run: a
 * parameter named otherwise (a warning), a default value, STRING and
 * STRING(254), and an output for an in/out.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `INTERFACE I
METHOD M : INT
VAR_INPUT a : INT; s : STRING; END_VAR
VAR_OUTPUT o : INT; END_VAR
END_METHOD
METHOD N : INT
VAR_INPUT a : INT; END_VAR
END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB IMPLEMENTS I
METHOD M : INT
VAR_INPUT a : INT := 5; s : STRING(254); END_VAR
VAR_IN_OUT o : INT; END_VAR
o := a * 2; M := a + LEN(s);
END_METHOD
METHOD N : INT
VAR_INPUT b : INT; END_VAR
N := b * 10;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main
VAR f : FB; i : I; r, q, t : INT; END_VAR
i := f;
r := i.M(a := 3, s := 'xy', o => q);
t := f.N(4) + i.N(a := 5);
END_PROGRAM
`;

describeIfGpp("interface method signatures", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-ifsig-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("runs the accepted implementations", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((w) => w.message)).toContain(
      "Parameter 1 'B' of method 'N' of FUNCTION_BLOCK 'FB' is named 'A' in interface 'I': a call with named arguments through the FB differs from one through the interface",
    );
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "iface_sig",
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p;\n p.run();\n std::cout << p.R.get() << ' ' << p.Q.get() << ' ' << p.T.get() << std::endl;\n return 0;\n}\n`,
    });
    expect(out).toBe("5 6 90");
  });
});
