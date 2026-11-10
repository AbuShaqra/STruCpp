/**
 * REF / REF= / ADR of a STRUCT or function block into REF_TO / REFERENCE TO,
 * member access through a REFERENCE TO (`rf.a`, `rr.M()`), and REF / ADR of
 * a CONFIGURATION global (its canonical storage, with a warning).
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const DECLS = `
  TYPE ST : STRUCT a : INT; b : INT; END_STRUCT END_TYPE
  FUNCTION_BLOCK FBM
  VAR_INPUT v : INT; END_VAR
  METHOD M : INT
    M := v;
  END_METHOD
  END_FUNCTION_BLOCK
`;

function run(body: string): string {
  const r = compile(
    `${DECLS}
    PROGRAM Main
    VAR s : ST; r : REF_TO ST; rf : REFERENCE TO ST; f : FBM;
      rr : REFERENCE TO FBM; x : INT; END_VAR
      ${body}
    END_PROGRAM`,
    { headerFileName: "generated.hpp" },
  );
  expect(r.errors).toEqual([]);
  return r.cppCode;
}

describe("references to a STRUCT or function block", () => {
  it("reaches members through a REFERENCE TO", () => {
    const code = run(`rf REF= s; rf.b := 2; x := rf.a; rr REF= f; x := rr.M();
      x := rr.v;`);
    expect(code).toContain("RF.bind(S);");
    expect(code).toContain("RF.target().B = 2;");
    expect(code).toContain("X = RF.target().A;");
    expect(code).toContain("X = RR.target().M();");
    expect(code).toContain("X = RR.target().V;");
  });

  it("takes REF of a STRUCT for a REF_TO", () => {
    const code = run(`r := REF(s); r^.a := 1; r REF= s;`);
    expect(code).toContain("R = REF(S);");
    expect(code).toContain("(*R).A = 1;");
  });
});

describe("REF / ADR of a CONFIGURATION global", () => {
  it("refers to the canonical storage and warns", () => {
    const r = compile(
      `${DECLS}
      PROGRAM Main
      VAR_EXTERNAL gi : INT; gs : ST; END_VAR
      VAR r : REF_TO INT; p : POINTER TO ST; rs : REF_TO ST; END_VAR
        r := REF(gi);
        p := ADR(gs);
        rs REF= gs;
      END_PROGRAM
      CONFIGURATION C
        VAR_GLOBAL gi : INT; gs : ST; END_VAR
        RESOURCE R ON PLC
          TASK T(INTERVAL := T#100ms, PRIORITY := 1);
          PROGRAM Inst WITH T : Main;
        END_RESOURCE
      END_CONFIGURATION`,
      { headerFileName: "generated.hpp" },
    );
    expect(r.errors).toEqual([]);
    expect(r.cppCode).toContain("R = REF(GI->value);");
    expect(r.cppCode).toContain("P = &(GS->value);");
    expect(r.cppCode).toContain("RS = REF(GS->value);");
    expect(
      r.warnings.filter((w) => w.message.includes("STRUCPP_THREADED")),
    ).toHaveLength(3);
  });
});
