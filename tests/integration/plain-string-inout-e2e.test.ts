// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: a STRING / WSTRING of the compilation's default length (254, or 80
 * with string_default_80) bound twice to plain VAR_IN_OUTs of a user
 * FUNCTION is one variable (a write through the first is seen through the
 * second); one of another length is copied in and out. A STRING(12) bound to
 * a plain STRING in/out and output of a FUNCTION, FUNCTION_BLOCK and METHOD
 * gets the callee's value back, cut at its length. g++ and run.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile, compileStlib } from "../../src/index.js";
import { loadStlibArchive } from "../../src/library/library-loader.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const ALIAS = `FUNCTION F2 : INT
VAR_IN_OUT s1 : STRING; s2 : STRING; END_VAR
s1 := 'X';
F2 := LEN(s2);
END_FUNCTION
FUNCTION W2 : INT
VAR_IN_OUT s1 : WSTRING; s2 : WSTRING; END_VAR
s1 := "X";
W2 := LEN(s2);
END_FUNCTION
PROGRAM Main
VAR a80 : STRING(80) := 'abcd'; a254 : STRING(254) := 'abcd';
  w80 : WSTRING(80) := "abcd"; w254 : WSTRING(254) := "abcd"; n1, n2, n3, n4 : DINT; END_VAR
n1 := F2(s1 := a80, s2 := a80);
n2 := F2(s1 := a254, s2 := a254);
n3 := W2(s1 := w80, s2 := w80);
n4 := W2(s1 := w254, s2 := w254);
END_PROGRAM
`;

const COPY = `FUNCTION F_IO : INT
VAR_IN_OUT s : STRING; END_VAR
VAR_OUTPUT o : STRING; END_VAR
s := CONCAT(s, '0123456789');
o := CONCAT(s, 'XYZ');
F_IO := LEN(s);
END_FUNCTION
FUNCTION_BLOCK FB_IO
VAR_IN_OUT s : STRING; END_VAR
VAR_OUTPUT o : STRING; END_VAR
s := CONCAT(s, '0123456789');
o := s;
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_M
METHOD M : INT
VAR_IN_OUT s : STRING; END_VAR
VAR_OUTPUT o : STRING; END_VAR
s := CONCAT(s, '0123456789');
o := s;
M := LEN(s);
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main
VAR a : STRING(12) := 'ab'; b : STRING(5); c : STRING(12) := 'cd'; d : STRING(5);
  e : STRING(12) := 'ef'; f : STRING(5); fb : FB_IO; fm : FB_M; n1, n2, n3, n4 : DINT; END_VAR
n1 := F_IO(s := a, o => b);
fb(s := c, o => d);
n2 := fm.M(s := e, o => f);
n3 := LEN(a) * 100 + LEN(b);
n4 := LEN(c) * 10000 + LEN(d) * 100 + LEN(e) + LEN(f) * 1000;
END_PROGRAM
`;

const MAIN = `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.N1 << " " << p.N2 << " " << p.N3 << " " << p.N4 << std::endl;
    return 0;
}
`;

describe.skipIf(!hasGpp)("plain STRING VAR_IN_OUT — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-plainstr-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const run = (source: string, features: string[], name: string): string => {
    const result = compile(source, {
      headerFileName: "generated.hpp",
      features,
    });
    expect(result.errors).toEqual([]);
    return compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: name,
      mainCode: MAIN,
    });
  };

  it("binds a STRING(254) and a WSTRING(254) by reference, and copies the 80 ones (254)", () => {
    expect(run(ALIAS, [], "plainstr_alias_254")).toBe("4 1 4 1");
  });

  it("binds a STRING(80) and a WSTRING(80) by reference, and copies the 254 ones (string_default_80)", () => {
    expect(run(ALIAS, ["+string_default_80"], "plainstr_alias_80")).toBe(
      "1 4 1 4",
    );
  });

  it("copies a STRING(12) in and out of a FUNCTION, FUNCTION_BLOCK and METHOD, cut at its length", () => {
    expect(run(COPY, [], "plainstr_copy")).toBe("12 12 1205 125512");
  });

  const LIB = `FUNCTION FS : INT
VAR_IN_OUT s : STRING(20); END_VAR
s := CONCAT(s, 'z');
FS := LEN(s);
END_FUNCTION
FUNCTION FW : INT
VAR_IN_OUT s : WSTRING(20); END_VAR
FW := LEN(s);
END_FUNCTION
FUNCTION_BLOCK LFB
VAR_IN_OUT s1 : STRING(LEN_C); s2 : STRING(LEN_C); END_VAR
s1 := 'X';
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_M
METHOD M : INT
VAR_IN_OUT s : STRING(20); END_VAR
M := LEN(s);
END_METHOD
END_FUNCTION_BLOCK
`;
  const runLibrary = (lenC: number, name: string): string => {
    const lib = compileStlib([{ source: LIB, fileName: "l.st" }], {
      name: "l",
      version: "1.0.0",
      namespace: "l",
      globalConstants: { LEN_C: lenC },
    });
    expect(lib.errors).toEqual([]);
    const result = compile(
      `PROGRAM Main
VAR a : STRING(30) := 'abc'; w : WSTRING(30) := "abc"; b : STRING(254) := 'abcd';
  fb : LFB; m : FB_M; n1, n2, n3, n4 : DINT; END_VAR
n1 := FS(a);
n2 := FW(w);
n3 := m.M(a);
fb(s1 := b, s2 := b);
n4 := LEN(b);
END_PROGRAM
`,
      {
        headerFileName: "generated.hpp",
        libraries: [loadStlibArchive(JSON.parse(JSON.stringify(lib.archive)))],
      },
    );
    expect(result.errors).toEqual([]);
    return compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: name,
      mainCode: MAIN,
    });
  };

  it("copies a library FUNCTION's, METHOD's and FB's in/outs of another length, and binds a STRING(NAME) of the same by reference", () => {
    // LEN_C = 20: b is copied into both in-outs, the second copy back wins.
    expect(runLibrary(20, "plainstr_lib_20")).toBe("4 3 4 4");
    // LEN_C = 254: one variable, so the write through s1 is the value.
    expect(runLibrary(254, "plainstr_lib_254")).toBe("4 3 4 1");
  });
});
