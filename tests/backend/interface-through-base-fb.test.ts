/**
 * An FB that implements an interface only through methods and properties of
 * a base FB gets overrides that call the base's; one whose base already
 * implements the interface, or that declares the member itself, gets none.
 * A method an interface inherits through EXTENDS must be provided.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const IFACES = `
  INTERFACE I_A
  METHOD Get : INT
  VAR_INPUT k : INT; END_VAR
  END_METHOD
  PROPERTY Q : INT
  GET
  END_GET
  END_PROPERTY
  END_INTERFACE
  INTERFACE I_B EXTENDS I_A
  METHOD Put
  VAR_INPUT v : INT; END_VAR
  END_METHOD
  END_INTERFACE
  FUNCTION_BLOCK FBBase
  VAR x : INT; END_VAR
  METHOD Get : INT
  VAR_INPUT k : INT; END_VAR
    Get := x + k;
  END_METHOD
  PROPERTY Q : INT
  GET
    Q := x;
  END_GET
  END_PROPERTY
  END_FUNCTION_BLOCK
`;

function compileWith(src: string): ReturnType<typeof compile> {
  return compile(`${IFACES}${src}`, {
    headerFileName: "generated.hpp",
    features: ["+property"],
  });
}

describe("interface implemented through a base FB", () => {
  it("overrides the inherited members in the implementing FB", () => {
    const r = compileWith(`
      FUNCTION_BLOCK FBMid EXTENDS FBBase END_FUNCTION_BLOCK
      FUNCTION_BLOCK FBE EXTENDS FBMid IMPLEMENTS I_B
      METHOD Put
      VAR_INPUT v : INT; END_VAR
        x := v;
      END_METHOD
      END_FUNCTION_BLOCK`);
    expect(r.errors).toEqual([]);
    expect(r.headerCode).toContain(
      "IEC_INT GET(IEC_INT K) override { return FBBASE::GET(K); }",
    );
    expect(r.headerCode).toContain(
      "IEC_INT get_Q() const override { return FBBASE::get_Q(); }",
    );
    expect(r.headerCode).not.toContain("PUT(IEC_INT V) override");
  });

  it("adds nothing when the base already implements the interface", () => {
    const r = compileWith(`
      FUNCTION_BLOCK FBImpl EXTENDS FBBase IMPLEMENTS I_A END_FUNCTION_BLOCK
      FUNCTION_BLOCK FBD EXTENDS FBImpl IMPLEMENTS I_A END_FUNCTION_BLOCK`);
    expect(r.errors).toEqual([]);
    // FBImpl needs them; FBD inherits FBImpl's overrides.
    expect(
      r.headerCode.split("override { return FBBASE::GET(K); }"),
    ).toHaveLength(2);
  });

  it("reports a method inherited through the interface's EXTENDS", () => {
    const r = compileWith(`
      FUNCTION_BLOCK FBX IMPLEMENTS I_B
      METHOD Put
      VAR_INPUT v : INT; END_VAR
      END_METHOD
      PROPERTY Q : INT
      GET
        Q := 1;
      END_GET
      END_PROPERTY
      END_FUNCTION_BLOCK`);
    expect(r.errors.map((e) => e.message)).toEqual([
      "FUNCTION_BLOCK 'FBX' implements 'I_B' but does not provide method 'GET'.",
    ]);
  });
});
