/**
 * A PROPERTY declared in a base function block is read and written through
 * its accessors on a derived instance, through THIS and SUPER, and along a
 * member chain; a variable of the derived FB of the same name stays a variable.
 * A bare property name inside the block (own or inherited) is the property.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const BASE = `
  FUNCTION_BLOCK FBA
  VAR _p : INT := 3; END_VAR
  PROPERTY P : INT
  GET
    P := _p;
  END_GET
  SET
    _p := P;
  END_SET
  END_PROPERTY
  END_FUNCTION_BLOCK
`;

function cpp(src: string, features?: string[]): string {
  const r = compile(src, {
    headerFileName: "generated.hpp",
    ...(features ? { features } : {}),
  });
  expect(r.errors).toEqual([]);
  return r.cppCode;
}

describe("PROPERTY inherited from a base FB", () => {
  it("reads and writes it on a derived instance and a member chain", () => {
    const code = cpp(`${BASE}
      FUNCTION_BLOCK FBB EXTENDS FBA END_FUNCTION_BLOCK
      FUNCTION_BLOCK FBC EXTENDS FBB END_FUNCTION_BLOCK
      FUNCTION_BLOCK FBH VAR PUBLIC c : FBC; END_VAR END_FUNCTION_BLOCK
      PROGRAM Main
      VAR b : FBB; h : FBH; x : INT; END_VAR
        x := b.P;
        b.P := 7;
        h.c.P := x;
      END_PROGRAM`);
    expect(code).toContain("X = B.get_P();");
    expect(code).toContain("B.set_P(7);");
    expect(code).toContain("H.C.set_P(X);");
  });

  it("reaches it through THIS, THIS^ and SUPER^ in a derived FB", () => {
    const code = cpp(
      `${BASE}
      FUNCTION_BLOCK FBB EXTENDS FBA
      METHOD M : INT
        THIS^.P := SUPER^.P + THIS.P;
        M := THIS^.P;
      END_METHOD
      END_FUNCTION_BLOCK`,
      ["+self_caret"],
    );
    expect(code).toContain("this->set_P(FBA::get_P() + this->get_P());");
    expect(code).toContain("M_result = this->get_P();");
  });

  it("keeps a derived FB's variable of the same name a variable", () => {
    const code = cpp(`${BASE}
      FUNCTION_BLOCK FBB EXTENDS FBA VAR PUBLIC p : INT; END_VAR END_FUNCTION_BLOCK
      PROGRAM Main
      VAR b : FBB; x : INT; END_VAR
        x := b.p;
      END_PROGRAM`);
    expect(code).toContain("X = B.P;");
  });

  it("reads and writes a bare property name, own or inherited", () => {
    const code = cpp(`${BASE}
      FUNCTION_BLOCK FBB EXTENDS FBA
      VAR_OUTPUT o : INT; END_VAR
      PROPERTY Q : INT
      GET
        Q := P * 2;
      END_GET
      SET
        P := Q + 100;
      END_SET
      END_PROPERTY
      METHOD M : INT
        P := P + 1;
        M := Q;
      END_METHOD
        o := P;
      END_FUNCTION_BLOCK`);
    expect(code).toContain("this->set_P(this->get_P() + 1);");
    expect(code).toContain("M_result = this->get_Q();");
    expect(code).toContain("O = this->get_P();");
    expect(code).toContain("Q_result = this->get_P() * 2;");
    expect(code).toContain("this->set_P(Q + 100);");
    // The base's own accessors keep their result and value parameter.
    expect(code).toContain("P_result = _P;");
    expect(code).toContain("_P = P;");
  });

  it("lets a local of the same name shadow the property", () => {
    const code = cpp(`${BASE}
      FUNCTION_BLOCK FBB EXTENDS FBA
      METHOD M : INT
      VAR P : INT := 9; END_VAR
        M := P;
      END_METHOD
      END_FUNCTION_BLOCK`);
    expect(code).toContain("M_result = P;");
  });

  it("still reports a bare name that is no property", () => {
    const r = compile(`${BASE}
      FUNCTION_BLOCK FBB EXTENDS FBA
      METHOD M : INT
        M := Nope;
      END_METHOD
      END_FUNCTION_BLOCK`);
    expect(r.errors.map((e) => e.message)).toContain(
      "Undeclared variable 'NOPE'",
    );
  });
});
