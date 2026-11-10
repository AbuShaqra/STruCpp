/**
 * E2E: CONCAT, INSERT, REPLACE and FIND of STRING / WSTRING arguments of
 * different declared lengths, in any mix of variables, STRUCT fields, call
 * results and literals. The result has room for the longer argument's length,
 * so it is not cut to IN1's length before it is assigned.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `
TYPE ST1 : STRUCT f : STRING(10); g : STRING; END_STRUCT END_TYPE
PROGRAM Main
VAR
  s : STRING := 'hello world wide';
  s10 : STRING(10) := 'abcdefghij';
  k10 : STRING(10) := 'world';
  k : STRING := 'def';
  w : WSTRING := "hello world wide";
  w10 : WSTRING(10) := "abcdefghij";
  st : ST1;
  r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, r11, r12 : STRING;
  t1, t4 : STRING(10);
  u1 : STRING(30);
  x1, x2, x3, x4 : WSTRING;
  n1, n2, n3, n4, n5, m1, m2, m3, m4 : INT;
END_VAR
  st.f := 'abcdefghij'; st.g := s;
  r1 := CONCAT(s, s10);         t1 := CONCAT(s, s10);
  r2 := CONCAT(s10, s);
  r3 := INSERT(s, s10, 5);
  r4 := INSERT(s10, s, 3);      t4 := INSERT(s10, s, 3);
  r5 := REPLACE(s, s10, 5, 7);
  r6 := REPLACE(s10, s, 2, 3);
  u1 := CONCAT(s10, k10, s);
  r7 := INSERT(CONCAT(s, s10), s10, 3);
  r8 := REPLACE(s10, CONCAT(s10, s), 2, 3);
  r9 := INSERT(st.f, st.g, 3);
  r10 := REPLACE(st.f, s, 2, 3);
  r11 := INSERT(st.f, 'literal-longer-than-ten', 3);
  r12 := INSERT(s10, LEFT(s, 12), 3);
  n1 := FIND(s, k10);  n2 := FIND(s10, k);  n3 := FIND(k10, s);
  n4 := FIND(CONCAT(s10, s), st.f);  n5 := FIND(st.g, k10);
  x1 := INSERT(w10, w, 3);
  x2 := REPLACE(w10, w, 2, 3);
  x3 := CONCAT(w10, w);
  x4 := CONCAT(w10, w10, w);
  m1 := LEN(x1); m2 := LEN(x2); m3 := LEN(x3); m4 := LEN(x4);
END_PROGRAM
`;

describe.skipIf(!hasGpp)("string functions over mixed lengths", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-strmix-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("builds every mix and keeps the whole result", () => {
    const r = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(r.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: r.headerCode,
      cppCode: r.cppCode,
      testName: "string_cross_length",
      mainCode: `#include <iostream>
int main() {
  strucpp::Program_MAIN p;
  p.run();
#define S(x) std::cout << p.x.get().c_str() << "\\n";
  S(R1) S(T1) S(R2) S(R3) S(R4) S(T4) S(R5) S(R6) S(U1) S(R7) S(R8) S(R9)
  S(R10) S(R11) S(R12)
  std::cout << (int)p.N1 << " " << (int)p.N2 << " " << (int)p.N3 << " "
            << (int)p.N4 << " " << (int)p.N5 << " " << (int)p.M1 << " "
            << (int)p.M2 << " " << (int)p.M3 << " " << (int)p.M4 << std::endl;
  return 0;
}
`,
    });
    expect(out.split("\n")).toEqual([
      "hello world wideabcdefghij",
      "hello worl",
      "abcdefghijhello world wide",
      "helloabcdefghij world wide",
      "abchello world widedefghij",
      "abchello w",
      "hello abcdefghij wide",
      "abhello world wideefghij",
      "abcdefghijworldhello world wid",
      "helabcdefghijlo world wideabcdefghij",
      "ababcdefghijhello world wideefghij",
      "abchello world widedefghij",
      "abhello world wideefghij",
      "abcliteral-longer-than-tendefghij",
      "abchello world defghij",
      "7 4 0 1 7 26 24 26 36",
    ]);
  });
});
