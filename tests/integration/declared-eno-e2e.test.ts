/**
 * A block that declares ENO failed g++ (redeclaration of the implicit ENO
 * member). A declared BOOL ENO is now the block's ENO output: TRUE before the
 * body, which may clear it, FALSE when EN is FALSE. g++ runs it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `FUNCTION_BLOCK FB
VAR_INPUT x : INT; END_VAR
VAR_OUTPUT ENO : BOOL; END_VAR
ENO := x > 0;
END_FUNCTION_BLOCK
FUNCTION_BLOCK Base
VAR_OUTPUT o : INT; END_VAR
o := 1;
END_FUNCTION_BLOCK
FUNCTION_BLOCK Derived EXTENDS Base
VAR_INPUT x : INT; END_VAR
VAR ENO : BOOL; END_VAR
ENO := x > 0;
END_FUNCTION_BLOCK
PROGRAM Main
VAR
  f : FB; d : Derived;
  a, b, c, e, g, h, k : BOOL;
  eno : BOOL;
END_VAR
f(x := 1, ENO => a);
f(x := -1, ENO => b);
f(EN := FALSE, x := 5, ENO => c);
f(EN := TRUE, x := -5); e := f.ENO;
d(x := -1); g := d.ENO;
d(x := 1, ENO => h);
eno := TRUE; k := eno;
END_PROGRAM
`;

describeIfGpp("declared ENO", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-eno-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("keeps the value the body gives ENO", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const vars = ["A", "B", "C", "E", "G", "H", "K"]
      .map((v) => `std::cout << p.${v}.get();`)
      .join(" ");
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "declared_eno",
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p;\n p.run();\n ${vars}\n std::cout << std::endl;\n return 0;\n}\n`,
    });
    expect(out).toBe("1000011");
  });
});
