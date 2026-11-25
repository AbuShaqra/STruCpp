// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: a variable of an enumeration without an initial value starts at the
 * enumeration's first member (IEC 61131-3 Table 11), also when the members
 * have explicit values and the first is not 0: locals, STRUCT fields, array
 * elements, FB members and FUNCTION results; a library's enumeration
 * declares its first member in the library's header.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile, compileStlib } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `
TYPE E : (E1 := 5, E2 := 7); END_TYPE
TYPE EN : INT (NEG := -2, ZERO := 0); END_TYPE
TYPE EP : (P0, P1); END_TYPE
TYPE S : STRUCT f : E; END_STRUCT END_TYPE
FUNCTION_BLOCK FB
VAR_OUTPUT m : E; END_VAR
END_FUNCTION_BLOCK
FUNCTION F : E
END_FUNCTION
PROGRAM Main
VAR
  e : E; n : EN; p : EP; s : S; a : ARRAY[1..2] OF E; fb : FB;
  r : ARRAY[1..7] OF INT;
END_VAR
r[1] := TO_INT(e);
r[2] := TO_INT(n);
r[3] := TO_INT(p);
r[4] := TO_INT(s.f);
r[5] := TO_INT(a[2]);
r[6] := TO_INT(fb.m);
r[7] := TO_INT(F());
END_PROGRAM
`;

const LIBRARY = `TYPE LE : (L1 := 3, L2 := 4); END_TYPE`;

const MAIN = `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    for (int i = 1; i <= 7; ++i) std::cout << p.R[i].get() << " ";
    std::cout << std::endl;
    return 0;
}
`;

function library() {
  const lib = compileStlib([{ source: LIBRARY, fileName: "le.st" }], {
    name: "le-lib",
    version: "1.0.0",
    namespace: "strucpp",
  });
  expect(lib.success).toBe(true);
  return lib.archive!;
}

describe("enumeration first-member default — codegen", () => {
  it("declares the first member for an enumeration whose first value is not 0", () => {
    const result = compile(SOURCE);
    expect(result.errors).toEqual([]);
    expect(result.headerCode).toContain(
      "constexpr E iec_enum_first(const E*) noexcept { return E::E1; }",
    );
    expect(result.headerCode).toContain(
      "constexpr EN iec_enum_first(const EN*) noexcept { return EN::NEG; }",
    );
    // First member 0: nothing to declare
    expect(result.headerCode).not.toContain("iec_enum_first(const EP*)");
  });

  it("declares it in a library's header", () => {
    const headers = library()
      .chunks.map((c) => c.header ?? "")
      .join("\n");
    expect(headers).toContain(
      "constexpr LE iec_enum_first(const LE*) noexcept { return LE::L1; }",
    );
  });
});

describe.skipIf(!hasGpp)("enumeration first-member default — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-enumfirst-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("starts every storage of the type at its first member", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "enum_first_default",
      mainCode: MAIN,
    });
    expect(out).toBe("5 -2 0 5 5 5 5");
  });
});
