/**
 * An argument of one plain STRUCT type bound to a VAR_INPUT or VAR_IN_OUT of
 * another is reported, for function, function block and method calls; an
 * alias of the same STRUCT and library types stay accepted.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const DECLS = `
  TYPE ST_A : STRUCT a : INT; END_STRUCT END_TYPE
  TYPE ST_B : STRUCT a : INT; END_STRUCT END_TYPE
  TYPE T_A : ST_A; END_TYPE
  FUNCTION F : INT
  VAR_INPUT p : ST_A; END_VAR
    F := p.a;
  END_FUNCTION
  FUNCTION G : INT
  VAR_IN_OUT p : T_A; END_VAR
    G := p.a;
  END_FUNCTION
  FUNCTION_BLOCK FB
  VAR_INPUT p : ST_A; END_VAR
  VAR_IN_OUT q : ST_A; END_VAR
  METHOD M : INT
  VAR_INPUT p2 : ST_A; END_VAR
    M := p2.a;
  END_METHOD
  END_FUNCTION_BLOCK
`;

function errorsIn(body: string, dialect?: "iec-3"): string[] {
  return compile(
    `${DECLS}
    PROGRAM Main
    VAR a : ST_A; b : ST_B; ta : T_A; r : INT; f1 : FB; END_VAR
      ${body}
    END_PROGRAM`,
    dialect ? { dialect } : {},
  ).errors.map((e) => e.message);
}

describe("argument of an unrelated plain STRUCT", () => {
  it("refuses it for inputs and in-outs of every call form", () => {
    expect(
      errorsIn(
        "r := F(b); r := F(p := b); r := G(b); f1(p := b, q := a); f1(p := a, q := b); r := f1.M(b);",
      ),
    ).toEqual([
      "Cannot assign ST_B to parameter 'P' of type ST_A",
      "Cannot assign ST_B to parameter 'P' of type ST_A",
      "Cannot assign ST_B to parameter 'P' of type T_A",
      "Cannot assign ST_B to parameter 'P' of type ST_A",
      "Cannot assign ST_B to parameter 'Q' of type ST_A",
      "Cannot assign ST_B to parameter 'P2' of type ST_A",
    ]);
  });

  it("refuses under iec-3 too", () => {
    expect(errorsIn("r := F(b);", "iec-3")).toEqual([
      "Cannot assign ST_B to parameter 'P' of type ST_A",
    ]);
  });

  it("accepts the same STRUCT through an alias", () => {
    expect(
      errorsIn(
        "r := F(ta); r := G(a); r := G(ta); f1(p := ta, q := ta); r := f1.M(ta);",
      ),
    ).toEqual([]);
  });
});
