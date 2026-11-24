// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: lengths and shapes a library archive records, serialized and loaded
 * back. A POINTER TO STRING(20) output captured into an LWORD or a POINTER TO
 * STRING(20), an ARRAY[*] OF STRING(10) in/out bound to an ARRAY OF
 * STRING(10) (254 and 80-character libraries), a library alias of STRING(20),
 * and ADR into the pointer inputs of an archive written before
 * `parameterShapes` that has a REFERENCE TO input. g++ and run.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile, compileStlib } from "../../src/index.js";
import { loadStlibArchive } from "../../src/library/library-loader.js";
import type { StlibArchive } from "../../src/library/library-manifest.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const LIB = `TYPE TS : STRING(20); END_TYPE

FUNCTION F_PtrOut : BOOL
VAR_INPUT pIn : POINTER TO STRING(20); END_VAR
VAR_OUTPUT pOut : POINTER TO STRING(20); END_VAR
pOut := pIn;
F_PtrOut := TRUE;
END_FUNCTION

FUNCTION F_VLen : DINT
VAR_IN_OUT arr : ARRAY[*] OF STRING(10); END_VAR
arr[0] := CONCAT(arr[0], 'xyz');
F_VLen := LEN(arr[0]);
END_FUNCTION

FUNCTION F_Mix : DINT
VAR_INPUT
  r : REFERENCE TO INT;
  p : POINTER TO INT;
  ps : POINTER TO STRING;
END_VAR
F_Mix := r + p^ + LEN(ps^) * 100;
END_FUNCTION
`;

function library(features: string[]): StlibArchive {
  const lib = compileStlib([{ source: LIB, fileName: "lib.st" }], {
    name: "lens",
    version: "1.0.0",
    namespace: "lens",
    features,
  });
  expect(lib.errors).toEqual([]);
  return JSON.parse(JSON.stringify(lib.archive)) as StlibArchive;
}

const MAIN = (expr: string): string => `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << ${expr} << std::endl;
    return 0;
}
`;

describe.skipIf(!hasGpp)("library STRING lengths — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-liblens-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const run = (
    archive: StlibArchive,
    source: string,
    features: string[],
    print: string,
    name: string,
  ): string => {
    const result = compile(source, {
      headerFileName: "generated.hpp",
      features,
      libraries: [loadStlibArchive(archive)],
    });
    expect(result.errors).toEqual([]);
    return compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: name,
      mainCode: MAIN(print),
    });
  };

  for (const [label, features] of [
    ["254", []],
    ["80", ["+string_default_80"]],
  ] as const) {
    it(`captures a POINTER TO STRING(20) output into an LWORD and a pointer (${label})`, () => {
      const stdout = run(
        library([...features]),
        `PROGRAM Main
VAR s20 : STRING(20) := 'abc'; lw, lw2 : LWORD; ps : POINTER TO STRING(20);
  ok : BOOL; n : DINT; END_VAR
ok := F_PtrOut(pIn := ADR(s20), pOut => lw);
ok := F_PtrOut(pIn := ADR(s20), pOut => ps);
n := LEN(ps^);
lw2 := ADR(s20);
IF lw = lw2 THEN n := n + 100; END_IF
END_PROGRAM
`,
        [...features],
        "p.N",
        `liblens_ptr_${label}`,
      );
      expect(stdout).toBe("103");
    });

    it(`binds an ARRAY OF STRING(10) to an ARRAY[*] OF STRING(10) in/out (${label})`, () => {
      const stdout = run(
        library([...features]),
        `PROGRAM Main
VAR a : ARRAY[0..1] OF STRING(10); n : DINT; END_VAR
a[0] := 'abcdefgh';
n := F_VLen(a) * 100 + LEN(a[0]);
END_PROGRAM
`,
        [...features],
        "p.N",
        `liblens_vla_${label}`,
      );
      expect(stdout).toBe("1010");
    });
  }

  it("stores into a library alias of STRING(20) at its length", () => {
    const stdout = run(
      library([]),
      `PROGRAM Main
VAR t : TS; n : DINT; END_VAR
t := '0123456789012345678901234567890';
n := LEN(t);
END_PROGRAM
`,
      [],
      "p.N",
      "liblens_alias",
    );
    expect(stdout).toBe("20");
  });

  it("passes addresses to the pointer inputs of an archive written without parameterShapes", () => {
    const old = library([]);
    delete old.manifest.parameterShapes;
    for (const fn of old.manifest.functions) {
      for (const p of fn.parameters) {
        if (p.referenceKind !== "reference_to") delete p.referenceKind;
        delete p.referenceChain;
        delete p.maxLength;
      }
    }
    const stdout = run(
      old,
      `PROGRAM Main
VAR x : INT := 9; y : INT := 1; s : STRING := 'ab'; n : DINT; END_VAR
n := F_Mix(y, ADR(x), ADR(s)) + F_Mix(r := y, p := ADR(x), ps := ADR(s));
END_PROGRAM
`,
      [],
      "p.N",
      "liblens_unmarked",
    );
    expect(stdout).toBe("420");
  });
});
