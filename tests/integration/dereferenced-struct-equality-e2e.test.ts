/**
 * E2E: comparing STRUCTs reached through `^` or a REFERENCE TO failed g++
 * (no operator== on the STRUCT, or members asked of the reference wrapper).
 * They compare member-wise and run.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `TYPE P : STRUCT x : INT; y : INT; END_STRUCT END_TYPE
PROGRAM Main
VAR s1, s2, s3 : P; r1, r2 : REF_TO P; p1 : POINTER TO P; rr : REFERENCE TO P; i : INT; END_VAR
s1.x := 1; s2.x := 1; s3.y := 5;
r1 := REF(s1); r2 := REF(s2); p1 := ADR(s1); rr REF= s1;
IF r1^ = r2^ THEN i := i + 1; END_IF;
IF p1^ = s2 THEN i := i + 10; END_IF;
IF rr = s2 THEN i := i + 100; END_IF;
IF rr <> s3 THEN i := i + 1000; END_IF;
IF r1 = r2 THEN i := i + 10000; END_IF;
END_PROGRAM
`;

describeIfGpp("dereferenced STRUCT equality", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-derefeq-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("compares member-wise", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "deref_struct_eq",
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p;\n p.run();\n std::cout << p.I.get() << std::endl;\n return 0;\n}\n`,
    });
    // r1 and r2 refer to different variables: not equal as references.
    expect(out).toBe("1111");
  });
});
