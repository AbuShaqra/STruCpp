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

  const CONTEXTS = `TYPE MyC : CHAR; END_TYPE
TYPE MyD : CHAR := 'Q'; END_TYPE
TYPE St : STRUCT k : CHAR := 'q'; END_STRUCT END_TYPE
FUNCTION_BLOCK FBx VAR_INPUT c : CHAR; END_VAR VAR_OUTPUT o : INT; END_VAR o := CHAR_TO_INT(c); END_FUNCTION_BLOCK
FUNCTION FIn : INT VAR_INPUT c : CHAR; END_VAR FIn := CHAR_TO_INT(c); END_FUNCTION
FUNCTION FSel : CHAR VAR_INPUT g : BOOL; END_VAR FSel := SEL(g, 'a', 'b'); END_FUNCTION
FUNCTION FC : INT VAR_INPUT c : MyC; END_VAR CASE c OF 'a'..'c': FC := 1; CHAR#16#80..CHAR#16#82: FC := 2; ELSE FC := 0; END_CASE; END_FUNCTION
FUNCTION FW : INT VAR_INPUT c : WCHAR; END_VAR CASE c OF "a".."c", "x": FW := 1; ELSE FW := 0; END_CASE; END_FUNCTION
FUNCTION F4 : INT VAR_INPUT a, b : CHAR; END_VAR VAR e : BOOL; END_VAR F4 := CHAR_TO_INT(MAX(EN := TRUE, IN1 := a, IN2 := b, ENO => e)); END_FUNCTION
FUNCTION F7 : INT VAR_INPUT a, b : WCHAR; END_VAR VAR e : BOOL; END_VAR F7 := WCHAR_TO_INT(MIN(EN := TRUE, IN1 := a, IN2 := b, ENO => e)); END_FUNCTION
PROGRAM MAIN
VAR
  m : MyC := 'B'; dd : MyD; s : St; arr : ARRAY[0..2] OF CHAR := [2('k'), 'm']; ws : ARRAY[0..1] OF WCHAR := ["p", "q"];
  fb : FBx; c : CHAR := 'c'; d : CHAR := 'z'; w : WCHAR; g : BOOL := TRUE; i : INT := 1;
  x1, x2, x3, x4, x5, x6, e1, e2 : BOOL; e3 : BOOL := TRUE;
  n1, n2, n3, n4, n5, n6, n7, n8, n9, n10, n11, n12, n13, n14, n15 : DINT;
END_VAR
fb(c := 'C');
n1 := fb.o;
n2 := CHAR_TO_INT(FSel(TRUE)) * 1000 + FIn('D');
n3 := FIn(c := 'E') * 1000 + CHAR_TO_INT(m);
n4 := CHAR_TO_INT(dd) * 1000 + CHAR_TO_INT(s.k);
n5 := CHAR_TO_INT(arr[1]) * 100 + CHAR_TO_INT(arr[2]) - 10000;
n6 := WCHAR_TO_INT(ws[1]);
n7 := FC('b') * 100 + FC(CHAR#16#81) * 10 + FC('d');
n8 := FW("b") * 10 + FW("x");
n9 := F4('a', 'b') * 1000 + F7("a", "b");
x1 := c = SEL(g, c, d);
x2 := c < SEL(g, d, c);
x3 := c = MUX(i, c, d);
x4 := c = LIMIT(c, d, c);
x5 := EQ(c, SEL(g, c, d));
x6 := SEL(g, c, d) = 'z';
w := STRING_TO_WCHAR('ab');
n10 := WCHAR_TO_INT(w);
c := WSTRING_TO_CHAR("ab");
n11 := CHAR_TO_INT(c);
c := STRING_TO_CHAR('kb');
n12 := CHAR_TO_INT(c) * 1000 + CHAR_TO_INT('A');
n13 := CHAR_TO_INT(MAX(EN := FALSE, IN1 := c, IN2 := d, ENO => e1));
x6 := x6 AND GT(EN := TRUE, IN1 := d, IN2 := c, ENO => e2);
n14 := WCHAR_TO_INT(SEL(EN := TRUE, G := g, IN0 := w, IN1 := "y", ENO => e3));
c := MAX(EN := TRUE, IN1 := 'a', IN2 := d, ENO => e3);
n15 := CHAR_TO_INT(c);
END_PROGRAM
`;

  for (const [label, options] of [
    ["no dialect", {}],
    ["iec-3", { dialect: "iec-3" }],
    ["strict", { strict: true }],
  ] as const) {
    it(`takes a one-character literal wherever a CHAR is expected, CHAR ranges and nested EN/ENO (${label})`, () => {
      const result = compile(CONTEXTS, {
        ...options,
        headerFileName: "generated.hpp",
      });
      expect(result.errors).toEqual([]);
      const stdout = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: `char_contexts_${label.replace(/\W/g, "_")}`,
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.N1.get() << " " << p.N2.get() << " " << p.N3.get() << " " << p.N4.get() << " "
              << p.N5.get() << " " << p.N6.get() << " " << p.N7.get() << " " << p.N8.get() << " "
              << p.N9.get() << " " << p.X1.get() << p.X2.get() << p.X3.get() << p.X4.get()
              << p.X5.get() << p.X6.get() << " " << p.N10.get() << " " << p.N11.get() << " "
              << p.N12.get() << " " << p.N13.get() << " " << p.E1.get() << p.E2.get() << " "
              << p.N14.get() << " " << p.N15.get() << " " << p.E3.get() << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe(
        "67 98068 69066 81113 809 113 120 11 98097 000101 97 97 107065 0 01 121 122 1",
      );
    });
  }
});
