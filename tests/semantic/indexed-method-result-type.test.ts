/**
 * A method called through an indexed element (an interface or FB array,
 * multi-dimensional, a STRUCT field, `arr[i]` in a FOR) has the method's
 * declared return type, an enumeration included, as through a variable.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];

const TYPES = `TYPE E_St : (Idle, Run); END_TYPE
TYPE ST_P : STRUCT x : INT; END_STRUCT END_TYPE
INTERFACE I_S
METHOD State : E_St
END_METHOD
METHOD Pos : ST_P
END_METHOD
END_INTERFACE
TYPE S_H : STRUCT items : ARRAY[1..2] OF I_S; fbs : ARRAY[0..1] OF FB_A; END_STRUCT END_TYPE
FUNCTION_BLOCK FB_A IMPLEMENTS I_S
METHOD State : E_St
State := E_St#Run;
END_METHOD
METHOD Pos : ST_P
Pos.x := 3;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_In
VAR_INPUT st : E_St; END_VAR
END_FUNCTION_BLOCK
FUNCTION F_Id : E_St
VAR_INPUT v : E_St; END_VAR
F_Id := v;
END_FUNCTION
`;

const ACCEPTED = `${TYPES}
PROGRAM Main
VAR a : FB_A; e1, e2, e3, e4, e5, e6, e7 : E_St; n, i : INT; b : BOOL; h : S_H;
  fi : FB_In; p : ST_P; fbarr : ARRAY[1..2] OF FB_A; m : ARRAY[1..2, 1..2] OF I_S;
  one : I_S; arr : ARRAY[1..1] OF I_S; END_VAR
one := a; arr[1] := a; m[2, 1] := a; h.items[2] := a;
e1 := one.State();
e2 := arr[1].State();
e3 := fbarr[2].State();
e4 := m[2, 1].State();
e5 := h.items[2].State();
e6 := h.fbs[1].State();
e7 := F_Id(arr[1].State());
p := arr[1].Pos();
fi(st := arr[1].State());
b := arr[1].State() = E_St#Run;
CASE arr[1].State() OF E_St#Run: n := 1; END_CASE;
FOR i := 1 TO 1 DO
  IF arr[i].State() <> E_St#Idle THEN n := n + 1; END_IF;
  CASE arr[i].State() OF E_St#Run: n := n + 10; END_CASE;
END_FOR;
END_PROGRAM
`;

describe("method result through an indexed element", () => {
  for (const [label, options] of MODES) {
    it(`has the method's enum or STRUCT type (${label})`, () => {
      const r = compile(ACCEPTED, { ...options, headerFileName: "g.hpp" });
      expect(r.errors).toEqual([]);
    });
  }

  it("is still refused where the declared type does not fit", () => {
    const r = compile(
      `${TYPES}
PROGRAM Main
VAR n : INT; fbarr : ARRAY[1..2] OF FB_A; arr : ARRAY[1..1] OF I_S; END_VAR
n := arr[1].State();
n := fbarr[1].State();
END_PROGRAM
`,
      { headerFileName: "g.hpp" },
    );
    expect(r.errors.map((e) => e.message)).toEqual([
      "Cannot assign E_ST to INT",
      "Cannot assign E_ST to INT",
    ]);
  });
});
