// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: MAX, MIN, LIMIT, SEL, MUX and the comparison functions on STRING and
 * WSTRING variables, literals and values of different declared lengths; a
 * one-character literal stored into and compared with a CHAR or WCHAR reached
 * through `^` (a CASE label on one included); a POINTER TO passed to an
 * LWORD input; and typed STRING#'...' / WSTRING#"..." literals, built and run
 * under g++.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const MODES = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
] as const;

const SELECTION = `PROGRAM Main
VAR
  s : STRING := 'b'; s2 : STRING := 'd'; s10 : STRING(10) := 'z';
  ws : WSTRING := "b"; ws5 : WSTRING(5) := "d";
  r1, r2, r3, r4, r5, r6, r7, r8, r9 : STRING;
  w1, w2, w3, w4 : WSTRING;
  g1, g2, g3, g4, g5, g6, g7, g8 : BOOL;
  n : INT;
  v1, v2, v3, v4 : STRING; w5, w6 : WSTRING;
END_VAR
r1 := MAX(s, 'c');
r2 := MIN(s, s10);
r3 := MAX(s, s2);
r4 := LIMIT('c', s, 'y');
r5 := SEL(TRUE, s, s10);
r6 := MUX(2, s, 'm', s10);
r7 := MIN(LEFT(s10, 1), CONCAT(s, 'x'));
r8 := MAX('a', 'c');
r9 := CONCAT(MAX(s10, 'q'), '!');
n := LEN(MAX(s, s10));
w1 := MAX(ws, "c");
w2 := MIN(ws, ws5);
w3 := LIMIT("c", ws, "y");
w4 := MUX(1, ws, ws5);
g1 := GT(s, 'a');
g2 := EQ(s, 'b');
g3 := LT('a', s, s2, s10);
g4 := NE(s, s10);
g5 := GE(ws, "b");
g6 := LE(ws5, ws);
g7 := GT(s10, s2, s);
g8 := EQ(s, s2);
v1 := MAX(s, s2, s);
v2 := MIN(s2, s10, 'c');
v3 := MAX('a', 'e', 'c');
v4 := MIN(s10, 'q', s2, 'x');
w5 := MAX(ws, ws5, ws);
w6 := MIN(ws5, "c", ws);
END_PROGRAM
`;

const DEREF = `TYPE R : STRUCT c : CHAR; END_STRUCT; END_TYPE
FUNCTION H : LWORD VAR_INPUT a : LWORD; END_VAR H := a; END_FUNCTION
PROGRAM Main
VAR
  c : CHAR := 'a'; wc : WCHAR := "a"; arr : ARRAY[1..3] OF CHAR; rec : R;
  p : POINTER TO CHAR; pw : POINTER TO WCHAR; pa : POINTER TO ARRAY[1..3] OF CHAR;
  pr : POINTER TO R; rc : REF_TO CHAR;
  b1, b2, b3, b4, b5, b6 : BOOL; m : CHAR; k : INT; lw : LWORD;
END_VAR
p := ADR(c); pw := ADR(wc); pa := ADR(arr); pr := ADR(rec); rc := REF(c);
p^ := 'b';
pw^ := "c";
pa^[2] := 'd';
pr^.c := 'e';
b1 := p^ = 'b';
b2 := 'a' < p^;
b3 := pw^ <> "c";
b4 := pa^[2] = 'd';
b5 := EQ(p^, 'b');
rc^ := 'f';
b6 := rc^ = 'f';
m := MAX(p^, 'c');
CASE p^ OF 'a': k := 1; 'f': k := 2; ELSE k := 3; END_CASE;
lw := H(p);
END_PROGRAM
`;

const TYPED = `TYPE T : STRUCT a : STRING(5) := STRING#'st'; b : WSTRING := WSTRING#"wb"; END_STRUCT; END_TYPE
FUNCTION F : STRING
VAR_INPUT i : STRING; END_VAR
F := CONCAT(i, STRING#'!');
END_FUNCTION
PROGRAM Main
VAR
  s : STRING := STRING#'in'; w : WSTRING := WSTRING#"$20AC"; t : T;
  r : STRING; q : STRING; e : BOOL; n : INT; l : INT;
END_VAR
r := CONCAT(CONCAT(s, t.a), F(i := string#'f'));
q := STRING#'a$'b';
e := s = STRING#'in';
n := LEN(WSTRING#"abc");
l := LEN(t.b);
END_PROGRAM
`;

describe.skipIf(!hasGpp)(
  "STRING selection, dereferenced CHAR literals, typed string literals — g++ e2e",
  () => {
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-strsel-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    const run = (
      source: string,
      options: object,
      name: string,
      main: string,
    ): string => {
      const result = compile(source, {
        ...options,
        headerFileName: "generated.hpp",
      });
      expect(result.errors).toEqual([]);
      return compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: name,
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    ${main}
    std::cout << std::endl;
    return 0;
}
`,
      });
    };

    for (const [label, options] of MODES) {
      const tag = label.replace(/\W/g, "_");

      it(`selects and compares strings by text, across declared lengths (${label})`, () => {
        const stdout = run(
          SELECTION,
          options,
          `strsel_${tag}`,
          `std::cout << p.R1.get().c_str() << p.R2.get().c_str() << p.R3.get().c_str()
              << p.R4.get().c_str() << p.R5.get().c_str() << p.R6.get().c_str()
              << p.R7.get().c_str() << p.R8.get().c_str() << p.R9.get().c_str() << " " << p.N.get() << " "
              << int(p.W1.get().c_str()[0]) << " " << int(p.W2.get().c_str()[0]) << " "
              << int(p.W3.get().c_str()[0]) << " " << int(p.W4.get().c_str()[0]) << " "
              << p.G1.get() << p.G2.get() << p.G3.get() << p.G4.get()
              << p.G5.get() << p.G6.get() << p.G7.get() << p.G8.get() << " "
              << p.V1.get().c_str() << p.V2.get().c_str() << p.V3.get().c_str()
              << p.V4.get().c_str() << " " << int(p.W5.get().c_str()[0])
              << " " << int(p.W6.get().c_str()[0]);`,
        );
        expect(stdout).toBe("cbdczzbxcz! 1 99 98 99 100 11111010 dced 100 98");
      });

      it(`takes a one-character literal as the CHAR or WCHAR reached through ^ (${label})`, () => {
        const stdout = run(
          DEREF,
          { ...options, features: ["+pointer_to"] },
          `strderef_${tag}`,
          `std::cout << char(p.C.get()) << int(p.WC.get()) << char(p.ARR[2].get())
              << char(p.REC.C.get()) << " " << p.B1.get() << p.B2.get() << p.B3.get()
              << p.B4.get() << p.B5.get() << p.B6.get() << " " << char(p.M.get())
              << " " << p.K.get() << " "
              << (p.LW.get() == strucpp::address_bits(p.P));`,
        );
        // c is 'f' after rc^ := 'f': m is MAX('f', 'c'), the CASE takes 'f'
        expect(stdout).toBe("f99de 110111 f 2 1");
      });

      it(`parses and runs typed STRING# and WSTRING# literals (${label})`, () => {
        const stdout = run(
          TYPED,
          options,
          `strtyped_${tag}`,
          `std::cout << p.R.get().c_str() << " " << p.Q.get().c_str() << " " << p.E.get()
              << " " << p.N.get() << " " << p.L.get() << " " << int(p.W.get().c_str()[0]);`,
        );
        expect(stdout).toBe("instf! a'b 1 3 2 8364");
      });
    }
  },
);
