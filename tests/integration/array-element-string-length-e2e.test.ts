/**
 * E2E: elements of ARRAY OF STRING(n) hold n characters (they held 254), an
 * ARRAY OF REF_TO STRING(n) builds, and arrays whose elements differ only in
 * length still assign and pass, element by element.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `TYPE TA : ARRAY[0..1] OF STRING(3); END_TYPE
TYPE TR : ARRAY[0..1] OF REF_TO STRING(3); END_TYPE
FUNCTION F3 : INT
VAR_IN_OUT x : ARRAY[*] OF STRING(3); END_VAR
x[0] := 'abcdefg'; F3 := LEN(x[0]);
END_FUNCTION
FUNCTION FS : INT
VAR_IN_OUT s : STRING(3); END_VAR
s := CONCAT(s, 'zz'); FS := LEN(s);
END_FUNCTION
PROGRAM Main
VAR
  a : ARRAY[0..1] OF STRING(3); b : TA; c : ARRAY[0..1] OF STRING;
  x : STRING(3) := 'abc'; ra : ARRAY[0..1] OF REF_TO STRING(3); rb : TR;
  i1, i2, i3, i4, i5, i6 : INT;
END_VAR
a[0] := 'abcdef'; b[1] := 'xyzuvw';
i1 := LEN(a[0]) * 10 + LEN(b[1]);
ra[0] := REF(x); rb[1] := REF(a[0]);
i2 := LEN(ra[0]^) * 10 + LEN(rb[1]^);
c[0] := 'longer'; a := c; i3 := LEN(a[0]);
c := b; i4 := LEN(c[1]);
c[1] := 'qwerty'; i5 := F3(c) * 10; i5 := i5 + LEN(c[0]);
a[1] := 'p'; i6 := FS(a[1]) * 10; i6 := i6 + LEN(a[1]);
END_PROGRAM
`;

describeIfGpp("array element STRING length", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-arrstr-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("truncates elements to their length", () => {
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
      testName: "array_string_length",
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p;\n p.run();\n ${vars}\n std::cout << std::endl;\n return 0;\n}\n`,
    });
    expect(out).toBe("33|33|3|3|33|33|");
  });
});
