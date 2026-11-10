/**
 * Inside PRG_A (feature program_methods), `PRG_A.x` names the program's
 * member also where a method declares a local `x`, and `PRG_A.zz` for a name
 * the program does not declare is an unknown-member error.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `
FUNCTION_BLOCK FB_C
VAR_INPUT inc : INT; END_VAR
VAR_OUTPUT total : INT; END_VAR
  total := total + inc;
END_FUNCTION_BLOCK
PROGRAM PRG_A
VAR x : INT := 5; arr : ARRAY[0..2] OF INT := [1, 2, 3]; c : FB_C; y1, y2, y3, y4 : INT; END_VAR
METHOD M : INT
VAR x : INT := 100; END_VAR
  x := x + 1;
  PRG_A.x := PRG_A.x + 2;
  M := PRG_A.x * 1000 + x;
END_METHOD
METHOD N : INT
VAR arr : INT := 40; c : INT := 9; i : INT; x : ARRAY[0..1] OF INT := [7, 8]; END_VAR
  FOR i := 0 TO 2 DO arr := arr + PRG_A.arr[i]; END_FOR;
  PRG_A.c(inc := c);
  PRG_A.c(inc := x[1]);
  N := arr + PRG_A.c.total + PRG_A.x;
END_METHOD
METHOD Plain : INT
  Plain := PRG_A.x + x;
END_METHOD
  y1 := M();
  y2 := N();
  y3 := Plain();
  y4 := PRG_A.x;
END_PROGRAM
`;

const OPTIONS = { features: ["+program_methods"] };

function errorsFor(source: string): string[] {
  return compile(source, OPTIONS).errors.map((e) => e.message);
}

describe("a program's own member by its qualified name", () => {
  it("reaches the member where a local has its name", () => {
    expect(errorsFor(SOURCE)).toEqual([]);
  });

  it("reports an unknown member as unknown", () => {
    expect(
      errorsFor(`PROGRAM PRG_A
VAR x : INT; y : INT; END_VAR
METHOD M : INT
  M := PRG_A.zz;
END_METHOD
  y := PRG_A.zz + PRG_A.x;
  PRG_A.qq := 1;
END_PROGRAM`).sort(),
    ).toEqual([
      "PROGRAM PRG_A has no variable 'QQ'",
      "PROGRAM PRG_A has no variable 'ZZ'",
      "PROGRAM PRG_A has no variable 'ZZ'",
    ]);
  });

  it("names the local by its own name in a diagnostic", () => {
    expect(
      errorsFor(`PROGRAM PRG_A
VAR x : INT; END_VAR
METHOD M : INT
VAR x : STRING; END_VAR
  M := x;
  PRG_A.x := 1;
END_METHOD
END_PROGRAM`),
    ).toEqual(["Cannot assign STRING to INT"]);
    expect(
      compile(
        `PROGRAM PRG_A
VAR x : INT; END_VAR
METHOD M : INT
VAR x : INT; END_VAR
  x := 300000;
  M := PRG_A.x;
END_METHOD
END_PROGRAM`,
        OPTIONS,
      )
        .warnings.concat(
          compile(
            `PROGRAM PRG_A
VAR x : INT; END_VAR
METHOD M : INT
VAR x : INT; END_VAR
  x := 300000;
  M := PRG_A.x;
END_METHOD
END_PROGRAM`,
            OPTIONS,
          ).errors,
        )
        .map((e) => e.message)
        .join("\n"),
    ).not.toMatch(/__/);
  });

  it("keeps the old message without the feature", () => {
    expect(
      compile(
        `PROGRAM PRG_A\nVAR x : INT; END_VAR\n  x := PRG_A.x;\nEND_PROGRAM`,
        {},
      ).errors.map((e) => e.message),
    ).toEqual([
      "Cannot access members of program 'PRG_A' directly — declare a variable of type 'PRG_A' first.",
    ]);
  });
});

describe.skipIf(!hasGpp)("a program's own member, end to end", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-prgself-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it.each([
    ["features", OPTIONS],
    ["strict", { ...OPTIONS, strict: true }],
  ])("builds and runs (%s)", (name, options) => {
    const r = compile(SOURCE, { ...options, headerFileName: "generated.hpp" });
    expect(r.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: r.headerCode,
      cppCode: r.cppCode,
      testName: `program_self_${name}`,
      mainCode: `#include <iostream>
int main() {
  strucpp::Program_PRG_A p;
  p.run();
  std::cout << (int)p.Y1 << " " << (int)p.Y2 << " " << (int)p.Y3 << " "
            << (int)p.Y4 << std::endl;
  return 0;
}
`,
    });
    expect(out).toBe("7101 70 14 7");
  });
});
