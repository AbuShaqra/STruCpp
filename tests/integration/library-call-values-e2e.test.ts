// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: calls into a library archive give the values a local callee gives:
 * a library METHOD result inside arithmetic is typed, so the operands are
 * evaluated left to right (`fb.MB(v) + v * 10`); an ARRAY[*] OF STRING
 * in-out bound to an ARRAY OF STRING(80) keeps the callee's write (FUNCTION,
 * METHOD and FB call, a local FB too); a 254-character STRING output captured into a
 * STRING(80) is cut to 80. Library and consumer built with and without
 * string_default_80.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile, compileStlib } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const LONG = "x".repeat(254);

const LIBRARY = `
FUNCTION_BLOCK LFB
VAR n : INT; END_VAR
METHOD MB : INT
VAR_IN_OUT x : INT; END_VAR
x := 5;
MB := 1;
END_METHOD
METHOD MS : INT
VAR_IN_OUT a : ARRAY[*] OF STRING; END_VAR
a[1] := 'XM';
MS := 1;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION LFS : INT
VAR_IN_OUT a : ARRAY[*] OF STRING; END_VAR
a[1] := 'XY';
LFS := 1;
END_FUNCTION
FUNCTION_BLOCK LFV
VAR_IN_OUT a : ARRAY[*] OF STRING; END_VAR
a[1] := 'XF';
END_FUNCTION_BLOCK
FUNCTION LFO : INT
VAR_OUTPUT o : STRING; END_VAR
o := '${LONG}';
LFO := 1;
END_FUNCTION
`;

const PROGRAM = `
FUNCTION_BLOCK UFV
VAR_IN_OUT a : ARRAY[*] OF STRING; END_VAR
a[1] := 'XU';
END_FUNCTION_BLOCK
PROGRAM Main
VAR
  fb : LFB; fv : LFV; uv : UFV; v : INT; r : INT; r2 : INT;
  a1 : ARRAY[0..1] OF STRING(80); a2 : ARRAY[0..1] OF STRING(80);
  a3 : ARRAY[0..1] OF STRING(80); a4 : ARRAY[0..1] OF STRING(80);
  s80 : STRING(80);
END_VAR
r := fb.MB(v) + v * 10;
r2 := LFS(a1);
r2 := fb.MS(a2);
fv(a := a3);
uv(a := a4);
r2 := LFO(o => s80);
END_PROGRAM
`;

const MAIN = `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.R.get() << " " << p.A1[1].get().c_str() << " "
              << p.A2[1].get().c_str() << " " << p.A3[1].get().c_str() << " "
              << p.A4[1].get().c_str() << " "
              << p.S80.get().length() << std::endl;
    return 0;
}
`;

const feature80 = { features: ["+string_default_80"] };

function library(options: object) {
  const lib = compileStlib([{ source: LIBRARY, fileName: "lib.st" }], {
    name: "values-lib",
    version: "1.0.0",
    namespace: "strucpp",
    ...options,
  });
  expect(lib.errors ?? []).toEqual([]);
  expect(lib.success).toBe(true);
  return lib.archive!;
}

describe("library calls — codegen", () => {
  it("computes a library METHOD result in arithmetic with the wrapping helpers", () => {
    const result = compile(PROGRAM, { libraries: [library({})] });
    expect(result.errors).toEqual([]);
    expect(result.cppCode).toContain(
      "R = strucpp::iec_add<DINT_t>({FB.MB(V), strucpp::iec_mul<DINT_t>({V, 10})});",
    );
  });
});

describe.skipIf(!hasGpp)("library calls — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-libvalues-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const lib80 of [false, true]) {
    for (const use80 of [false, true]) {
      it(`gives the local callee's values (library 80: ${lib80}, consumer 80: ${use80})`, () => {
        const result = compile(PROGRAM, {
          headerFileName: "generated.hpp",
          libraries: [library(lib80 ? feature80 : {})],
          ...(use80 ? feature80 : {}),
        });
        expect(result.errors).toEqual([]);
        const out = compileAndRunStandalone({
          tempDir,
          pchPath,
          headerCode: result.headerCode,
          cppCode: result.cppCode,
          testName: `library_values_${Number(lib80)}${Number(use80)}`,
          mainCode: MAIN,
        });
        expect(out).toBe("51 XY XM XF XU 80");
      });
    }
  }
});
