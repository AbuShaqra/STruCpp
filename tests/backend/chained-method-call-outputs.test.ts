/**
 * A method call whose receiver is itself a method call (`fb.Me().M()`,
 * `F().Me().M()`, through an interface result too) resolves the method on the
 * receiving call's declared result, so its unbound VAR_OUTPUT gets a temporary.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const SOURCE = `INTERFACE I_M
METHOD M : INT
VAR_INPUT a : INT; END_VAR
VAR_OUTPUT o : INT; END_VAR
END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB IMPLEMENTS I_M
METHOD M : INT
VAR_INPUT a : INT; END_VAR
VAR_OUTPUT o : INT; END_VAR
M := a; o := a;
END_METHOD
METHOD Me : FB
Me := THIS^;
END_METHOD
METHOD Itf : I_M
Itf := THIS^;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION FF : FB
END_FUNCTION
PROGRAM P
VAR fb : FB; y, x, z, w, q : INT; END_VAR
y := fb.Me().M(5);
x := FF().Me().M(6);
z := fb.Itf().M(7);
w := fb.Me().Itf().M(a := 8, o => q);
END_PROGRAM
`;

describe("chained method call outputs", () => {
  it("binds an unbound VAR_OUTPUT of a method called on a method result", () => {
    const r = compile(SOURCE, { headerFileName: "g.hpp" });
    expect(r.errors).toEqual([]);
    expect(r.cppCode).toMatch(/Y = FB_\.ME\(\)\.M\(5, __output_tmp_\d+\);/);
    expect(r.cppCode).toMatch(/X = FF\(\)\.ME\(\)\.M\(6, __output_tmp_\d+\);/);
  });

  it("calls through an interface result as through an interface variable", () => {
    const r = compile(SOURCE, { headerFileName: "g.hpp" });
    expect(r.cppCode).toMatch(
      /Z = itf_ref\(FB_\.ITF\(\)\)\.M\(7, __output_tmp_\d+\);/,
    );
    expect(r.cppCode).toContain("W = itf_ref(FB_.ME().ITF()).M(8, Q);");
  });
});
