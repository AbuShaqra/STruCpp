/**
 * Invoking a function block instance through a member chain of any depth
 * (`a.h.sub(k := 3)`) is accepted and binds its arguments; a member that is
 * not a function block instance is still refused.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const DECLS = `
  FUNCTION_BLOCK FBS
  VAR_INPUT k : INT; END_VAR
  VAR_OUTPUT o : INT; END_VAR
    o := o + k;
  END_FUNCTION_BLOCK
  TYPE ST : STRUCT f : FBS; n : INT; END_STRUCT END_TYPE
  FUNCTION_BLOCK FBH
  VAR PUBLIC sub : FBS; s : ST; arr : ARRAY[0..1] OF ST; END_VAR
  END_FUNCTION_BLOCK
  FUNCTION_BLOCK FBT
  VAR PUBLIC h : FBH; END_VAR
  METHOD Run
    THIS.h.sub(k := 1);
  END_METHOD
  END_FUNCTION_BLOCK
`;

function compileMain(stmts: string): ReturnType<typeof compile> {
  return compile(
    `${DECLS}
    PROGRAM Main
    VAR a : FBT; i : INT; END_VAR
      ${stmts}
    END_PROGRAM`,
    { headerFileName: "generated.hpp" },
  );
}

describe("function block call through a member chain", () => {
  it("binds the arguments at any depth", () => {
    const r = compileMain(
      "a.h.sub(k := 3); a.h.s.f(4); a.h.arr[i].f(k := 5); a.h.sub();",
    );
    expect(r.errors).toEqual([]);
    expect(r.cppCode).toContain("A.H.SUB.K = 3;\n    A.H.SUB();");
    expect(r.cppCode).toContain("A.H.S.F.K = 4;\n    A.H.S.F();");
    expect(r.cppCode).toContain("A.H.ARR.at(I).F.K = 5;");
    expect(r.cppCode).toContain("this->H.SUB.K = 1;\n    this->H.SUB();");
  });

  it("still refuses a member that is not a function block instance", () => {
    const r = compileMain("a.h.s.n();");
    expect(r.errors.map((e) => e.message)).toEqual([
      "'A.H.S.N' is a member that is not a function block instance, not a method",
    ]);
  });
});
