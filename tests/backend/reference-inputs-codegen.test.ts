/**
 * A REFERENCE TO input is bound to its argument at the call: the argument is
 * wrapped in `ref_bind(...)`, so an FB input is rebound (not written through)
 * and a function or method parameter is constructed bound. An omitted one is
 * passed unbound. Other inputs are emitted as before.
 */

import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const DECLS = `
FUNCTION_BLOCK FB_R
VAR_INPUT r : REFERENCE TO INT; k : INT; END_VAR
  r := r + k;
END_FUNCTION_BLOCK
FUNCTION F_R : INT
VAR_INPUT k : INT; r : REFERENCE TO INT; END_VAR
  F_R := r + k;
END_FUNCTION
FUNCTION_BLOCK FB_M
METHOD M : INT
VAR_INPUT r : REFERENCE TO INT; k : INT; END_VAR
  M := r + k;
END_METHOD
METHOD Own : INT
VAR_INPUT r : REFERENCE TO INT; END_VAR
  Own := M(r, 1);
END_METHOD
END_FUNCTION_BLOCK
`;

function cppFor(body: string): string {
  const result = compile(`${DECLS}PROGRAM MAIN
VAR f : FB_R; m : FB_M; n : INT; a : INT; arr : ARRAY[1..2] OF INT; END_VAR
${body}
END_PROGRAM
`);
  expect(result.errors).toEqual([]);
  return result.cppCode;
}

describe("REFERENCE TO inputs are bound at the call", () => {
  it("an FB input is rebound to the argument, named or positional", () => {
    const cpp = cppFor("f(r := n, k := 1);\nf(arr[2], 3);");
    expect(cpp).toContain("F.R = ref_bind(N);");
    expect(cpp).toContain("F.K = 1;");
    expect(cpp).toContain("F.R = ref_bind(ARR.at(2));");
    expect(cpp).toContain("F.K = 3;");
  });

  it("an omitted FB input keeps its binding (no assignment)", () => {
    const cpp = cppFor("f(k := 2);");
    expect(cpp).not.toContain("F.R =");
  });

  it("a function argument is bound, named or positional", () => {
    const cpp = cppFor("a := F_R(r := n, k := 1);\na := F_R(2, n);");
    expect(cpp).toContain("A = F_R(1, ref_bind(N));");
    expect(cpp).toContain("A = F_R(2, ref_bind(N));");
  });

  it("a method argument is bound, named or positional, and an omitted one is unbound", () => {
    const cpp = cppFor(
      "a := m.M(r := n, k := 1);\na := m.M(n, 2);\na := m.M(k := 3);",
    );
    expect(cpp).toContain("A = M.M(ref_bind(N), 1);");
    expect(cpp).toContain("A = M.M(ref_bind(N), 2);");
    expect(cpp).toContain("A = M.M(IEC_REFERENCE_TO<INT_t>(), 3);");
  });

  it("a bare call of an own method binds a positional argument", () => {
    const cpp = cppFor("a := m.Own(n);");
    expect(cpp).toContain("M(ref_bind(R), 1)");
  });

  it("inputs that are not REFERENCE TO are emitted unchanged", () => {
    const result = compile(`FUNCTION_BLOCK FB_V
VAR_INPUT v : INT; END_VAR
END_FUNCTION_BLOCK
FUNCTION F_V : INT
VAR_INPUT v : INT; END_VAR
  F_V := v;
END_FUNCTION
PROGRAM MAIN
VAR f : FB_V; n : INT; a : INT; END_VAR
  f(v := n);
  a := F_V(n);
END_PROGRAM
`);
    expect(result.errors).toEqual([]);
    expect(result.cppCode).toContain("F.V = N;");
    expect(result.cppCode).toContain("A = F_V(N);");
    expect(result.cppCode).not.toContain("ref_bind");
  });
});
