// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: variables are laid out as on a PLC, so a POINTER TO of another shape
 * reads and writes the target's real bytes: a DWORD as ARRAY OF BYTE, an
 * ARRAY OF BYTE through POINTER TO BYTE / WORD, a REAL as a DWORD, a STRUCT
 * as bytes. Every case runs at -O0 and at -O2, where type-based alias
 * analysis would otherwise reorder the punned accesses.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `
TYPE S3 : STRUCT a : BYTE; b : WORD; c : BOOL; END_STRUCT END_TYPE
TYPE S2 : STRUCT w : WORD; d : DWORD; END_STRUCT END_TYPE
TYPE Color : (RED, GREEN, BLUE); END_TYPE

FUNCTION DwordBytes : DWORD
  VAR_INPUT x : DWORD; END_VAR
  VAR d : DWORD; p : POINTER TO ARRAY[0..3] OF BYTE; END_VAR
  d := x;
  p := ADR(d);
  p^[3] := 16#55;          (* write the most significant byte *)
  DwordBytes := d;
END_FUNCTION

FUNCTION RealBits : DWORD
  VAR_INPUT r : REAL; END_VAR
  VAR t : REAL; pt : POINTER TO DWORD; END_VAR
  t := r;
  pt := ADR(t);
  RealBits := pt^;
END_FUNCTION

FUNCTION RealArrayBits : DWORD
  VAR_INPUT x : REAL; END_VAR
  VAR a : ARRAY[0..1] OF REAL; pa : POINTER TO ARRAY[0..1] OF DWORD; END_VAR
  a[0] := x; a[1] := x;
  pa := ADR(a);
  pa^[1] := 16#40000000;   (* 2.0 *)
  RealArrayBits := pa^[0] + REAL_TO_DWORD(a[1]);
END_FUNCTION

FUNCTION StructBytes : DWORD
  VAR s : S2; pb : POINTER TO ARRAY[0..7] OF BYTE; END_VAR
  s.w := 16#1111; s.d := 16#22222222;
  pb := ADR(s);
  pb^[4] := 16#99;
  StructBytes := s.d;
END_FUNCTION

FUNCTION StructFromBytes : DWORD
  VAR raw : ARRAY[0..7] OF BYTE; ps : POINTER TO S2; s : S2; END_VAR
  raw[4] := 16#78; raw[5] := 16#56; raw[6] := 16#34; raw[7] := 16#12;
  ps := ADR(raw);
  s := ps^;
  ps^.d := 16#AABBCCDD;
  StructFromBytes := s.d + BYTE_TO_DWORD(raw[4]);
END_FUNCTION

PROGRAM Main
  VAR
    d : DWORD := 16#11223344;
    p : POINTER TO ARRAY[0..3] OF BYTE;
    arr : ARRAY[0..3] OF BYTE := [1, 2, 3, 4];
    pb : POINTER TO BYTE;
    warr : ARRAY[0..3] OF BYTE := [16#11, 16#22, 16#33, 16#44];
    pw : POINTER TO WORD;
    s3 : S3;
    c : Color;
    r0, r3, b1, b2, w0, w1 : DWORD;
    dw, rb, rab, sb, sfb : DWORD;
    walk : DWORD;
    i : INT;
    sz_byte, sz_dword, sz_arr, sz_s3, sz_s2, sz_enum, sz_lreal : UDINT;
  END_VAR
  p := ADR(d);
  r0 := p^[0];
  r3 := p^[3];
  pb := ADR(arr);
  pb := pb + 1;
  b1 := pb^;
  pb^ := 16#7F;            (* write through POINTER TO BYTE *)
  b2 := arr[1];
  pb := ADR(arr);
  walk := 0;
  FOR i := 0 TO 3 DO
    walk := walk * 256 + pb^;
    pb := pb + 1;
  END_FOR;
  pw := ADR(warr);
  w0 := pw^;
  pw := pw + 1;            (* one byte on: pointer arithmetic counts bytes *)
  w1 := pw^;
  dw := DwordBytes(16#11223344);
  rb := RealBits(1.0);
  rab := RealArrayBits(1.0);
  sb := StructBytes();
  sfb := StructFromBytes();
  sz_byte := SIZEOF(arr[0]);
  sz_dword := SIZEOF(d);
  sz_arr := SIZEOF(arr);
  sz_s3 := SIZEOF(s3);
  sz_s2 := SIZEOF(d) + 4;
  sz_enum := SIZEOF(c);
  sz_lreal := 8;
END_PROGRAM
`;

const MAIN = `
#include <cstdio>
int main() {
    strucpp::Program_MAIN m;
    m.run();
    std::printf("r0=%x r3=%x b1=%u b2=%u walk=%x w0=%x w1=%x\\n",
        (unsigned)m.R0, (unsigned)m.R3, (unsigned)m.B1, (unsigned)m.B2,
        (unsigned)m.WALK, (unsigned)m.W0, (unsigned)m.W1);
    std::printf("dw=%x rb=%x rab=%x sb=%x sfb=%x\\n",
        (unsigned)m.DW, (unsigned)m.RB, (unsigned)m.RAB, (unsigned)m.SB, (unsigned)m.SFB);
    std::printf("sizeof byte=%u dword=%u arr=%u s3=%u enum=%u\\n",
        (unsigned)m.SZ_BYTE, (unsigned)m.SZ_DWORD, (unsigned)m.SZ_ARR,
        (unsigned)m.SZ_S3, (unsigned)m.SZ_ENUM);
    return 0;
}
`;

const EXPECTED = [
  // little-endian bytes of 16#11223344; POINTER TO BYTE reads and writes arr[1];
  // a POINTER TO BYTE walks the array in order; POINTER TO WORD reads two bytes.
  "r0=44 r3=11 b1=2 b2=127 walk=17f0304 w0=2211 w1=3322",
  // byte write into a DWORD; REAL 1.0 bits; DWORD write into a REAL array;
  // byte write into a STRUCT; STRUCT read from bytes, then written through.
  "dw=55223344 rb=3f800000 rab=3f800002 sb=22222299 sfb=12345755",
  // PLC sizes: STRUCT(BYTE, WORD, BOOL) is naturally aligned, an enumeration INT.
  "sizeof byte=1 dword=4 arr=4 s3=6 enum=2",
];

describe.skipIf(!hasGpp)("PLC memory layout through pointers", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-ptr-layout-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const opt of ["-O0", "-O2"]) {
    it(`reads and writes the target's bytes at ${opt}`, () => {
      const result = compile(SOURCE, { headerFileName: "generated.hpp" });
      expect(result.errors.map((e) => e.message)).toEqual([]);
      const out = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: `ptr_layout${opt.replace("-", "_")}`,
        mainCode: MAIN,
        extraFlags: [opt],
      });
      expect(out.split("\n")).toEqual(EXPECTED);
    });
  }

  it("keeps every elementary wrapper the size and alignment of its value", () => {
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: "",
      cppCode: "",
      testName: "wrapper_sizes",
      mainCode: `
#include "iec_var.hpp"
#include "iec_enum.hpp"
#include <cstdio>
#include <type_traits>
using namespace strucpp;
enum class E : INT_t { A, B };
template <typename W, typename T> int check() {
    return sizeof(W) == sizeof(T) && alignof(W) == alignof(T) &&
           std::is_standard_layout<W>::value && std::is_trivially_copyable<W>::value;
}
int main() {
    std::printf("%d%d%d%d%d%d%d%d%d\\n",
        check<IEC_BOOL, BOOL_t>(), check<IEC_BYTE, BYTE_t>(), check<IEC_WORD, WORD_t>(),
        check<IEC_DWORD, DWORD_t>(), check<IEC_LWORD, LWORD_t>(), check<IEC_REAL, REAL_t>(),
        check<IEC_LREAL, LREAL_t>(), check<IEC_TIME, TIME_t>(), check<IEC_ENUM_Var<E>, E>());
    return 0;
}
`,
    });
    expect(out).toBe("111111111");
  });
});
