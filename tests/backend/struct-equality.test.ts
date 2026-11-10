/**
 * STRUCT `=` / `<>` compare field by field (nested STRUCTs field by field,
 * ARRAY members element by element), each operand evaluated once; other
 * comparisons are unchanged.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

function body(decls: string, vars: string, stmts: string): string {
  const r = compile(
    `${decls}
    PROGRAM Main
    VAR ${vars} END_VAR
      ${stmts}
    END_PROGRAM`,
    { headerFileName: "generated.hpp" },
  );
  expect(r.errors).toEqual([]);
  const m = /void Program_MAIN::run\(\) \{\n([\s\S]*?)\n\}/.exec(r.cppCode);
  return m?.[1] ?? "";
}

const DECLS = `
  TYPE IN1 : STRUCT k : INT; END_STRUCT END_TYPE
  TYPE ST : STRUCT a : INT; i : IN1; arr : ARRAY[1..2] OF IN1; END_STRUCT END_TYPE
  TYPE T_ST : ST; END_TYPE
`;

describe("STRUCT equality", () => {
  it("compares field by field, nested and array members included", () => {
    const b = body(DECLS, "x : ST; y : T_ST; e : BOOL;", "e := x = y;");
    expect(b).toContain(
      "E = [&](const auto& __l, const auto& __r) { return ((__l.A == __r.A) && ((__l.I.K == __r.I.K)) && " +
        "::strucpp::iec_equal_each(__l.ARR, __r.ARR, [&](const auto& __x0, const auto& __y0) { return ((__x0.K == __y0.K)); })); }(X, Y);",
    );
  });

  it("negates for <>", () => {
    const b = body(DECLS, "x : ST; y : ST; e : BOOL;", "e := x <> y;");
    expect(b).toContain("E = ![&](const auto& __l");
  });

  it("leaves elementary comparisons alone", () => {
    const b = body(DECLS, "x : ST; e : BOOL;", "e := x.a = x.i.k;");
    expect(b).toContain("E = X.A == X.I.K;");
  });
});
