/**
 * Inside a function, method or property getter named like an enumeration
 * member, the name is its return variable, not the member; elsewhere the
 * bare name stays the member.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const SOURCE = `
  TYPE E_MODE : (ALPHA, BETA, GAMMA); END_TYPE
  FUNCTION ALPHA : INT
  VAR_INPUT x : INT; END_VAR
    ALPHA := x + 1;
    ALPHA := ALPHA * 2;
  END_FUNCTION
  FUNCTION_BLOCK FB
  METHOD BETA : INT
    BETA := 7;
  END_METHOD
  PROPERTY GAMMA : INT
  GET
    GAMMA := 5;
  END_GET
  END_PROPERTY
  END_FUNCTION_BLOCK
  FUNCTION Other : E_MODE
    Other := ALPHA;
  END_FUNCTION
  PROGRAM Main
  VAR r : INT; m : E_MODE := BETA; END_VAR
    r := ALPHA(4);
  END_PROGRAM
`;

describe("return variable named like an enumeration member", () => {
  it("assigns and reads the return variable in its own body", () => {
    const result = compile(SOURCE);
    expect(result.errors).toEqual([]);
    expect(result.cppCode).toContain("ALPHA_result = X + 1;");
    expect(result.cppCode).toContain("ALPHA_result = ALPHA_result * 2;");
    expect(result.cppCode).toContain("BETA_result = 7;");
    expect(result.cppCode).toContain("GAMMA_result = 5;");
    expect(result.cppCode).not.toContain("E_MODE::ALPHA = ");
  });

  it("keeps the bare name as the member elsewhere", () => {
    const result = compile(SOURCE);
    expect(result.cppCode).toContain("OTHER_result = E_MODE::ALPHA;");
    expect(result.cppCode).toContain("M(E_MODE::BETA)");
  });
});
