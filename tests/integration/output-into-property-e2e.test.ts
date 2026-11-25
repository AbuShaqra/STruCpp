// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: an output captured into a PROPERTY (`o(q => pp.P)`) calls its setter,
 * for a function block, FUNCTION, METHOD and library FUNCTION call; the
 * getter is not called for it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile, compileStlib } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const LIBRARY = `
FUNCTION LFQ : INT
VAR_OUTPUT q : INT; END_VAR
q := 11;
LFQ := 0;
END_FUNCTION
`;

const SOURCE = `
FUNCTION_BLOCK O
VAR_OUTPUT q : INT; END_VAR
q := 42;
END_FUNCTION_BLOCK
FUNCTION_BLOCK PP
VAR v : INT; sets : INT; gets : INT; END_VAR
PROPERTY P : INT
GET
gets := gets + 1;
P := v;
END_GET
SET
v := P;
sets := sets + 1;
END_SET
END_PROPERTY
METHOD MO : INT
VAR_OUTPUT q : INT; END_VAR
q := 7;
MO := 0;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION FQ : INT
VAR_OUTPUT q : INT; END_VAR
q := 9;
FQ := 0;
END_FUNCTION
PROGRAM Main
VAR o : O; p1 : PP; p2 : PP; p3 : PP; p4 : PP; r : INT; END_VAR
o(q => p1.P);
r := FQ(q => p2.P);
r := p1.MO(q => p3.P);
r := LFQ(q => p4.P);
END_PROGRAM
`;

const MAIN = `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.P1.V.get() << "," << p.P1.SETS.get() << "," << p.P1.GETS.get()
              << " " << p.P2.V.get() << "," << p.P2.SETS.get() << "," << p.P2.GETS.get()
              << " " << p.P3.V.get() << "," << p.P3.SETS.get() << "," << p.P3.GETS.get()
              << " " << p.P4.V.get() << "," << p.P4.SETS.get() << "," << p.P4.GETS.get()
              << std::endl;
    return 0;
}
`;

function library() {
  const lib = compileStlib([{ source: LIBRARY, fileName: "lfq.st" }], {
    name: "lfq-lib",
    version: "1.0.0",
    namespace: "strucpp",
  });
  expect(lib.success).toBe(true);
  return lib.archive!;
}

describe("output into a property — codegen", () => {
  it("writes it through the setter", () => {
    const result = compile(SOURCE, { libraries: [library()] });
    expect(result.errors).toEqual([]);
    expect(result.cppCode).toContain("P1.set_P(O_.Q);");
    expect(result.cppCode).not.toContain("get_P() =");
    expect(result.cppCode).not.toContain("(P2.get_P())");
  });
});

describe.skipIf(!hasGpp)("output into a property — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-outprop-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("calls the setter once on every call form", () => {
    const result = compile(SOURCE, {
      headerFileName: "generated.hpp",
      libraries: [library()],
    });
    expect(result.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "output_into_property",
      mainCode: MAIN,
    });
    expect(out).toBe("42,1,0 9,1,0 7,1,0 11,1,0");
  });
});
