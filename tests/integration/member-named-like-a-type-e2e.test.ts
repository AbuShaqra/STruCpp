/**
 * E2E: a member, STRUCT field or local named like a user type used next to
 * it (`s3 : STRING(3)` with `a : S3`) failed g++, the name hiding the type.
 * It is renamed NAME_ and builds and runs.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `TYPE S3 : STRING(3); END_TYPE
TYPE MyInt : INT; END_TYPE
TYPE Pt : STRUCT x : INT; END_STRUCT END_TYPE
TYPE ST : STRUCT s3 : INT; a : S3; END_STRUCT END_TYPE
FUNCTION_BLOCK FB
VAR_INPUT s3 : INT; END_VAR
VAR myint : MyInt; END_VAR
VAR_OUTPUT o : INT; a : S3; END_VAR
METHOD M : INT
VAR pt : INT := 6; q : Pt; END_VAR
q.x := 1; M := pt + q.x;
END_METHOD
myint := 3; o := s3 * 2 + myint + M();
END_FUNCTION_BLOCK
FUNCTION F : INT
VAR s3 : STRING(3) := 'ab'; a : S3 := 'c'; END_VAR
F := LEN(s3) + 1;
END_FUNCTION
PROGRAM Main
VAR pt : INT := 3; q : Pt; v : ST; fbi : FB; i1, i2, i3 : INT; END_VAR
q.x := 4; i1 := pt + q.x;
v.s3 := 5; v.a := 'xyzw'; i2 := v.s3 * 10 + 3;
fbi(s3 := 5); i3 := fbi.o * 10 + F();
END_PROGRAM
`;

describeIfGpp("members named like a user type", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-membertype-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("builds and runs", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const vars = ["I1", "I2", "I3"]
      .map((v) => `std::cout << p.${v}.get() << '|';`)
      .join(" ");
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "member_named_like_type",
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p;\n p.run();\n ${vars}\n std::cout << std::endl;\n return 0;\n}\n`,
    });
    // 3 + 4; 5 * 10 + 3; (10 + 3 + 7) * 10 + 3
    expect(out).toBe("7|53|203|");
  });
});
