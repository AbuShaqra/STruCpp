import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

describeIfGpp("CONTINUE end to end", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-continue-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function run(loop: string, name: string): string {
    const source = `VAR_GLOBAL n : INT; END_VAR\nPROGRAM Main\nVAR i : INT; END_VAR\n${loop}\nEND_PROGRAM\n`;
    const result = compile(source, { headerFileName: "generated.hpp" });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    return compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: name,
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p;\n p.run();\n std::cout << N.get() << std::endl;\n return 0;\n}\n`,
    });
  }

  it("FOR skips i = 3 (n = 12)", () => {
    expect(
      run(
        "FOR i := 1 TO 5 DO IF i = 3 THEN CONTINUE; END_IF; n := n + i; END_FOR;",
        "continue_for",
      ),
    ).toBe("12");
  });

  it("WHILE continue still advances", () => {
    expect(
      run(
        "i := 0; WHILE i < 5 DO i := i + 1; IF i = 3 THEN CONTINUE; END_IF; n := n + i; END_WHILE;",
        "continue_while",
      ),
    ).toBe("12");
  });

  it("REPEAT continue re-tests the condition", () => {
    expect(
      run(
        "i := 0; REPEAT i := i + 1; IF i = 3 THEN CONTINUE; END_IF; n := n + i; UNTIL i >= 5 END_REPEAT;",
        "continue_repeat",
      ),
    ).toBe("12");
  });

  it("CASE inside FOR continues the loop", () => {
    expect(
      run(
        "FOR i := 1 TO 5 DO CASE i OF 3: CONTINUE; END_CASE; n := n + i; END_FOR;",
        "continue_case",
      ),
    ).toBe("12");
  });
});
