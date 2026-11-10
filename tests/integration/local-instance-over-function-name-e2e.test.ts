/**
 * An FB instance named like a FUNCTION or standard function (`VAR f : FB`
 * with `FUNCTION F`, `VAR limit : FB`) was refused when invoked; an inherited
 * member instance invoked in a derived FB failed g++. g++ runs both now.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `FUNCTION F : INT
VAR_INPUT x : INT; END_VAR
F := x;
END_FUNCTION
FUNCTION_BLOCK FB
VAR_INPUT k : INT; IN : INT; END_VAR
VAR_OUTPUT o : INT; END_VAR
o := k + IN + 7;
END_FUNCTION_BLOCK
FUNCTION_BLOCK Base
VAR f : FB; END_VAR
END_FUNCTION_BLOCK
FUNCTION_BLOCK Derived EXTENDS Base
VAR_OUTPUT i : INT; END_VAR
METHOD M : INT
f(k := 2); M := f.o;
END_METHOD
f(k := 1); i := f.o + M() * 100;
END_FUNCTION_BLOCK
FUNCTION G : INT
G := F(40);
END_FUNCTION
PROGRAM Main
VAR f : FB; limit : FB; d : Derived; i, j, k, l : INT; END_VAR
f(k := 3); i := f.o;
limit(IN := 4); j := limit.o;
d(); k := d.i;
l := G();
END_PROGRAM
`;

describeIfGpp("FB instance over a function of its name", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-localinst-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("invokes the instance", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "local_instance",
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p;\n p.run();\n std::cout << p.I.get() << ' ' << p.J.get() << ' ' << p.K.get() << ' ' << p.L.get() << std::endl;\n return 0;\n}\n`,
    });
    // f: 3 + 7; limit: 4 + 7; d: 8 + 9 * 100; G = F(40)
    expect(out).toBe("10 11 908 40");
  });
});
