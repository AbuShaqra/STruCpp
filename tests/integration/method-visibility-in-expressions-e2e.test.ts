/**
 * E2E: the calls the visibility check keeps build and run: public methods in
 * expressions and conditions, and a PROTECTED base method used by a derived
 * FB through THIS and bare.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `FUNCTION_BLOCK FB
METHOD PRIVATE Pm : INT
Pm := 1;
END_METHOD
METHOD PROTECTED Qm : INT
Qm := 2;
END_METHOD
METHOD Pub : INT
Pub := Pm() + Qm();
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK D EXTENDS FB
METHOD Use : INT
Use := THIS.Qm() * 10 + Qm();
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main
VAR f : FB; d : D; i : INT; END_VAR
IF f.Pub() = 3 THEN i := 100; END_IF;
i := i + d.Use();
END_PROGRAM
`;

describeIfGpp("method visibility in expressions", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-visexpr-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("runs the allowed calls", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "visibility_expr",
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p;\n p.run();\n std::cout << p.I.get() << std::endl;\n return 0;\n}\n`,
    });
    expect(out).toBe("122");
  });
});
