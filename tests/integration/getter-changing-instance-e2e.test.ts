/**
 * E2E: a GET without locals that called a method of its own FB, wrote a
 * member or invoked a member FB failed g++ (the C++ getter is const). It is
 * run as a method, as a GET with locals is, and builds.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `FUNCTION_BLOCK Inner
VAR_OUTPUT o : INT; END_VAR
o := o + 1;
END_FUNCTION_BLOCK
FUNCTION_BLOCK Base
METHOD BM : INT
BM := 7;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB EXTENDS Base
VAR v : INT := 3; c : INT; inn : Inner; END_VAR
METHOD Twice : INT
Twice := v * 2;
END_METHOD
PROPERTY A : INT
GET
A := Twice() + THIS.Twice() + BM() + SUPER.BM();
END_GET
END_PROPERTY
PROPERTY B : INT
GET
c := c + 1; inn(); B := c * 10 + inn.o;
END_GET
END_PROPERTY
PROPERTY R : INT
GET
R := v;
END_GET
END_PROPERTY
END_FUNCTION_BLOCK
PROGRAM Main
VAR f : FB; i1, i2, i3, i4 : INT; END_VAR
i1 := f.A; i2 := f.B; i3 := f.B; i4 := f.R;
END_PROGRAM
`;

describeIfGpp("GET bodies that change the instance", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-getter-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("runs", () => {
    const result = compile(SOURCE, {
      headerFileName: "generated.hpp",
      features: ["+property"],
    });
    expect(result.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "getter_instance",
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p;\n p.run();\n std::cout << p.I1.get() << '|' << p.I2.get() << '|' << p.I3.get() << '|' << p.I4.get() << std::endl;\n return 0;\n}\n`,
    });
    expect(out).toBe("26|11|22|3");
  });
});
