// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: CHAR and WCHAR values, literals, STRING indexing, ordering by
 * Windows-1252 code and the character conversions build and run under g++;
 * an index past the string's length raises the out-of-bounds error.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `PROGRAM Main
VAR
  c : CHAR := CHAR#'A';
  e : CHAR := CHAR#'€';
  w : WCHAR := WCHAR#"$20AC";
  s : STRING := 'häl';
  ws : WSTRING := "a☃";
  x : CHAR; y : WCHAR; b : BYTE; n : INT; lt : BOOL; eq : BOOL;
  s2 : STRING; ws2 : WSTRING; ce : CHAR; wc : WCHAR; i : INT := 4; bad : CHAR;
END_VAR
x := s[2];
s[3] := CHAR#'L';
y := ws[2];
b := CHAR_TO_BYTE(e);
n := CHAR_TO_INT(x);
lt := c < e;
eq := x = CHAR#'ä';
s2 := CHAR_TO_STRING(c);
ws2 := WCHAR_TO_WSTRING(y);
wc := CHAR_TO_WCHAR(e);
ce := WCHAR_TO_CHAR(w);
END_PROGRAM
`;

describe.skipIf(!hasGpp)("CHAR and WCHAR — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-char-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const [label, options] of [
    ["no dialect", {}],
    ["iec-3", { dialect: "iec-3" }],
    ["strict", { strict: true }],
  ] as const) {
    it(`builds and runs (${label})`, () => {
      const result = compile(SOURCE, {
        ...options,
        headerFileName: "generated.hpp",
      });
      expect(result.errors).toEqual([]);
      const stdout = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: `char_${label.replace(/\W/g, "_")}`,
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    const auto code = [](char ch) { return int(static_cast<unsigned char>(ch)); };
    std::cout << code(p.X.get()) << " " << int(p.Y.get()) << " " << int(p.B.get())
              << " " << p.N.get() << " " << p.LT.get() << " " << p.EQ.get() << " "
              << code(p.S.get().c_str()[2]) << " " << p.S2.get().c_str() << " "
              << int(p.WS2.get().c_str()[0]) << " " << int(p.WC.get()) << " "
              << code(p.CE.get());
    try {
        p.BAD = p.S.at(p.I.get());
        std::cout << " no-error";
    } catch (const std::out_of_range&) {
        std::cout << " out-of-range";
    }
    std::cout << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe(
        "228 9731 128 228 1 1 76 A 9731 8364 128 out-of-range",
      );
    });
  }

  const ORDERING = `TYPE MyC : CHAR; END_TYPE
FUNCTION FAl : BOOL VAR_INPUT a : MyC; b : MyC; END_VAR FAl := a < b; END_FUNCTION
FUNCTION FChr : CHAR VAR_INPUT x : INT; END_VAR IF x > 0 THEN FChr := 'Y'; ELSE FChr := CHAR#'N'; END_IF; END_FUNCTION
PROGRAM MAIN
VAR
  a : CHAR := CHAR#'a'; ae : CHAR := 'ä'; z : CHAR := CHAR#'z';
  mx : CHAR; mn : CHAR; li : CHAR; gt : BOOL; al : BOOL; eq : BOOL; sq : BOOL;
  s : STRING := 'abc'; ws : WSTRING := "x☃"; w : WCHAR; w2 : WCHAR; c2 : CHAR; s2 : STRING; ws2 : WSTRING;
  k : INT; hx : CHAR; wx : WCHAR; fc : CHAR;
END_VAR
mx := MAX(a, ae);
mn := MIN(ae, a);
li := LIMIT(a, ae, z);
gt := GT(ae, a);
al := FAl(ae, a);
eq := a = 'a';
sq := s[1] = 'a';
w := STRING_TO_WCHAR(s);
c2 := WSTRING_TO_CHAR(ws);
ws2 := CHAR_TO_WSTRING(ae);
w2 := WCHAR#"☃";
s2 := WCHAR_TO_STRING(w2);
CASE ae OF 'a': k := 1; CHAR#'ä': k := 2; ELSE k := 3; END_CASE;
hx := CHAR#16#41;
wx := WCHAR#'X';
fc := FChr(1);
END_PROGRAM
`;

  for (const [label, options] of [
    ["no dialect", {}],
    ["iec-3", { dialect: "iec-3" }],
    ["strict", { strict: true }],
  ] as const) {
    it(`orders by code, adapts one-character literals and converts across widths (${label})`, () => {
      const result = compile(ORDERING, {
        ...options,
        headerFileName: "generated.hpp",
      });
      expect(result.errors).toEqual([]);
      const stdout = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: `char_order_${label.replace(/\W/g, "_")}`,
        mainCode: `
#include <iostream>
static int u(char c) { return static_cast<unsigned char>(c); }
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << u(p.MX.get()) << " " << u(p.MN.get()) << " " << u(p.LI.get()) << " "
              << p.GT.get() << " " << p.AL.get() << " " << p.EQ.get() << " " << p.SQ.get() << " "
              << int(p.W.get()) << " " << u(p.C2.get()) << " " << int(p.WS2.get().c_str()[0]) << " "
              << u(p.S2.get().c_str()[0]) << " " << p.K.get() << " " << u(p.HX.get()) << " "
              << int(p.WX.get()) << " " << u(p.FC.get()) << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe("228 97 122 1 0 1 1 97 120 228 63 2 65 88 89");
    });
  }
});
