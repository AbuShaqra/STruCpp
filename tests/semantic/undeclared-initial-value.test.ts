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
