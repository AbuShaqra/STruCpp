/**
 * E2E for the UNION lowering (feature union): members share one storage, so
 * writing one and reading another reinterprets the bytes (little-endian host).
 * Covers REAL/DWORD punning, a byte-array view, a STRUCT inside a UNION (whole
 * and per field), a UNION inside a STRUCT and an FB (input, in-out, local), an
 * array of UNIONs with whole-element copy, VAR_IN_OUT write-back of a UNION and
 * of a member, a VAR_INPUT, whole-union copy, a bit write, ADR of a member and
 * a STRING member read after another member was written. Compiled with g++ and
 * run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile, compileStlib } from "../../src/index.js";
import { loadStlibArchive } from "../../src/library/library-loader.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

export const UNION_E2E_SOURCE = `TYPE
  ST_P : STRUCT x : INT; y : INT; END_STRUCT;
  U_A : UNION
    f : REAL;
    d : DWORD;
    arr : ARRAY[0..3] OF BYTE;
    st : ST_P;
  END_UNION;
  U_T : UNION s : STRING(3); d : DWORD; b : ARRAY[0..3] OF BYTE; END_UNION;
  ST_W : STRUCT k : INT; u : U_A; END_STRUCT;
END_TYPE

FUNCTION F_Inc : INT
VAR_IN_OUT x : U_A; END_VAR
x.d := x.d + 1;
F_Inc := 1;
END_FUNCTION

FUNCTION F_Dbl : INT
VAR_IN_OUT r : REAL; END_VAR
r := r * 2.0;
F_Dbl := 2;
END_FUNCTION

FUNCTION F_Get : DWORD
VAR_INPUT x : U_A; END_VAR
F_Get := x.d;
END_FUNCTION

FUNCTION_BLOCK FB_U
VAR_INPUT i : U_A; END_VAR
VAR_IN_OUT io : U_A; END_VAR
VAR_OUTPUT o : DWORD; END_VAR
VAR held : U_A; END_VAR
held := i;
held.arr[0] := 16#FF;
io.arr[3] := 16#7F;
o := held.d;
END_FUNCTION_BLOCK

PROGRAM Main
VAR
  u, u2 : U_A;
  t : U_T;
  w : ST_W;
  au : ARRAY[1..3] OF U_A;
  fb : FB_U;
  p : ST_P;
  pr : POINTER TO REAL;
  i : INT;
  r1, r2, r3, r4, r5, r6, r7, r8, r9, r10, r11, r12 : DWORD;
  b1, b2, b3 : BYTE;
  s1, s2 : STRING;
  n1, n2 : INT;
  f1 : REAL;
END_VAR
u.f := 1.0;
r1 := u.d;
u.d := 16#40490FDB;
f1 := u.f;
u.d := 16#11223344;
b1 := u.arr[0];
b2 := u.arr[3];
i := 1;
u.arr[i] := 16#AB;
r2 := u.d;
u.st.x := 1;
u.st.y := 2;
r3 := u.d;
p := u.st;
p.y := 7;
u.st := p;
r4 := u.d;
w.u.d := 16#3F800000;
w.k := 5;
f1 := f1 + w.u.f;
au[2].d := 16#01020304;
au[3] := au[2];
au[3].arr[0] := 0;
r5 := au[2].d + au[3].d;
u.d := 16#40000000;
n1 := F_Inc(x := u);
r6 := u.d;
u.f := 3.0;
n2 := F_Dbl(r := u.f);
r7 := u.d;
u2 := u;
u.d := 0;
r8 := u2.d + F_Get(u2);
fb(i := u2, io := u);
r9 := fb.o;
r10 := u.d;
t.d := 16#44434241;
s1 := t.s;
n1 := LEN(t.s);
t.d := 16#00004241;
n2 := LEN(t.s);
t.s := 'hi';
s2 := t.s;
b3 := t.b[2];
r11 := t.d;
u.d := 0;
u.d.31 := TRUE;
r12 := u.d;
pr := ADR(u.f);
pr^ := 2.0;
r12 := r12 + u.d;
END_PROGRAM
`;

/** Member kinds: LREAL/LWORD, a UNION in a UNION, an array of STRUCTs, a 2-D
 *  array, an enumeration, WSTRING, POINTER TO, TIME, BOOL; a global UNION, an
 *  FB output, a function result and a member bound to VAR_IN_OUT in a WHILE. */
export const UNION_SHAPES_SOURCE = `TYPE
  E_C : DINT (RED := 1, GREEN := 2, BLUE := 3);
  ST_Q : STRUCT a : BYTE; b : WORD; END_STRUCT;
  U_IN : UNION w : WORD; bb : ARRAY[0..1] OF BYTE; END_UNION;
  U_B : UNION
    lw : LWORD;
    lr : LREAL;
    inner : U_IN;
    qs : ARRAY[1..2] OF ST_Q;
    m : ARRAY[0..1, 0..1] OF WORD;
    e : E_C;
    ws : WSTRING(3);
    pi : POINTER TO INT;
    t : TIME;
    flag : BOOL;
  END_UNION;
END_TYPE

VAR_GLOBAL
  g : U_B;
END_VAR

FUNCTION_BLOCK FB_O
VAR_OUTPUT q : U_IN; END_VAR
q.w := 16#BEEF;
END_FUNCTION_BLOCK

FUNCTION F_Set : U_IN
VAR_INPUT v : WORD; END_VAR
F_Set.w := v;
END_FUNCTION

FUNCTION F_Inc : BOOL
VAR_IN_OUT x : WORD; END_VAR
x := x + 1;
F_Inc := x < 16#0003;
END_FUNCTION

PROGRAM Main
VAR
  u : U_B;
  fb : FB_O;
  k, j : INT;
  target : INT := 42;
  r1, r2, r3, r4, r5, r6, r7, r8 : LWORD;
  n1, n2, n3 : DINT;
  ok : BOOL;
  ws : WSTRING;
END_VAR
u.lr := 1.0;
r1 := u.lw;
u.lw := 0;
u.inner.w := 16#1234;
r2 := u.lw;
u.inner.bb[0] := 16#FF;
r3 := u.inner.w;
FOR k := 1 TO 2 DO
  u.qs[k].a := INT_TO_BYTE(k);
  u.qs[k].b := 16#AAAA;
END_FOR;
r4 := u.lw;
u.lw := 0;
FOR k := 0 TO 1 DO
  FOR j := 0 TO 1 DO
    u.m[k, j] := INT_TO_WORD(k * 2 + j + 1);
  END_FOR;
END_FOR;
r5 := u.lw;
u.lw := 2;
IF u.e = GREEN THEN n1 := 1; END_IF;
u.e := BLUE;
n2 := DINT_TO_INT(u.lw);
u.lw := 16#0000004300420041;
ws := u.ws;
n3 := 0;
u.pi := ADR(target);
u.pi^ := u.pi^ + 1;
u.lw := 0;
u.t := T#1s;
r6 := u.lw;
u.lw := 16#100;
ok := u.flag;
u.lw := 16#101;
IF u.flag THEN ok := ok OR TRUE; n3 := n3 + 10; END_IF;
fb();
u.inner := fb.q;
g.inner := F_Set(v := 16#0102);
r7 := g.lw + u.inner.w;
u.lw := 0;
WHILE F_Inc(x := u.inner.w) DO
  n3 := n3 + 100;
END_WHILE;
r8 := u.lw;
END_PROGRAM
`;

describe.skipIf(!hasGpp)("UNION, run end to end", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-union-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("members overlay one storage in every place a UNION goes", () => {
    const result = compile(UNION_E2E_SOURCE, {
      fileName: "main.st",
      features: ["+union"],
    });
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);

    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode!,
      cppCode: result.cppCode!,
      testName: "union_e2e",
      mainCode: `
#include <cstdio>
int main() {
    strucpp::Program_MAIN prog;
    prog.run();
    const unsigned r[] = {
        static_cast<unsigned>(prog.R1), static_cast<unsigned>(prog.R2),
        static_cast<unsigned>(prog.R3), static_cast<unsigned>(prog.R4),
        static_cast<unsigned>(prog.R5), static_cast<unsigned>(prog.R6),
        static_cast<unsigned>(prog.R7), static_cast<unsigned>(prog.R8),
        static_cast<unsigned>(prog.R9), static_cast<unsigned>(prog.R10),
        static_cast<unsigned>(prog.R11), static_cast<unsigned>(prog.R12)};
    for (unsigned v : r) std::printf("%08X ", v);
    std::printf("| %02X %02X %02X | %s %d %d %s | %.4f %d\\n",
        static_cast<unsigned>(prog.B1), static_cast<unsigned>(prog.B2),
        static_cast<unsigned>(prog.B3), prog.S1.get().c_str(),
        static_cast<int>(prog.N1), static_cast<int>(prog.N2),
        prog.S2.get().c_str(), static_cast<double>(prog.F1),
        static_cast<int>(sizeof(strucpp::U_A)));
    return 0;
}
`,
    });
    // r1 1.0 as bits; r2 byte 1 of 16#11223344 replaced; r3/r4 ST_P over the
    // DWORD; r5 two array elements; r6 VAR_IN_OUT +1; r7 3.0 doubled through
    // a REAL VAR_IN_OUT bound to u.f; r8 copy and VAR_INPUT; r9/r10 FB input
    // and in-out; r11 'hi' + NUL over the DWORD; r12 bit 31 then ADR write of
    // 2.0. STRING(3) over 16#44434241 reads 'ABC' (no NUL within 3 bytes).
    expect(stdout).toBe(
      "3F800000 1122AB44 00020001 00070001 02040604 40000001 40C00000 " +
        "81800000 40C000FF 7F000000 00006968 C0000000 " +
        "| 44 11 00 | ABC 3 2 hi | 4.1416 4",
    );
  });

  it("every member kind reads back through the shared storage", () => {
    const result = compile(UNION_SHAPES_SOURCE, {
      fileName: "main.st",
      features: ["+union"],
    });
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);

    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode!,
      cppCode: result.cppCode!,
      testName: "union_shapes",
      mainCode: `
#include <cstdio>
int main() {
    strucpp::Program_MAIN prog;
    prog.run();
    const unsigned long long r[] = {
        static_cast<unsigned long long>(prog.R1), static_cast<unsigned long long>(prog.R2),
        static_cast<unsigned long long>(prog.R3), static_cast<unsigned long long>(prog.R4),
        static_cast<unsigned long long>(prog.R5), static_cast<unsigned long long>(prog.R6),
        static_cast<unsigned long long>(prog.R7), static_cast<unsigned long long>(prog.R8)};
    for (unsigned long long v : r) std::printf("%016llX ", v);
    std::printf("| %d %d %d %d %d %d\\n",
        static_cast<int>(prog.N1), static_cast<int>(prog.N2),
        static_cast<int>(prog.N3), static_cast<int>(prog.TARGET),
        static_cast<int>(prog.OK), static_cast<int>(prog.WS.get().length()));
    return 0;
}
`,
    });
    // r4 keeps the padding byte of ST_Q from the earlier inner.w write; r5 is
    // row-major; r6 is T#1s in ns; r8 counts the in-out increments.
    expect(stdout).toBe(
      "3FF0000000000000 0000000000001234 00000000000012FF AAAA0002AAAA1201 " +
        "0004000300020001 000000003B9ACA00 000000000000BFF1 0000000000000003 " +
        "| 1 3 210 43 1 3",
    );
  });

  it("a UNION exported by a library is used by a consumer library and a program", () => {
    const libA = compileStlib(
      [
        {
          source: `TYPE
  ST_L : STRUCT lo : WORD; hi : WORD; END_STRUCT;
  U_L : UNION f : REAL; d : DWORD; st : ST_L; END_UNION;
END_TYPE
FUNCTION F_Bits : DWORD
VAR_INPUT x : U_L; END_VAR
F_Bits := x.d;
END_FUNCTION
`,
          fileName: "ua.st",
        },
      ],
      { name: "ua", version: "1.0.0", namespace: "ua", features: ["+union"] },
    );
    expect(libA.errors).toEqual([]);
    expect(libA.success).toBe(true);
    const entry = libA.archive.manifest.types.find((t) => t.name === "U_L");
    expect(entry).toEqual({
      name: "U_L",
      kind: "union",
      fields: [
        { name: "F", type: "REAL" },
        { name: "D", type: "DWORD" },
        { name: "ST", type: "ST_L" },
      ],
    });
    // The manifest survives a serialize/load round-trip.
    const reloadedA = loadStlibArchive(JSON.parse(JSON.stringify(libA.archive)));

    const libB = compileStlib(
      [
        {
          source: `FUNCTION F_Pun : DWORD
VAR_INPUT r : REAL; END_VAR
VAR_IN_OUT u : U_L; END_VAR
u.f := r;
u.st.hi := u.st.hi + 1;
F_Pun := F_Bits(u);
END_FUNCTION
`,
          fileName: "ub.st",
        },
      ],
      {
        name: "ub",
        version: "1.0.0",
        namespace: "ub",
        features: ["+union"],
        dependencies: [reloadedA],
      },
    );
    expect(libB.errors).toEqual([]);
    expect(libB.success).toBe(true);

    const result = compile(
      `PROGRAM Main
VAR u, v : U_L; r1, r2, r3 : DWORD; END_VAR
u.st.lo := 16#0001;
r1 := u.d;
r2 := F_Pun(r := 1.0, u := v);
r3 := v.d;
END_PROGRAM
`,
      {
        fileName: "main.st",
        features: ["+union"],
        libraries: [reloadedA, libB.archive],
      },
    );
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);

    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode!,
      cppCode: result.cppCode!,
      testName: "union_library",
      mainCode: `
#include <cstdio>
int main() {
    strucpp::Program_MAIN prog;
    prog.run();
    std::printf("%08X %08X %08X\\n", static_cast<unsigned>(prog.R1),
                static_cast<unsigned>(prog.R2), static_cast<unsigned>(prog.R3));
    return 0;
}
`,
    });
    // 1.0 is 16#3F800000; +1 on the high WORD gives 16#3F810000, written
    // back through the VAR_IN_OUT.
    expect(stdout).toBe("00000001 3F810000 3F810000");
  });
});
