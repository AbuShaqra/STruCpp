/**
 * Method and function block calls through a REFERENCE TO (`rr.M()`,
 * `rr(v := 2)`), a REF_TO and a POINTER TO (`p^.M()`, `pf^(v := 4)`): they
 * parse, pass analysis and call the object referred to.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

function body(stmts: string): string {
  const r = compile(
    `
    FUNCTION_BLOCK FBM
    VAR_INPUT v : INT; END_VAR
    VAR_OUTPUT o : INT; END_VAR
    METHOD M : INT
    VAR_INPUT k : INT; END_VAR
      M := k;
    END_METHOD
    END_FUNCTION_BLOCK
    PROGRAM Main
    VAR f : FBM; rr : REFERENCE TO FBM; q : REF_TO FBM; p : POINTER TO FBM;
      x : INT; END_VAR
      ${stmts}
    END_PROGRAM`,
    { headerFileName: "generated.hpp" },
  );
  expect(r.errors).toEqual([]);
  const m = /void Program_MAIN::run\(\) \{\n([\s\S]*?)\n\}/.exec(r.cppCode);
  return m?.[1] ?? "";
}

describe("calls through a reference or pointer", () => {
  it("calls a method through REFERENCE TO, REF_TO and POINTER TO", () => {
    const b = body(`x := rr.M(1); x := q^.M(2); p^.M(k := 3); x := p^.M(4);`);
    expect(b).toContain("X = RR.target().M(1);");
    expect(b).toContain("X = (*Q).M(2);");
    expect(b).toContain("(*P).M(3);");
    expect(b).toContain("X = (*P).M(4);");
  });

  it("invokes the function block a reference or pointer refers to", () => {
    const b = body(`rr(v := 2); q^(v := 3); p^(4); x := p^.o;`);
    expect(b).toContain("RR.target().V = 2;");
    expect(b).toContain("RR.target()();");
    expect(b).toContain("(*Q).V = 3;");
    expect(b).toContain("(*Q)();");
    expect(b).toContain("(*P).V = 4;");
    expect(b).toContain("(*P)();");
  });
});
