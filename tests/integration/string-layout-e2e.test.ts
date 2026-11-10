// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: STRING(n) is laid out as on a PLC, a NUL-terminated char[n+1], and its
 * length is where the terminator is. A POINTER TO ARRAY OF BYTE over a string
 * reads its characters, and writing characters plus a 0 through it changes
 * what LEN reports. WSTRING(n) is the same over char16_t. Runs at -O0 and -O2.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `
TYPE Rec : STRUCT tag : BYTE; name : STRING(10); END_STRUCT END_TYPE

FUNCTION MakeChr : STRING(1)
  VAR_INPUT c : BYTE; END_VAR
  VAR pt : POINTER TO BYTE; END_VAR
  pt := ADR(MakeChr);
  pt^ := c;
  pt := pt + 1;
  pt^ := 0;
END_FUNCTION

PROGRAM Main
  VAR
    str : STRING := 'abcdef';
    pt : POINTER TO ARRAY[1..255] OF BYTE;
    r1, r2, r3 : BYTE;
    shortened : STRING := 'abcdef';
    len_short : INT;
    grown : STRING(20) := 'ab';
    len_grown : INT;
    chr : STRING(1);
    len_chr : INT;
    zero : STRING := 'a$00b';
    len_zero : INT;
    joined : STRING;
    len_joined : INT;
    s80 : STRING(80);
    sz80, sz_default, sz_w10, sz_rec : UDINT;
    item : Rec;
    pr : POINTER TO ARRAY[0..11] OF BYTE;
    len_rec : INT;
    ws : WSTRING(10) := "abc";
    pw : POINTER TO ARRAY[1..11] OF WORD;
    w2 : WORD;
    len_ws : INT;
    eq : BOOL;
  END_VAR
  pt := ADR(str);
  r1 := pt^[1]; r2 := pt^[2]; r3 := pt^[3];

  pt := ADR(shortened);
  pt^[1] := 16#58;           (* 'X' *)
  pt^[4] := 0;               (* terminate after three characters *)
  len_short := LEN(shortened);

  pt := ADR(grown);
  pt^[3] := 16#63;           (* 'c' over the old terminator *)
  pt^[4] := 16#64;           (* 'd' *)
  pt^[5] := 0;
  len_grown := LEN(grown);

  chr := MakeChr(16#41);
  len_chr := LEN(chr);

  len_zero := LEN(zero);
  joined := CONCAT(grown, 'e');
  len_joined := LEN(joined);
  eq := joined = 'abcde';

  sz80 := SIZEOF(s80);
  sz_default := SIZEOF(str);
  sz_w10 := SIZEOF(ws);
  sz_rec := SIZEOF(item);

  item.name := 'hello';
  pr := ADR(item);
  pr^[3] := 0;               (* after 'he': tag at 0, name from 1 *)
  len_rec := LEN(item.name);

  pw := ADR(ws);
  w2 := pw^[2];
  pw^[3] := 0;
  len_ws := LEN(ws);
END_PROGRAM
`;

const MAIN = `
#include <cstdio>
int main() {
    strucpp::Program_MAIN m;
    m.run();
    std::printf("read %u %u %u\\n", (unsigned)m.R1, (unsigned)m.R2, (unsigned)m.R3);
    std::printf("short %d %s | grown %d %s | chr %d %s\\n", (int)m.LEN_SHORT,
        m.SHORTENED.c_str(), (int)m.LEN_GROWN, m.GROWN.c_str(), (int)m.LEN_CHR, m.CHR.c_str());
    std::printf("zero %d | joined %d %d\\n", (int)m.LEN_ZERO, (int)m.LEN_JOINED, (int)m.EQ);
    std::printf("sizeof %u %u %u %u\\n", (unsigned)m.SZ80, (unsigned)m.SZ_DEFAULT,
        (unsigned)m.SZ_W10, (unsigned)m.SZ_REC);
    std::printf("rec %d %s | ws %u %d\\n", (int)m.LEN_REC, m.ITEM.NAME.c_str(),
        (unsigned)m.W2, (int)m.LEN_WS);
    return 0;
}
`;

const EXPECTED = [
  "read 97 98 99",
  "short 3 Xbc | grown 4 abcd | chr 1 A",
  // A string ends at its first NUL; CONCAT sees the grown length.
  "zero 1 | joined 5 1",
  // STRING(80) = 81, STRING = STRING(254) = 255, WSTRING(10) = 22 bytes,
  // STRUCT(BYTE, STRING(10)) = 12.
  "sizeof 81 255 22 12",
  "rec 2 he | ws 98 2",
];

describe.skipIf(!hasGpp)("STRING and WSTRING laid out as on a PLC", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-str-layout-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const opt of ["-O0", "-O2"]) {
    it(`reads characters and follows a written terminator at ${opt}`, () => {
      const result = compile(SOURCE, { headerFileName: "generated.hpp" });
      expect(result.errors.map((e) => e.message)).toEqual([]);
      const out = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: `str_layout${opt.replace("-", "_")}`,
        mainCode: MAIN,
        extraFlags: [opt],
      });
      expect(out.split("\n")).toEqual(EXPECTED);
    });
  }
});
