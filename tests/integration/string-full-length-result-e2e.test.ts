/**
 * E2E: a string function's result is a full-length string (the default 254,
 * or the longest argument's declared length when that is more), so it is cut
 * only when it is assigned to a shorter variable.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `
TYPE ST1 : STRUCT f : STRING(5); END_STRUCT END_TYPE
FUNCTION Len20 : INT
VAR_INPUT v : STRING(20); END_VAR
  Len20 := LEN(v);
END_FUNCTION
PROGRAM Main
VAR
  a5 : STRING(5) := 'abcde';
  b5 : STRING(5) := 'fghij';
  k10 : STRING(10) := 'world';
  s10 : STRING(10) := 'abcdefghij';
  wa : WSTRING(5) := "abcde";
  wb : WSTRING(5) := "fghij";
  st : ST1;
  big, big2 : STRING(300);
  t5 : STRING(5);
  t10 : STRING(10);
  u1, u2, u3, u4, u5, u6, u7 : STRING(30);
  x1 : WSTRING(30);
  n1, n2, n3, n4, n5, n6, n7, n8, i : INT;
  ok : BOOL;
END_VAR
  st.f := 'abcde';
  t10 := CONCAT(a5, b5);
  t5 := CONCAT(a5, b5);
  u1 := INSERT(k10, s10, 2);
  u2 := REPLACE(s10, s10, 2, 3);
  u3 := CONCAT(a5, b5, a5);
  u4 := CONCAT(INSERT(a5, b5, 2), b5);
  u5 := CONCAT(st.f, st.f);
  u6 := INSERT(st.f, b5, 5);
  u7 := REPLACE(a5, 'XYZ', 1, 3);
  ok := CONCAT(a5, b5) = 'abcdefghij';
  n1 := LEN(CONCAT(a5, b5));
  n2 := FIND(CONCAT(a5, b5), 'hij');
  n3 := Len20(CONCAT(a5, b5, a5));
  n4 := LEN(CONCAT(wa, wb));
  x1 := INSERT(wa, wb, 2);
  n5 := LEN(x1);
  n6 := LEN(REPLACE(wa, wb, 1, 1));
  n7 := LEN(CONCAT(wa, wb, wa));
  FOR i := 1 TO 52 DO big := CONCAT(big, a5); END_FOR;
  big2 := CONCAT(big, a5);
  n8 := LEN(big2);
END_PROGRAM
`;

describe.skipIf(!hasGpp)("string function results are full length", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-strfull-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("cuts a result only on assignment", () => {
    const r = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(r.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: r.headerCode,
      cppCode: r.cppCode,
      testName: "string_full_length",
      mainCode: `#include <iostream>
int main() {
  strucpp::Program_MAIN p;
  p.run();
#define S(x) std::cout << p.x.get().c_str() << "\\n";
  S(T10) S(T5) S(U1) S(U2) S(U3) S(U4) S(U5) S(U6) S(U7)
  std::cout << (bool)p.OK << " " << (int)p.N1 << " " << (int)p.N2 << " "
            << (int)p.N3 << " " << (int)p.N4 << " " << (int)p.N5 << " "
            << (int)p.N6 << " " << (int)p.N7 << " " << (int)p.N8 << std::endl;
  return 0;
}
`,
    });
    expect(out.split("\n")).toEqual([
      "abcdefghij",
      "abcde",
      "woabcdefghijrld",
      "ababcdefghijefghij",
      "abcdefghijabcde",
      "abfghijcdefghij",
      "abcdeabcde",
      "abcdefghij",
      "abXYZde",
      "1 10 8 15 10 10 9 15 265",
    ]);
  });
});
