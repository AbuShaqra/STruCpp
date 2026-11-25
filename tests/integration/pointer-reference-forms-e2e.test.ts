// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E for pointer, reference and alias forms that passed the check and failed
 * g++: each program is compiled, built with g++ and run, and its results read.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

describe.skipIf(!hasGpp)(
  "pointer, reference and alias forms build and run",
  () => {
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-ptrforms-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    /** Compile `source` (features as given), run MAIN `cycles` times, print `outs`. */
    const runMain = (
      name: string,
      source: string,
      outs: string[],
      features: string[] = [],
    ): string[] => {
      const result = compile(source, features.length > 0 ? { features } : {});
      expect(result.errors).toEqual([]);
      const prints = outs
        .map(
          (o) => `    std::cout << static_cast<long long>(prog.${o}) << " ";`,
        )
        .join("\n");
      return compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode!,
        cppCode: result.cppCode!,
        testName: name,
        mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN prog;
    prog.run();
${prints}
    return 0;
}
`,
      }).split(" ");
    };

    it("passes a dereference to a standard function, also through a POINTER TO alias", () => {
      expect(
        runMain(
          "deref_std",
          `TYPE PI : POINTER TO INT; END_TYPE
PROGRAM Main
VAR i : INT := 17; j : INT := 3; q : PI; p : POINTER TO INT; pr : POINTER TO REAL; x : REAL := 2.5;
  r1, r2, r3, r4, r5, r6 : INT; rr : REAL; END_VAR
q := ADR(i); p := ADR(j); pr := ADR(x);
r1 := MOD(q^, 5); r2 := MOD(p^, 5); r3 := MAX(q^, 5); r4 := LIMIT(0, p^, 2);
r5 := ADD(p^, 1); r6 := MOD(q^, p^); rr := MAX(pr^, 1.0) * 2.0;
END_PROGRAM
`,
          ["R1", "R2", "R3", "R4", "R5", "R6", "RR"],
        ),
      ).toEqual(["2", "3", "17", "2", "4", "2", "5"]);
    });

    it("stores into STRUCT POINTER TO members as into a variable", () => {
      expect(
        runMain(
          "struct_pointer_members",
          `TYPE S : STRUCT a : BYTE; p : POINTER TO INT; b : INT; END_STRUCT END_TYPE
TYPE PA : POINTER TO ARRAY[0..3] OF INT; END_TYPE
PROGRAM Main
VAR s : S; s2 : S; arr : ARRAY[0..2] OF S; i : INT := 5; udi : UDINT := 7; pd : POINTER TO INT;
  pa : PA; r1, r2, r3, r4 : INT; sz : UDINT; off : LWORD; END_VAR
pd := ADR(i);
s.p := pd; r1 := s.p^;
s.p := ADR(udi); r2 := s.p^;
s.p := __NEW(INT); s.p^ := 9; s2 := s; arr[1] := s2; r3 := arr[1].p^; __DELETE(s.p);
pa := __NEW(INT, 4); pa^[2] := 11; r4 := pa^[2]; __DELETE(pa);
sz := SIZEOF(s) + SIZEOF(arr); off := ADR(s.b) - ADR(s);
END_PROGRAM
`,
          ["R1", "R2", "R3", "R4", "SZ", "OFF"],
        ),
      ).toEqual(["5", "7", "9", "11", "96", "16"]);
    });

    it("binds a REFERENCE TO a pointer, inline or by alias, and reads through it", () => {
      expect(
        runMain(
          "reference_to_pointer",
          `TYPE PI : POINTER TO INT; END_TYPE
FUNCTION F : INT
VAR_INPUT rp : REFERENCE TO POINTER TO INT; END_VAR
F := rp^; rp^ := 1;
END_FUNCTION
FUNCTION G : INT
VAR_INPUT rp : REFERENCE TO PI; END_VAR
G := rp^ * 10;
END_FUNCTION
PROGRAM Main
VAR i : INT := 3; j : INT := 4; q : POINTER TO INT; qa : PI; rp : REFERENCE TO POINTER TO INT;
  ra : REFERENCE TO PI; rr : REFERENCE TO POINTER TO INT := REF(q); r1, r2, r3, r4, r5 : INT; END_VAR
rp REF= q; rp := ADR(i); r1 := rp^; rp^ := 11;
ra REF= qa; ra := ADR(j); r2 := qa^ + ra^;
r3 := F(q); r4 := rr^; r5 := G(qa);
END_PROGRAM
`,
          ["R1", "R2", "R3", "R4", "R5", "I"],
        ),
      ).toEqual(["3", "8", "11", "1", "40", "1"]);
    });

    it("binds an inline REFERENCE TO ARRAY in a VAR, an input, an FB input and a STRUCT", () => {
      expect(
        runMain(
          "reference_to_array",
          `TYPE TA : ARRAY[0..2] OF INT; END_TYPE
TYPE S : STRUCT ra : REFERENCE TO ARRAY[0..2] OF INT; END_STRUCT END_TYPE
TYPE ST : STRUCT x : INT; END_STRUCT END_TYPE
FUNCTION F : INT
VAR_INPUT ra : REFERENCE TO ARRAY[0..2] OF INT; END_VAR
F := ra[1]; ra[2] := 5;
END_FUNCTION
FUNCTION G : INT
VAR_INPUT rt : REFERENCE TO TA; rs : REFERENCE TO ST; END_VAR
G := rt[0] + rs.x;
END_FUNCTION
FUNCTION_BLOCK FB
VAR_INPUT ra : REFERENCE TO ARRAY[0..2] OF INT; END_VAR
VAR_OUTPUT o : INT; END_VAR
o := ra[0] + ra[1];
END_FUNCTION_BLOCK
PROGRAM Main
VAR a : ARRAY[0..2] OF INT := [1, 7, 0]; t : TA := [2, 0, 0]; st : ST; s : S; fb1 : FB;
  ra : REFERENCE TO ARRAY[0..2] OF INT; r1, r2, r3, r4, r5 : INT; END_VAR
st.x := 30;
ra REF= a; ra[0] := 2; r1 := a[0];
r2 := F(a); r3 := a[2];
fb1(ra := a, o => r4);
s.ra REF= t; r5 := s.ra[0] + G(t, st);
END_PROGRAM
`,
          ["R1", "R2", "R3", "R4", "R5"],
        ),
      ).toEqual(["2", "7", "5", "9", "34"]);
    });

    it("compares and converts an address as a 64-bit integer", () => {
      expect(
        runMain(
          "address_integers",
          `PROGRAM Main
VAR x : INT; y : INT; p : POINTER TO INT; q : POINTER TO INT; lw : LWORD; ul : ULINT; dw : DWORD;
  s : STRING; ps : POINTER TO STRING; li : LINT; b1, b2, b3, b4, b5, b6 : BOOL; END_VAR
p := ADR(x); q := ADR(y); lw := ADR(x); ul := p; ps := ADR(s);
b1 := lw = ADR(x); b2 := ul = ADR(x); b3 := p = q; b4 := ps > 0;
dw := LWORD_TO_DWORD(ADR(x)); li := LWORD_TO_LINT(ADR(x));
b5 := dw = LWORD_TO_DWORD(lw); b6 := li <> 0;
END_PROGRAM
`,
          ["B1", "B2", "B3", "B4", "B5", "B6"],
        ),
      ).toEqual(["1", "1", "0", "1", "1", "1"]);
    });

    it("passes ADR to a REF_TO input and copies through pointers with MEMCPY", () => {
      expect(
        runMain(
          "adr_ref_to_memcpy",
          `FUNCTION F : INT
VAR_INPUT r : REF_TO INT; END_VAR
F := r^ + 1;
END_FUNCTION
PROGRAM Main
VAR i : INT := 4; a : INT := 9; b : INT; c : INT; p : POINTER TO INT; q : POINTER TO INT; r1, r2 : INT; END_VAR
r1 := F(ADR(i));
p := ADR(a); q := ADR(b); MEMCPY(q, p, 2); MEMCPY(ADR(c), q, SIZEOF(c)); r2 := b + c;
END_PROGRAM
`,
          ["R1", "R2"],
        ),
      ).toEqual(["5", "18"]);
    });

    it("steps a POINTER TO FOR loop to a computed end, by an integer variable", () => {
      expect(
        runMain(
          "pointer_for_loops",
          `TYPE PINT : POINTER TO INT; END_TYPE
PROGRAM Main
VAR x : ARRAY[0..3] OF INT; p : POINTER TO INT; e : PINT; ep : POINTER TO INT; lw : LWORD;
  n : INT := 4; c1, c2, c3 : INT; END_VAR
e := ADR(x[3]); FOR p := ADR(x) TO e DO p^ := 1; c1 := c1 + 1; END_FOR;
ep := ADR(x[3]); FOR p := ADR(x) TO ep BY n DO c2 := c2 + 1; END_FOR;
lw := ADR(x[1]); FOR p := ADR(x) TO lw + 2 DO c3 := c3 + 1; END_FOR;
END_PROGRAM
`,
          ["C1", "C2", "C3"],
        ),
      ).toEqual(["4", "2", "3"]);
    });

    it("reads a POINTER TO member of a UNION and of a STRUCT in a UNION", () => {
      expect(
        runMain(
          "union_pointer_members",
          `TYPE S : STRUCT a : BYTE; p : POINTER TO INT; END_STRUCT END_TYPE
TYPE U : UNION p : POINTER TO INT; lw : LWORD; END_UNION END_TYPE
TYPE U2 : UNION s : S; lw : ARRAY[0..1] OF LWORD; END_UNION END_TYPE
PROGRAM Main
VAR u : U; u2 : U2; i : INT := 5; r1, r2 : INT; b1, b2 : BOOL; END_VAR
u.p := ADR(i); r1 := u.p^; b1 := u.lw = ADR(i);
u2.s.p := ADR(i); u2.s.p^ := 6; r2 := u2.s.p^; b2 := u2.lw[1] = ADR(i);
END_PROGRAM
`,
          ["R1", "R2", "B1", "B2"],
          ["+union"],
        ),
      ).toEqual(["5", "6", "1", "1"]);
    });

    it("reaches pointer members through an inline POINTER TO, a POINTER TO alias and a REF_TO alias", () => {
      expect(
        runMain(
          "members_through_aliases",
          `TYPE S : STRUCT p : POINTER TO INT; r : REF_TO INT; a : ARRAY[0..1] OF POINTER TO INT; pp : POINTER TO POINTER TO INT; END_STRUCT END_TYPE
TYPE PS : POINTER TO S; END_TYPE
TYPE RS : REF_TO S; END_TYPE
FUNCTION F : INT
VAR_INPUT p : POINTER TO INT; END_VAR
F := p^;
END_FUNCTION
PROGRAM Main
VAR s : S; ip : POINTER TO S; ap : PS; ar : RS; i : INT := 3; q : POINTER TO INT;
  t1, t2, t3, t4, t5, t6, t7, t8, t9 : INT; END_VAR
ip := ADR(s); ap := ADR(s); ar := REF(s); q := ADR(i);
ip^.p := ADR(i); t1 := ip^.p^ + F(ip^.p);
ap^.p := ADR(i); t2 := ap^.p^ + F(ap^.p);
ar^.p := ADR(i); t3 := ar^.p^ + F(ar^.p);
ap^.r := REF(i); t4 := ap^.r^; ar^.r := REF(i); t5 := ar^.r^;
ap^.a[1] := ADR(i); t6 := ap^.a[1]^ + F(ap^.a[1]); ar^.a[0] := q; t7 := F(ar^.a[0]);
ap^.pp := ADR(q); t8 := ap^.pp^^; ar^.pp := ADR(q); t9 := F(ar^.pp^);
q := ap^.p; q := ar^.a[1];
END_PROGRAM
`,
          ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9"],
        ),
      ).toEqual(["6", "6", "6", "3", "3", "6", "3", "3", "3"]);
    });

    it("stores 0 and NULL into a REF_TO everywhere: assignment, input, default, STRUCT, array", () => {
      expect(
        runMain(
          "ref_to_null",
          `TYPE S : STRUCT r : REF_TO INT := 0; n : REF_TO INT := NULL; END_STRUCT END_TYPE
FUNCTION F : INT
VAR_INPUT r : REF_TO INT := 0; END_VAR
IF r = 0 THEN F := -1; ELSE F := r^; END_IF;
END_FUNCTION
FUNCTION_BLOCK FB
VAR_INPUT r : REF_TO INT := NULL; END_VAR
VAR_OUTPUT o : INT; END_VAR
IF r <> NULL THEN o := r^; ELSE o := -2; END_IF;
END_FUNCTION_BLOCK
PROGRAM Main
VAR i : INT := 7; r : REF_TO INT := 0; r2 : REF_TO INT := NULL; s : S; s2 : S := (r := 0, n := NULL);
  ar : ARRAY[0..1] OF REF_TO INT := [0, NULL]; fb : FB; a, b, c, d, e, g : INT; b1, b2, b3, b4 : BOOL; END_VAR
r := 0; r2 := NULL; ar[0] := 0; ar[1] := NULL; s.r := 0; s.n := NULL;
a := F(0); b := F(NULL); c := F(); d := F(REF(i)); fb(r := 0); e := fb.o; fb(r := REF(i)); g := fb.o;
b1 := r = 0; b2 := r2 = NULL; b3 := s2.r = 0; b4 := ar[1] = NULL;
END_PROGRAM
`,
          ["A", "B", "C", "D", "E", "G", "B1", "B2", "B3", "B4"],
        ),
      ).toEqual(["-1", "-1", "-1", "7", "-2", "7", "1", "1", "1", "1"]);
    });

    it("binds an enumeration, a STRING and a STRUCT to REFERENCE TO inputs of an FB", () => {
      expect(
        runMain(
          "reference_inputs_enum",
          `TYPE E : (A1, B1, C1); END_TYPE
TYPE S : STRUCT x : INT; END_STRUCT END_TYPE
FUNCTION_BLOCK FB
VAR_INPUT ri : REFERENCE TO INT; re : REFERENCE TO E; rs : REFERENCE TO STRING; rst : REFERENCE TO S; END_VAR
ri := ri + 1; re := C1; rs := 'zz'; rst.x := 3;
END_FUNCTION_BLOCK
PROGRAM Main
VAR i : INT := 1; e : E; s : STRING; st : S; fb : FB; r1, r2, r3, r4 : INT; END_VAR
fb(ri := i, re := e, rs := s, rst := st);
r1 := i; IF e = C1 THEN r2 := 1; END_IF; r3 := LEN(s); r4 := st.x;
END_PROGRAM
`,
          ["R1", "R2", "R3", "R4"],
        ),
      ).toEqual(["2", "1", "2", "3"]);
    });

    it("takes 0 into a REF_TO in an FB input and VAR default, a REF_TO STRUCT, reversed comparisons and a LINT", () => {
      expect(
        runMain(
          "ref_to_zero_forms",
          `TYPE S : STRUCT a : INT; END_STRUCT END_TYPE
TYPE S3 : STRUCT r : REF_TO S := 0; END_STRUCT END_TYPE
FUNCTION_BLOCK FB
VAR_INPUT r : REF_TO INT := 0; END_VAR
VAR q : REF_TO INT := 0; END_VAR
VAR_OUTPUT o : INT; END_VAR
IF 0 = r THEN o := -1; ELSE o := r^; END_IF;
IF NULL <> q THEN o := o + 100; END_IF;
END_FUNCTION_BLOCK
PROGRAM Main
VAR i : INT := 4; x : LINT; ri : REF_TO INT; rs : REF_TO S; s : S; s3 : S3; ar : ARRAY[0..1] OF REF_TO S; fb : FB;
  o1, o2 : INT; b1, b2 : BOOL; END_VAR
fb(); o1 := fb.o; fb(r := REF(i)); o2 := fb.o;
rs := REF(s); rs := 0; s3.r := 0; ar[1] := 0; b1 := 0 = rs AND s3.r = 0 AND ar[1] = 0;
x := 0; ri := x; b2 := ri = 0;
END_PROGRAM
`,
          ["O1", "O2", "B1", "B2"],
        ),
      ).toEqual(["-1", "4", "1", "1"]);
    });
  },
);
