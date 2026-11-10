/**
 * An element a structure initializer names that its STRUCT or function block
 * does not have (`s : ST_P := (zz := 1)`) is reported, at any depth and in
 * every place a declaration carries one; library types are not checked.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";

const DECLS = `
  TYPE ST_P : STRUCT a : INT; b : INT; END_STRUCT END_TYPE
  TYPE ST_Q : STRUCT p : ST_P; arr : ARRAY[0..1] OF ST_P; END_STRUCT END_TYPE
  TYPE ST_D EXTENDS ST_P : STRUCT d : INT; END_STRUCT END_TYPE
  TYPE T_P : ST_P; END_TYPE
  TYPE T_ARR : ARRAY[0..1] OF ST_P; END_TYPE
  FUNCTION_BLOCK FB_A
  VAR_INPUT i : INT; END_VAR
  VAR_OUTPUT o : INT; END_VAR
  END_FUNCTION_BLOCK
  FUNCTION_BLOCK FB_B EXTENDS FB_A
  END_FUNCTION_BLOCK
`;

function errorsIn(vars: string, extra = "", dialect?: "iec-3"): string[] {
  return compile(
    `${DECLS}
    ${extra}
    PROGRAM Main
    VAR ${vars} END_VAR
    END_PROGRAM`,
    {
      libraries: discoverStlibs("libs"),
      features: ["+struct_extends"],
      ...(dialect ? { dialect } : {}),
    },
  ).errors.map((e) => e.message);
}

describe("unknown element in a structure initializer", () => {
  it("refuses an element the STRUCT does not have, at any depth", () => {
    expect(
      errorsIn(
        `s : ST_P := (a := 1, zz := 1);
        q : ST_Q := (p := (yy := 2));
        q2 : ST_Q := (arr := [(a := 1), (xx := 3)]);
        d : ST_D := (d := 1, ww := 4);
        t : T_P := (vv := 5);
        ar : ARRAY[0..1] OF ST_P := [(uu := 6), (a := 1)];
        ta : T_ARR := [(tt := 7)];`,
      ),
    ).toEqual([
      "STRUCT 'ST_P' has no member 'ZZ'",
      "STRUCT 'ST_P' has no member 'YY'",
      "STRUCT 'ST_P' has no member 'XX'",
      "STRUCT 'ST_D' has no member 'WW'",
      "STRUCT 'ST_P' has no member 'VV'",
      "STRUCT 'ST_P' has no member 'UU'",
      "STRUCT 'ST_P' has no member 'TT'",
    ]);
  });

  it("refuses an element a function block does not have", () => {
    expect(errorsIn("f : FB_A := (zz := 1); g : FB_B := (yy := 2);")).toEqual([
      "Function block 'FB_A' has no member 'ZZ'",
      "Function block 'FB_B' has no member 'YY'",
    ]);
  });

  it("refuses in globals and STRUCT field defaults, not type defaults", () => {
    expect(
      errorsIn(
        "x : INT;",
        `VAR_GLOBAL g : ST_P := (zz := 1); END_VAR
        TYPE ST_F : STRUCT p : ST_P := (yy := 2); END_STRUCT END_TYPE
        TYPE T_DEF : ST_P := (xx := 3); END_TYPE`,
      ).sort(),
    ).toEqual([
      "STRUCT 'ST_P' has no member 'YY'",
      "STRUCT 'ST_P' has no member 'ZZ'",
    ]);
  });

  it("refuses under iec-3 too", () => {
    expect(errorsIn("s : ST_P := (zz := 1);", "", "iec-3")).toEqual([
      "STRUCT 'ST_P' has no member 'ZZ'",
    ]);
  });

  it("accepts known elements, inherited ones and library blocks", () => {
    expect(
      errorsIn(
        `s : ST_P := (a := 1, b := 2);
        q : ST_Q := (p := (a := 1), arr := [(b := 2), (a := 3)]);
        d : ST_D := (a := 1, d := 2);
        t : T_P := (b := 5);
        f : FB_B := (i := 1);
        tn : TON := (PT := T#1S);`,
      ),
    ).toEqual([]);
  });
});
