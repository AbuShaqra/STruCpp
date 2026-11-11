/**
 * A member a fully known type does not have (`s.zz`, `mid.nothing`,
 * `fb.nothing`, `x.zz`) and an array assigned to or from a single value are
 * reported; types with members not known here are not checked.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";

const DECLS = `
  TYPE ST_I : STRUCT a : INT; arr : ARRAY[0..2] OF INT; END_STRUCT END_TYPE
  TYPE ST_O : STRUCT mid : ST_I; END_STRUCT END_TYPE
  TYPE ST_D EXTENDS ST_I : STRUCT d : INT; END_STRUCT END_TYPE
  TYPE T_A : ARRAY[0..2] OF INT; END_TYPE
  TYPE T_I : INT; END_TYPE
  TYPE T_S : ST_I; END_TYPE
  FUNCTION_BLOCK FB_A
  VAR_OUTPUT o : INT; END_VAR
  VAR PUBLIC sub : ST_I; END_VAR
  METHOD M : INT
    M := 1;
  END_METHOD
  PROPERTY P : INT
  GET
    P := o;
  END_GET
  END_PROPERTY
  END_FUNCTION_BLOCK
  FUNCTION_BLOCK FB_B EXTENDS FB_A
  END_FUNCTION_BLOCK
`;

function errorsIn(body: string, dialect?: "iec-3"): string[] {
  return compile(
    `${DECLS}
    PROGRAM Main
    VAR x : INT; b : BOOL; s : ST_I; o : ST_O; mid : ST_I; d : ST_D; fb : FB_A;
      fbb : FB_B; arr2 : ARRAY[0..2] OF INT; ta : T_A; str : STRING; ti : T_I;
      tn : TON; ts : T_S; END_VAR
      ${body}
    END_PROGRAM`,
    {
      libraries: discoverStlibs("libs"),
      features: ["+struct_extends"],
      ...(dialect ? { dialect } : {}),
    },
  ).errors.map((e) => e.message);
}

describe("unknown member in an access chain", () => {
  it("refuses a member a STRUCT does not have, read or written", () => {
    expect(
      errorsIn(
        "x := mid.nothing; s.zz := 1; x := o.mid.nothing; o.mid.zz := 1; x := d.zz; x := ts.zz;",
      ),
    ).toEqual([
      "STRUCT 'ST_I' has no member 'NOTHING'",
      "STRUCT 'ST_I' has no member 'ZZ'",
      "STRUCT 'ST_I' has no member 'NOTHING'",
      "STRUCT 'ST_I' has no member 'ZZ'",
      "STRUCT 'ST_D' has no member 'ZZ'",
      "STRUCT 'ST_I' has no member 'ZZ'",
    ]);
  });

  it("refuses a member a function block or a value does not have", () => {
    expect(
      errorsIn(
        "x := fb.nothing; fb.zz := 1; x := fbb.zz; x := fb.sub.zz; b := x.zz; x := str.zz; x := arr2[0].zz; b := ti.zz;",
      ),
    ).toEqual([
      "Function block 'FB_A' has no member 'NOTHING'",
      "Function block 'FB_A' has no member 'ZZ'",
      "Function block 'FB_B' has no member 'ZZ'",
      "STRUCT 'ST_I' has no member 'ZZ'",
      "A value of type 'INT' has no member 'ZZ'",
      "A value of type 'STRING' has no member 'ZZ'",
      "A value of type 'INT' has no member 'ZZ'",
      "A value of type 'INT' has no member 'ZZ'",
    ]);
  });

  it("refuses under iec-3 too", () => {
    expect(errorsIn("x := mid.nothing;", "iec-3")).toEqual([
      "STRUCT 'ST_I' has no member 'NOTHING'",
    ]);
  });

  it("accepts known members, bits, properties and library blocks", () => {
    expect(
      errorsIn(
        "x := mid.a; x := o.mid.arr[1]; x := d.a; x := fbb.o; x := fb.P; b := x.3; b := tn.Q; x := fb.sub.a; b := fb.ENO; x := ts.a;",
      ),
    ).toEqual([]);
  });

  it("leaves a bit selected by a named constant alone", () => {
    expect(
      compile(
        `VAR_GLOBAL CONSTANT GC : INT := 2; END_VAR
        PROGRAM Main
        VAR CONSTANT C3 : INT := 3; END_VAR
        VAR w : WORD; b : BOOL; END_VAR
          b := w.C3; b := w.GC;
        END_PROGRAM`,
      ).errors.map((e) => e.message),
    ).toEqual([]);
  });
});

describe("array assigned to or from a single value", () => {
  it("refuses either direction", () => {
    expect(
      errorsIn(
        "x := s.arr; x := o.mid.arr; x := arr2; x := ta; arr2 := x; ta := x; arr2 := 1; str := arr2;",
      ),
    ).toEqual([
      ...Array<string>(4).fill("Cannot assign an array to a single value"),
      ...Array<string>(3).fill("Cannot assign a single value to an array"),
      "Cannot assign an array to a single value",
    ]);
  });

  it("accepts arrays of the same shape, elements and pointers", () => {
    expect(errorsIn("arr2 := ta; ta := s.arr; x := arr2[1];")).toEqual([]);
    expect(
      compile(
        `PROGRAM Main
        VAR p : POINTER TO ARRAY[0..3] OF BYTE; d : DWORD; END_VAR
          p := ADR(d); d := p^[0];
        END_PROGRAM`,
      ).errors,
    ).toEqual([]);
  });
});
