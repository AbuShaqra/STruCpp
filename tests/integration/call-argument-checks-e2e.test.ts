// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: forms the added checks warn about build and run with the right
 * values: a typed conversion of the long or short form of its date or time
 * (`LTIME_TO_DINT(t)` of a TIME), a library FUNCTION's scalar in/out copied
 * in and out, LTIME elements of initializers stored in TIME, `0` returned as
 * a METHOD's interface result, a POINTER TO result stored in a pointer and an
 * ARRAY OF DINT passed to an ARRAY OF INT input. g++ and run.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile, compileStlib } from "../../src/index.js";
import { loadStlibArchive } from "../../src/library/library-loader.js";
import type { StlibArchive } from "../../src/library/library-manifest.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const MAIN = (expr: string): string => `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << ${expr} << std::endl;
    return 0;
}
`;

describe.skipIf(!hasGpp)("added argument checks — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-argchecks-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const run = (
    source: string,
    print: string,
    name: string,
    libraries: StlibArchive[] = [],
  ): { stdout: string; warnings: string[] } => {
    const result = compile(source, {
      headerFileName: "generated.hpp",
      libraries,
    });
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: name,
      mainCode: MAIN(print),
    });
    return { stdout, warnings: result.warnings.map((w) => w.message) };
  };

  it("converts a short date or time into its long form's conversion, and the long into the short one's", () => {
    const { stdout, warnings } = run(
      `PROGRAM Main
VAR t : TIME := T#3ms; lt : LTIME := LTIME#4ms; dt1 : DT := DT#1970-01-01-00:00:02;
  tod1 : TOD := TOD#00:00:01; r : LINT; END_VAR
r := LTIME_TO_LINT(t);
r := r + TIME_TO_LINT(lt) * 10;
r := r + LDT_TO_LINT(dt1) / 1000;
r := r + LTOD_TO_LINT(tod1);
END_PROGRAM
`,
      "p.R",
      "argchecks_temporal",
    );
    expect(stdout).toBe(String(3000000 + 40 + 2000000 + 1000000000));
    expect(warnings).toEqual([
      "Argument 'IN' of 'TIME_TO_LINT' expects TIME, got LTIME",
    ]);
  });

  it("copies a library FUNCTION's scalar in/out of another type in and out", () => {
    const lib = compileStlib(
      [
        {
          source: `FUNCTION F_IO : INT VAR_IN_OUT x : INT; END_VAR x := x + 1; F_IO := x; END_FUNCTION`,
          fileName: "lib.st",
        },
      ],
      { name: "lio", version: "1.0.0", namespace: "lio" },
    );
    expect(lib.errors).toEqual([]);
    const { stdout, warnings } = run(
      `PROGRAM Main
VAR w : WORD := 4; ui : UINT := 7; r : DINT; END_VAR
r := F_IO(ui);
r := r * 100 + F_IO(w);
r := r * 100 + UINT_TO_DINT(ui) * 10 + WORD_TO_DINT(w);
END_PROGRAM
`,
      "p.R",
      "argchecks_lib_inout",
      [loadStlibArchive(JSON.parse(JSON.stringify(lib.archive)))],
    );
    expect(stdout).toBe("80585");
    expect(warnings).toHaveLength(2);
  });

  it("stores LTIME elements of STRUCT and ARRAY initializers in TIME", () => {
    const { stdout } = run(
      `TYPE S_T : STRUCT t : TIME; u : INT; END_STRUCT END_TYPE
TYPE S_W : STRUCT s : S_T; END_STRUCT END_TYPE
PROGRAM Main
VAR s : S_T := (t := LTIME#1s, u := 2);
  a : ARRAY[1..2] OF TIME := [LTIME#2s, T#3s];
  w : S_W := (s := (t := LTIME#4s));
  sa : ARRAY[1..2] OF S_T := [(t := LTIME#5s), (t := T#6s)];
  r : DINT;
END_VAR
r := TIME_TO_DINT(s.t) + TIME_TO_DINT(a[1]) + TIME_TO_DINT(a[2])
  + TIME_TO_DINT(w.s.t) + TIME_TO_DINT(sa[1].t) + TIME_TO_DINT(sa[2].t);
END_PROGRAM
`,
      "p.R",
      "argchecks_ltime_init",
    );
    expect(stdout).toBe("21000");
  });

  it("returns 0 as a METHOD's interface result (NULL) and a POINTER TO result into a pointer", () => {
    const { stdout } = run(
      `INTERFACE I_A END_INTERFACE
FUNCTION_BLOCK FB_A
METHOD MM : I_A MM := 0; END_METHOD
END_FUNCTION_BLOCK
FUNCTION F10 : POINTER TO INT VAR_INPUT p : POINTER TO INT; END_VAR F10 := p; END_FUNCTION
PROGRAM Main
VAR fb : FB_A; i : I_A; p : POINTER TO INT; v : INT := 9; r : INT; END_VAR
i := fb.MM();
IF i = 0 THEN r := 10; END_IF
p := F10(ADR(v));
r := r + p^;
END_PROGRAM
`,
      "p.R",
      "argchecks_null_ptr",
    );
    expect(stdout).toBe("19");
  });

  it("passes an ARRAY OF DINT to an ARRAY OF INT input with a warning", () => {
    const { stdout, warnings } = run(
      `FUNCTION F3 : INT VAR_INPUT a : ARRAY[1..3] OF INT; END_VAR F3 := a[1] + a[3]; END_FUNCTION
PROGRAM Main
VAR d : ARRAY[1..3] OF DINT := [1, 2, 300]; r : INT; END_VAR
r := F3(d);
END_PROGRAM
`,
      "p.R",
      "argchecks_array_dint",
    );
    expect(stdout).toBe("301");
    expect(warnings).toEqual([
      "Implicit narrowing conversion of each element: ARRAY[1..3] OF DINT stored in input 'A' of type ARRAY[1..3] OF INT",
    ]);
  });

  it("converts an LTIME initial value or assignment of a TIME (a warning)", () => {
    const { stdout, warnings } = run(
      `TYPE MyT : TIME; END_TYPE
TYPE S_T2 : STRUCT t : TIME := LTIME#3s; m : MyT := LTIME#4s; END_STRUCT END_TYPE
VAR_GLOBAL g : TIME := LTIME#5s; END_VAR
PROGRAM Main
VAR lt : LTIME := LTIME#2s; t2 : TIME := LTIME#1s; ma : MyT := LTIME#6s; s : S_T2;
  t3 : TIME; r : DINT; END_VAR
t3 := lt;
r := TIME_TO_DINT(t2) + TIME_TO_DINT(t3) + TIME_TO_DINT(s.t) + TIME_TO_DINT(s.m)
  + TIME_TO_DINT(g) + TIME_TO_DINT(ma);
END_PROGRAM
`,
      "p.R",
      "argchecks_ltime_scalar",
    );
    expect(stdout).toBe("21000");
    expect(warnings).toHaveLength(6);
  });

  it("computes TOD, DT and TIME MOD a TIME in STRUCT defaults and initial values", () => {
    const { stdout } = run(
      `TYPE S_M : STRUCT a : TOD := TOD#01:30:00 MOD T#1h; b : TIME := T#90m MOD T#1h; END_STRUCT END_TYPE
PROGRAM Main
VAR s : S_M; u : S_M := (a := TOD#02:10:00 MOD T#1h); v : TOD := TOD#03:20:00 MOD T#1h;
  r : DINT; END_VAR
r := TOD_TO_DINT(s.a) + TIME_TO_DINT(s.b) + TOD_TO_DINT(u.a) + TOD_TO_DINT(v);
END_PROGRAM
`,
      "p.R",
      "argchecks_mod_defaults",
    );
    expect(stdout).toBe(String((30 + 30 + 10 + 20) * 60000));
  });

  it("converts a local LTIME constant in ARRAY and STRUCT initializers of TIME", () => {
    const { stdout, warnings } = run(
      `TYPE S : STRUCT t : TIME; END_STRUCT END_TYPE
PROGRAM Main
VAR CONSTANT c : LTIME := LTIME#2s; END_VAR
VAR a : ARRAY[0..1] OF TIME := [c, c]; s : S := (t := c); r : DINT; END_VAR
r := TIME_TO_DINT(a[1]) + TIME_TO_DINT(s.t);
END_PROGRAM
`,
      "p.R",
      "argchecks_ltime_local_const",
    );
    expect(stdout).toBe("4000");
    expect(warnings).toHaveLength(3);
  });

  it("converts an LTIME output captured into a TIME with =>", () => {
    const { stdout, warnings } = run(
      `FUNCTION_BLOCK FB VAR_OUTPUT lo : LTIME; END_VAR lo := LTIME#2500ms; END_FUNCTION_BLOCK
PROGRAM Main
VAR f : FB; t : TIME; r : DINT; END_VAR
f(lo => t);
r := TIME_TO_DINT(t);
END_PROGRAM
`,
      "p.R",
      "argchecks_ltime_capture",
    );
    expect(stdout).toBe("2500");
    expect(warnings).toEqual([
      "Cannot assign LTIME to TIME without a conversion; use LTIME_TO_TIME",
    ]);
  });

  it("starts an ARRAY OF an alias with a default at that default", () => {
    const { stdout } = run(
      `TYPE E1 : (A1, B1, C1) := B1; END_TYPE
TYPE AL2 : E1 := C1; END_TYPE
TYPE Eb : (Q2 := 4, P2 := 6) := Eb#P2; END_TYPE
TYPE S2 : STRUCT a : ARRAY[0..1] OF AL2; b : AL2; END_STRUCT END_TYPE
PROGRAM Main
VAR x : ARRAY[0..1] OF AL2; y : Eb; z : ARRAY[0..2] OF Eb; s : S2; w : AL2; r : DINT; END_VAR
IF x[1] = E1#C1 THEN r := 1; END_IF
IF y = Eb#P2 THEN r := r + 10; END_IF
IF z[2] = Eb#P2 THEN r := r + 100; END_IF
IF s.a[1] = E1#C1 THEN r := r + 1000; END_IF
IF s.b = E1#C1 THEN r := r + 10000; END_IF
IF w = E1#C1 THEN r := r + 100000; END_IF
END_PROGRAM
`,
      "p.R",
      "argchecks_array_alias_default",
    );
    expect(stdout).toBe("111111");
  });

  it("starts every element of a large ARRAY of a defaulted type at the default", () => {
    const { stdout } = run(
      `TYPE E1 : (A1, B1, C1) := B1; END_TYPE
TYPE AL2 : E1 := C1; END_TYPE
TYPE AI : INT := 7; END_TYPE
TYPE S : STRUCT m : ARRAY[0..1, 0..2] OF AL2; n : ARRAY[0..9999] OF AI; END_STRUCT END_TYPE
VAR_GLOBAL g : ARRAY[1..3] OF AI; END_VAR
FUNCTION_BLOCK FB VAR_OUTPUT o : ARRAY[0..2] OF AI; END_VAR END_FUNCTION_BLOCK
PROGRAM Main
VAR b : ARRAY[0..9999] OF AL2; c : ARRAY[0..1, 0..1, 0..1] OF AI; s : S; fb : FB; r : DINT; END_VAR
IF b[9999] = E1#C1 AND b[0] = E1#C1 THEN r := 1; END_IF
r := r + c[1, 1, 1] * 10 + s.n[9999] * 100 + g[3] * 1000 + fb.o[2] * 10000;
IF s.m[1, 2] = E1#C1 THEN r := r + 100000; END_IF
END_PROGRAM
`,
      "p.R",
      "argchecks_array_fill",
    );
    expect(stdout).toBe("177771");
  });

  it("keeps an ARRAY of an array TYPE with a default building", () => {
    const { stdout } = run(
      `TYPE ROWD : ARRAY[0..1] OF INT := [6, 7]; END_TYPE
TYPE H : STRUCT aa : ARRAY[0..1] OF ROWD; END_STRUCT END_TYPE
PROGRAM Main
VAR aa : ARRAY[0..1] OF ROWD; a3 : ARRAY[0..1, 0..1, 0..1] OF ROWD; h : H; sa : ROWD; r : DINT; END_VAR
r := sa[1] + aa[1][1] * 0 + a3[1, 1, 1][1] * 0 + h.aa[1][1] * 0;
END_PROGRAM
`,
      "p.R",
      "argchecks_array_of_array_default",
    );
    expect(stdout).toBe("7");
  });

  it("gives the remaining elements of a partial initializer the element type's default", () => {
    const { stdout } = run(
      `TYPE AL2 : INT := 42; END_TYPE
TYPE EN2 : (A1, A2, A3) := A3; END_TYPE
TYPE AE : EN2; END_TYPE
TYPE S : STRUCT a : ARRAY[0..2] OF AL2 := [1]; END_STRUCT END_TYPE
PROGRAM Main
VAR a : ARRAY[0..2] OF AL2 := [1]; e : ARRAY[0..2] OF AE := [A1]; s : S; r : DINT; END_VAR
r := a[0] * 10000 + a[2] * 100 + s.a[2];
IF e[0] = A1 AND e[2] = A3 THEN r := r + 1000000; END_IF
END_PROGRAM
`,
      "p.R",
      "argchecks_partial_default",
    );
    expect(stdout).toBe("1014242");
  });

  it("converts a signed LTIME or an LTIME expression into a TIME TYPE default", () => {
    const { stdout, warnings } = run(
      `TYPE LT5 : TIME := -LTIME#3s; END_TYPE
TYPE T6 : TIME := LTIME#1s * 2 + LTIME#500ms; END_TYPE
PROGRAM Main
VAR b : LT5; c : T6; x : TIME := -(LTIME#2s); r : DINT; END_VAR
r := TIME_TO_DINT(b) * 100000 + TIME_TO_DINT(c) * 10 + TIME_TO_DINT(x);
END_PROGRAM
`,
      "p.R",
      "argchecks_ltime_expressions",
    );
    expect(stdout).toBe(String(-3000 * 100000 + 25000 - 2000));
    expect(warnings).toHaveLength(3);
  });

  it("keeps each explicit element's own value and fills the rest at the default, whatever the literal kinds", () => {
    const { stdout } = run(
      `TYPE MR : REAL := 1; END_TYPE
TYPE ML : LINT := 1; END_TYPE
TYPE MW : LWORD := 1; END_TYPE
TYPE MLR : LREAL := 2; END_TYPE
PROGRAM Main
VAR a : ARRAY[0..2] OF MR := [2.5, -0.25]; b : ARRAY[0..1] OF ML := [5000000000];
  c : ARRAY[0..1] OF MR; d : ARRAY[0..1] OF ML; w : ARRAY[0..1] OF MW := [16#FFFFFFFFFF];
  e : ARRAY[0..1] OF MLR := [1.5]; f : ARRAY[0..1] OF MLR;
  r1 : LREAL; r2 : LINT; r3 : LWORD; r4 : LREAL; END_VAR
r1 := a[0] * 100 + a[1] * 10 + a[2];
r4 := c[1] + e[0] * 10 + e[1] * 100 + f[1] * 1000;
r2 := b[0] + b[1] + d[1] * 10;
r3 := w[0] + w[1];
END_PROGRAM
`,
      'p.R1 << " " << p.R2 << " " << p.R3 << " " << p.R4',
      "argchecks_fill_kinds",
    );
    expect(stdout).toBe("248.5 5000000011 1099511627776 2216");
  });

  it("converts integer, real and wide literals of a partial initializer to the element type", () => {
    const { stdout } = run(
      `TYPE MR : REAL := 1; END_TYPE
TYPE ML : LINT := 7; END_TYPE
TYPE MW : LWORD := 16#10; END_TYPE
PROGRAM Main
VAR a : ARRAY[0..3] OF MR := [3, 2.25, 9000000000]; b : ARRAY[0..2] OF ML := [5, 9000000000];
  w : ARRAY[0..2] OF MW := [1, 16#FFFFFFFFFFFFFFFF];
  r1 : LREAL; r2 : LINT; r3 : LWORD; r4 : LWORD; END_VAR
r1 := a[0] * 1000 + a[1] * 100 + a[3];
r2 := b[0] + b[1] + b[2];
r3 := w[0] + w[2]; r4 := w[1];
IF a[2] > 8.9E9 THEN r1 := r1 + 0.5; END_IF;
END_PROGRAM
`,
      'p.R1 << " " << p.R2 << " " << p.R3 << " " << p.R4',
      "argchecks_fill_convert",
    );
    expect(stdout).toBe("3226.5 9000000012 17 18446744073709551615");
  });

  it("stores each kind of element of a partial initializer as an assignment or declaration of it does", () => {
    // Pairs: the element, then a plain variable of the element type given the same value
    const { stdout } = run(
      `TYPE AS2 : STRING(2) := 'z'; END_TYPE
TYPE ASI : SINT := 9; END_TYPE
TYPE AUS : USINT := 4; END_TYPE
TYPE AI : INT := 9; END_TYPE
TYPE AUL : ULINT := 3; END_TYPE
TYPE AUD : UDINT := 4; END_TYPE
TYPE AWS : WSTRING(3) := "y"; END_TYPE
TYPE ATT : TIME := T#1s; END_TYPE
TYPE AE : (EA, EB, EC) := EB; END_TYPE
TYPE ABL : BOOL := TRUE; END_TYPE
TYPE PT : STRUCT x : INT := 5; y : INT := 6; END_STRUCT; END_TYPE
TYPE APT : PT := (y := 8); END_TYPE
VAR_GLOBAL CONSTANT KI : INT := 4; END_VAR
PROGRAM Main
VAR
  a1 : ARRAY[0..2] OF AS2 := ['abcdef']; s1 : AS2;
  a2 : ARRAY[0..2] OF ASI := [200]; s2 : ASI;
  a3 : ARRAY[0..2] OF AUS := [300, -1]; s3 : AUS; s3b : AUS;
  a4 : ARRAY[0..2] OF AI := [2.7]; s4 : AI;
  a5 : ARRAY[0..2] OF AUL := [-1]; s5 : AUL := -1;
  a6 : ARRAY[0..2] OF AUD := [-1]; s6 : AUD := -1;
  a7 : ARRAY[0..2] OF AWS := ["abcdef"]; s7 : AWS;
  a8 : ARRAY[0..2] OF ATT := [T#5ms]; s8 : ATT;
  a9 : ARRAY[0..2] OF AE := [EC]; s9 : AE;
  a10 : ARRAY[0..2] OF ABL := [0, 1]; s10 : ABL; s10b : ABL;
  a11 : ARRAY[0..2] OF APT := [(x := 1)]; s11 : APT;
  a12 : ARRAY[0..2] OF AI := [KI, KI * 2]; s12 : AI; s12b : AI;
  v : ARRAY[0..40] OF LINT;
END_VAR
s1 := 'abcdef'; s2 := 200; s3 := 300; s3b := -1; s4 := 2.7; s7 := "abcdef"; s8 := T#5ms; s9 := EC;
s10 := 0; s10b := 1; s12 := KI; s12b := KI * 2;
v[0] := LEN(a1[0]) * 100 + LEN(s1) * 10 + LEN(a1[1]); v[1] := BOOL_TO_INT(a1[0] = s1);
v[2] := a2[0]; v[3] := s2; v[4] := a3[0]; v[5] := s3; v[6] := a3[1]; v[7] := s3b; v[8] := a4[0]; v[9] := s4;
v[10] := ULINT_TO_LINT(a5[0] / 2); v[11] := ULINT_TO_LINT(s5 / 2); v[12] := a6[0]; v[13] := s6;
v[14] := WLEN(a7[0]) * 10 + WLEN(s7); v[15] := BOOL_TO_INT(a7[0] = s7);
v[16] := TIME_TO_LINT(a8[0]); v[17] := TIME_TO_LINT(s8); v[18] := TIME_TO_LINT(a8[2]);
v[19] := BOOL_TO_INT(a9[0] = EC) * 10 + BOOL_TO_INT(s9 = EC); v[20] := BOOL_TO_INT(a9[2] = EB);
v[21] := BOOL_TO_INT(a10[0]) * 100 + BOOL_TO_INT(a10[1]) * 10 + BOOL_TO_INT(a10[2]); v[22] := BOOL_TO_INT(s10) * 10 + BOOL_TO_INT(s10b);
v[23] := a11[0].x * 10 + a11[0].y; v[24] := a11[1].x * 10 + a11[1].y; v[25] := s11.x * 10 + s11.y;
v[26] := a12[0] * 100 + a12[1] * 10 + a12[2]; v[27] := s12 * 10 + s12b;
END_PROGRAM
`,
      'p.V[0] << " " << p.V[1] << " " << p.V[2] << " " << p.V[3] << " " << p.V[4] << " " << p.V[5] << " " << p.V[6] << " " << p.V[7] << " " << p.V[8] << " " << p.V[9] << " " << p.V[10] << " " << p.V[11] << " " << p.V[12] << " " << p.V[13] << " " << p.V[14] << " " << p.V[15] << " " << p.V[16] << " " << p.V[17] << " " << p.V[18] << " " << p.V[19] << " " << p.V[20] << " " << p.V[21] << " " << p.V[22] << " " << p.V[23] << " " << p.V[24] << " " << p.V[25] << " " << p.V[26] << " " << p.V[27]',
      "argchecks_fill_like_assignment",
    );
    expect(stdout).toBe(
      "221 1 -56 -56 44 44 255 255 2 2 9223372036854775807 9223372036854775807 4294967295 4294967295 33 1 5 5 1000 11 1 11 1 16 58 58 489 48",
    );
  });

  it("compiles a partial initializer of 2000 values quickly", () => {
    const values = Array.from({ length: 2000 }, (_, i) => i + 1).join(",");
    const started = Date.now();
    const { stdout } = run(
      `TYPE AI : INT := 9; END_TYPE
PROGRAM Main
VAR a : ARRAY[0..2009] OF AI := [${values}]; END_VAR
END_PROGRAM
`,
      'p.A[0] << " " << p.A[1999] << " " << p.A[2000] << " " << p.A[2009]',
      "argchecks_fill_2000",
    );
    expect(stdout).toBe("1 2000 9 9");
    // A recursive template took minutes and gigabytes here
    expect(Date.now() - started).toBeLessThan(30000);
  });
});
