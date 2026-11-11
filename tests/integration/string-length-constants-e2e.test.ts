/**
 * E2E: STRING(N) / WSTRING(N) with N an ST constant failed g++ (the C++ type
 * named a non-constexpr variable or member). It takes the constant's value.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `VAR_GLOBAL CONSTANT N : INT := 4; M : INT := N + 1; END_VAR
TYPE TS : STRUCT s : STRING(M); END_STRUCT END_TYPE
FUNCTION F : INT
VAR_INPUT x : STRING(N); END_VAR
F := LEN(x);
END_FUNCTION
FUNCTION_BLOCK FB
VAR CONSTANT N : INT := 2; END_VAR
VAR_OUTPUT o : STRING(N); END_VAR
o := 'hello';
END_FUNCTION_BLOCK
PROGRAM Main
VAR CONSTANT L : INT := 3; END_VAR
VAR
  s : STRING(L); w : WSTRING(N); t : TS; a : ARRAY[0..1] OF STRING(N); fbi : FB;
  i1, i2, i3, i4, i5, i6 : INT;
END_VAR
s := 'abcdefg'; i1 := LEN(s);
w := "abcdefg"; i2 := LEN(w);
t.s := 'abcdefgh'; i3 := LEN(t.s);
a[0] := 'xyzuvw'; i4 := LEN(a[0]);
i5 := F('qwertyu');
fbi(); i6 := LEN(fbi.o);
END_PROGRAM
`;

describeIfGpp("STRING lengths named by constants", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-strconst-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("truncates to the constant's value", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const vars = ["I1", "I2", "I3", "I4", "I5", "I6"]
      .map((v) => `std::cout << p.${v}.get() << '|';`)
      .join(" ");
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "string_length_constants",
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p;\n p.run();\n ${vars}\n std::cout << std::endl;\n return 0;\n}\n`,
    });
    expect(out).toBe("3|4|5|4|4|2|");
  });
});
