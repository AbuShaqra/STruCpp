/**
 * Named arguments of FB instance calls through g++: the forms the
 * unknown-name check keeps accepting (inputs, inherited inputs, outputs
 * and in/outs, on plain, member and chain calls) build and run.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

describeIfGpp("FB instance call named arguments end to end", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-fbnamed-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("plain, member and chain calls bind by name", () => {
    const result = compile(
      `FUNCTION_BLOCK FB_Sub
VAR_INPUT a : INT; END_VAR
VAR_OUTPUT q : INT; END_VAR
VAR_IN_OUT io : INT; END_VAR
VAR_INPUT loc : INT; END_VAR
q := a * 10 + loc;
io := io + 1;
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_SubX EXTENDS FB_Sub
VAR_INPUT b : INT; END_VAR
q := a * 100 + b;
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Mid
VAR PUBLIC sub : FB_Sub; subx : FB_SubX; END_VAR
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Outer
VAR PUBLIC sub : FB_Sub; m : FB_Mid; END_VAR
END_FUNCTION_BLOCK
PROGRAM Main
VAR s : FB_Sub; o : FB_Outer; v : INT; r1 : INT; r2 : INT; r3 : INT; END_VAR
s(loc := 4, a := 1, io := v, q => r1);
o.sub(a := 2, io := v, q => r2);
o.m.subx(b := 5, a := 3, io := v, q => r3);
END_PROGRAM
`,
      { headerFileName: "generated.hpp" },
    );
    expect(result.errors.map((e) => `${e.line}: ${e.message}`)).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "fb_named",
      mainCode: `#include <iostream>
int main() {
 using namespace strucpp;
 Program_MAIN p;
 p.run();
 std::cout << p.R1.get() << " " << p.R2.get() << " " << p.R3.get() << " " << p.V.get() << std::endl;
 return 0;
}
`,
    });
    expect(out).toBe("14 20 305 2");
  });
});
