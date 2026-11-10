/**
 * A name an initial value uses that nothing declares (`x : INT := zz;`) is
 * reported, inside structure initializers and array literals too; constants,
 * enum values, other variables and sibling STRUCT fields stay accepted.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";

function errorsIn(source: string, dialect?: "iec-3"): string[] {
  return compile(source, {
    libraries: discoverStlibs("libs"),
    features: ["+struct_extends"],
    ...(dialect ? { dialect } : {}),
  }).errors.map((e) => e.message);
}

const DECLS = `
  TYPE ST_P : STRUCT a : INT; b : INT; END_STRUCT END_TYPE
  TYPE E1 : (ALPHA, BETA); END_TYPE
  VAR_GLOBAL CONSTANT GC : INT := 4; END_VAR
`;

describe("undeclared name in an initial value", () => {
  it("refuses in every declaring scope", () => {
    expect(
      errorsIn(`${DECLS}
      VAR_GLOBAL g : INT := zz1; END_VAR
      FUNCTION F : INT
      VAR v : INT := zz2; END_VAR
        F := v;
      END_FUNCTION
      FUNCTION_BLOCK FB
      VAR_INPUT i : INT := zz3; END_VAR
      METHOD M : INT
      VAR mv : INT := zz4; END_VAR
        M := mv;
      END_METHOD
      END_FUNCTION_BLOCK
      TYPE ST_F : STRUCT f : INT := zz5; END_STRUCT END_TYPE
      PROGRAM Main
      VAR x : INT := zz6 + 1; END_VAR
      END_PROGRAM`).sort(),
    ).toEqual([1, 2, 3, 4, 5, 6].map((n) => `Undeclared variable 'ZZ${n}'`));
  });

  it("refuses inside structure initializers and array literals", () => {
    expect(
      errorsIn(`${DECLS}
      PROGRAM Main
      VAR s : ST_P := (a := zz1); arr : ARRAY[0..1] OF INT := [1, zz2];
        sa : ARRAY[0..1] OF ST_P := [(b := zz3), (a := 1)]; END_VAR
      END_PROGRAM`),
    ).toEqual([1, 2, 3].map((n) => `Undeclared variable 'ZZ${n}'`));
  });

  it("refuses under iec-3 too", () => {
    expect(
      errorsIn(
        `PROGRAM Main
        VAR x : INT := zz; END_VAR
        END_PROGRAM`,
        "iec-3",
      ),
    ).toEqual(["Undeclared variable 'ZZ'"]);
  });

  it("accepts constants, enum values, variables and sibling fields", () => {
    expect(
      errorsIn(`${DECLS}
      TYPE ST_S : STRUCT a : INT := 3; b : INT := a; END_STRUCT END_TYPE
      TYPE ST_SD EXTENDS ST_S : STRUCT c : INT := b; END_STRUCT END_TYPE
      FUNCTION_BLOCK FB
      VAR_INPUT i : INT := GC; END_VAR
      VAR CONSTANT K : INT := 2; END_VAR
      VAR j : INT := K + i; END_VAR
      END_FUNCTION_BLOCK
      PROGRAM Main
      VAR CONSTANT C : INT := 3; END_VAR
      VAR x : INT := C * GC; y : INT := x; e : E1 := BETA; e2 : E1 := E1#ALPHA;
        s : ST_P := (a := C, b := GC); t : TIME := T#1S; r : REAL := ABS(-1.5);
        n : INT := SIZEOF(x); END_VAR
      END_PROGRAM`),
    ).toEqual([]);
  });
});

describe("member of several enumerations settled by its target", () => {
  const ENUMS = `
    TYPE MODE1 : (A, B); END_TYPE
    TYPE MODE2 : (B, C); END_TYPE
    TYPE T1 : MODE1; END_TYPE
    TYPE ST : STRUCT f : MODE2 := B; END_STRUCT END_TYPE`;

  it("accepts it where the target is one of its enumerations", () => {
    const result = compile(
      `${ENUMS}
      PROGRAM Main
      VAR e : MODE1 := B; t : T1 := B; s : ST := (f := B);
        arr : ARRAY[0..1] OF MODE2 := [C, B]; e3 : MODE2; END_VAR
        e3 := B;
      END_PROGRAM`,
    );
    expect(result.errors.map((e) => e.message)).toEqual([]);
    expect(result.cppCode).toContain("E(MODE1::B)");
    expect(result.cppCode).toContain("T(MODE1::B)");
    expect(result.cppCode).toContain("MODE2::C, MODE2::B");
    expect(result.cppCode).toContain("E3 = MODE2::B;");
    expect(result.cppCode).toContain("v0.F = MODE2::B;");
    expect(result.headerCode).toContain("F = MODE2::B;");
  });

  it("still refuses it where the target does not settle it", () => {
    expect(
      errorsIn(`${ENUMS}
      PROGRAM Main
      VAR x : INT := B; y : INT; END_VAR
        y := B;
      END_PROGRAM`),
    ).toEqual([
      "Ambiguous enum member 'B' — qualify as 'MODE1' or 'MODE2'",
      "Ambiguous enum member 'B' — qualify as 'MODE1' or 'MODE2'",
    ]);
  });
});
