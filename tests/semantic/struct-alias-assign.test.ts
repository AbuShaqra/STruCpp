/**
 * An alias of a STRUCT or UNION (`TYPE T_A : ST_A;`) names the same type:
 * assignment both ways, through alias chains, argument passing (VAR_INPUT,
 * VAR_IN_OUT) and initialisers accept it in every dialect. A derived STRUCT
 * (EXTENDS) stays refused as before, also behind an alias.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const TYPES = `
  TYPE ST_A : STRUCT x : INT; y : REAL; END_STRUCT END_TYPE
  TYPE T_A : ST_A; END_TYPE
  TYPE T_AA : T_A; END_TYPE
  TYPE U_A : UNION i : DINT; f : REAL; END_UNION END_TYPE
  TYPE T_U : U_A; END_TYPE
  TYPE ST_B EXTENDS ST_A : STRUCT z : INT; END_STRUCT END_TYPE
  TYPE T_B : ST_B; END_TYPE
`;

function errorsIn(body: string, dialect?: "iec-3"): string[] {
  const r = compile(
    `${TYPES}
    FUNCTION F_In : INT
    VAR_INPUT p : ST_A; END_VAR
      F_In := p.x;
    END_FUNCTION
    FUNCTION F_InOut : INT
    VAR_IN_OUT p : T_A; END_VAR
      F_InOut := p.x;
    END_FUNCTION
    FUNCTION F_U : DINT
    VAR_IN_OUT p : U_A; END_VAR
      F_U := p.i;
    END_FUNCTION
    PROGRAM Main
    VAR s : ST_A; t : T_A; tt : T_AA; u : U_A; tu : T_U; b : ST_B; tb : T_B;
      r : INT; d : DINT; END_VAR
      ${body}
    END_PROGRAM`,
    {
      ...(dialect ? { dialect } : {}),
      features: ["union", "struct_extends"],
    },
  );
  return r.errors.map((e) => e.message);
}

describe("STRUCT / UNION alias assignment", () => {
  for (const dialect of [undefined, "iec-3"] as const) {
    it(`assigns a STRUCT and its alias both ways (${dialect ?? "default"})`, () => {
      expect(errorsIn("s := t; t := s; tt := s; s := tt; t := tt;", dialect)).toEqual([]);
    });

    it(`assigns a UNION and its alias both ways (${dialect ?? "default"})`, () => {
      expect(errorsIn("u := tu; tu := u;", dialect)).toEqual([]);
    });

    it(`passes an alias to VAR_INPUT and VAR_IN_OUT of the aliased type and back (${dialect ?? "default"})`, () => {
      expect(
        errorsIn("r := F_In(t); r := F_In(tt); r := F_InOut(s); d := F_U(tu);", dialect),
      ).toEqual([]);
    });

    it(`binds a VAR_IN_OUT of one alias to a variable of another alias of the same STRUCT by reference (${dialect ?? "default"})`, () => {
      const r = compile(
        `${TYPES}
        FUNCTION F_InOut : INT
        VAR_IN_OUT p : T_A; END_VAR
          F_InOut := p.x;
        END_FUNCTION
        PROGRAM Main VAR tt : T_AA; r : INT; END_VAR
          r := F_InOut(tt);
        END_PROGRAM`,
        { ...(dialect ? { dialect } : {}), features: ["union", "struct_extends"] },
      );
      expect(r.errors.map((e) => e.message)).toEqual([]);
      expect(r.warnings.map((e) => e.message)).toEqual([]);
      expect(r.cppCode ?? "").not.toMatch(/__gio_|__io_/);
    });
  }

  it("initialises an alias variable from the aliased type's variable and vice versa", () => {
    const r = compile(`${TYPES}
      PROGRAM Main
      VAR s : ST_A; t : T_A := s; s2 : ST_A := t; END_VAR
      END_PROGRAM`, { features: ["union", "struct_extends"] });
    expect(r.errors.map((e) => e.message)).toEqual([]);
  });

  it("accepts alias-typed STRUCT fields, array elements and a TYPE default", () => {
    const r = compile(`
      TYPE ST_A : STRUCT x : INT; y : REAL; END_STRUCT END_TYPE
      TYPE T_A : ST_A := (x := 5); END_TYPE
      TYPE ST_O : STRUCT f : T_A; g : ST_A; END_STRUCT END_TYPE
      PROGRAM Main
      VAR s : ST_A; t : T_A := (x := 1, y := 2.0); o : ST_O; arr : ARRAY[0..1] OF T_A; END_VAR
        o.f := s; o.g := o.f; arr[0] := s; s := arr[1]; o.f := arr[0];
      END_PROGRAM`);
    expect(r.errors.map((e) => e.message)).toEqual([]);
  });

  it("keeps a derived STRUCT refused, directly and behind an alias", () => {
    expect(errorsIn("s := b; s := tb; t := b; tb := s; b := t;")).toEqual([
      "Cannot assign ST_B to ST_A: a structured variable is assignment-compatible only with the same type (ST_B EXTENDS ST_A)",
      "Cannot assign T_B to ST_A",
      "Cannot assign ST_B to T_A",
      "Cannot assign ST_A to T_B",
      "Cannot assign T_A to ST_B",
    ]);
  });

  it("keeps a different STRUCT refused", () => {
    const r = compile(`${TYPES}
      TYPE ST_C : STRUCT x : INT; y : REAL; END_STRUCT END_TYPE
      PROGRAM Main VAR c : ST_C; t : T_A; END_VAR
        c := t;
      END_PROGRAM`, { features: ["union", "struct_extends"] });
    expect(r.errors.map((e) => e.message)).toEqual(["Cannot assign T_A to ST_C"]);
  });
});
