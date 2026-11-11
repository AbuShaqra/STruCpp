/**
 * `v.M()` on a variable: an instance of a function block or interface of
 * this compile must have the method (own, inherited or an action); a value
 * that is no instance has no methods. A REFERENCE TO is checked as its
 * target; library blocks are not checked.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";

const DECLS = `
  TYPE ST_P : STRUCT a : INT; END_STRUCT END_TYPE
  TYPE ST_F : STRUCT f : FB_C; END_STRUCT END_TYPE
  TYPE E_M : (ALPHA, BETA); END_TYPE
  TYPE T_FB : FB_A; END_TYPE
  INTERFACE I_A
  METHOD M : INT
  END_METHOD
  END_INTERFACE
  FUNCTION_BLOCK FB_C
  END_FUNCTION_BLOCK
  FUNCTION_BLOCK FB_A IMPLEMENTS I_A
  VAR_OUTPUT o : INT; END_VAR
  VAR PUBLIC sub : FB_C; t : TON; END_VAR
  METHOD M : INT
    M := 1;
  END_METHOD
  ACTION Act:
  END_ACTION
  END_FUNCTION_BLOCK
  FUNCTION_BLOCK FB_B EXTENDS FB_A
  END_FUNCTION_BLOCK
`;

function errorsIn(body: string, dialect?: "iec-3"): string[] {
  return compile(
    `${DECLS}
    PROGRAM Main
    VAR inst : FB_A; b : FB_B; i : INT; r : INT; s : ST_P; e : E_M; str : STRING;
      arr : ARRAY[0..1] OF FB_A; itf : I_A; al : T_FB; tn : TON; sf : ST_F; END_VAR
      ${body}
    END_PROGRAM`,
    { libraries: discoverStlibs("libs"), ...(dialect ? { dialect } : {}) },
  ).errors.map((e) => e.message);
}

describe("method call on a variable", () => {
  it("refuses a method the function block or interface does not have", () => {
    expect(
      errorsIn("r := inst.Nope(); b.Nope(); r := itf.Nope(); r := al.Nope();"),
    ).toEqual([
      "Function block 'FB_A' has no method 'NOPE'",
      "Function block 'FB_B' has no method 'NOPE'",
      "Interface 'I_A' has no method 'NOPE'",
      "Function block 'FB_A' has no method 'NOPE'",
    ]);
  });

  it("refuses a method call on a value that is no instance", () => {
    expect(
      errorsIn(
        "r := i.M(); i.M(); r := s.M(); r := e.M(); r := str.M(); r := arr.M();",
      ),
    ).toEqual([
      "Cannot call method 'M' on 'I': it is not a function block instance",
      "Cannot call method 'M' on 'I': it is not a function block instance",
      "Cannot call method 'M' on 'S': it is not a function block instance",
      "Cannot call method 'M' on 'E': it is not a function block instance",
      "Cannot call method 'M' on 'STR': it is not a function block instance",
      "Cannot call method 'M' on 'ARR': it is not a function block instance",
    ]);
  });

  it("refuses calling a member that is no instance as a method", () => {
    expect(errorsIn("inst.o(); s.a();")).toEqual([
      "Cannot call 'INST.O': it is a member that is not a function block instance, not a method",
      "Cannot call 'S.A': it is a member that is not a function block instance, not a method",
    ]);
  });

  it("accepts calling a member function block instance", () => {
    expect(
      errorsIn("inst.sub(); inst.t(IN := TRUE, PT := T#1S); sf.f();"),
    ).toEqual([]);
  });

  it("refuses under iec-3 too", () => {
    expect(errorsIn("r := inst.Nope();", "iec-3")).toEqual([
      "Function block 'FB_A' has no method 'NOPE'",
    ]);
  });

  it("accepts own, inherited, interface, alias and action calls, and library blocks", () => {
    expect(
      errorsIn(
        "itf := inst; r := inst.M(); r := b.M(); r := itf.M(); r := al.M(); inst.Act(); b.Act(); tn(IN := TRUE, PT := T#1S);",
      ),
    ).toEqual([]);
  });

  it("checks pointers and references", () => {
    const result = compile(
      `${DECLS}
      PROGRAM Main
      VAR inst : FB_A; r : INT; p : POINTER TO FB_A; rf : REF_TO FB_A;
        rr : REFERENCE TO FB_A; END_VAR
        r := p.M(); r := rf.M(); r := rr.Nope(); r := rr.M();
      END_PROGRAM`,
      { libraries: discoverStlibs("libs") },
    );
    expect(result.errors.map((e) => e.message)).toEqual([
      "Cannot call method 'M' on 'P': it is not a function block instance",
      "Cannot call method 'M' on 'RF': it is not a function block instance",
      "Function block 'FB_A' has no method 'NOPE'",
    ]);
  });
});
