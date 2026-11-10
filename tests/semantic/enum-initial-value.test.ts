/**
 * The initial value of an enumeration variable is checked like an
 * assignment: it must be a value of that enumeration. STRUCT fields, array
 * literals and structure initializers are checked element by element.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const TYPES = `TYPE E2 : (A, B); END_TYPE
TYPE E3 : (B, C, D); END_TYPE
TYPE E2A : E2; END_TYPE
TYPE S1 : STRUCT e : E2; n : INT; END_STRUCT END_TYPE
`;

function errorsFor(decl: string, dialect?: "iec-3"): string[] {
  return compile(
    `${TYPES}PROGRAM Main\nVAR ${decl} END_VAR\nEND_PROGRAM\n`,
    dialect ? { dialect } : {},
  ).errors.map((e) => e.message);
}

describe("initial value of an enumeration variable", () => {
  it.each([
    ["e : E2 := E3#C;", "Cannot assign E3 to E2"],
    ["e : E2 := E3.C;", "Cannot assign E3 to E2"],
    ["e : E2 := C;", "Cannot assign E3 to E2"],
    ["e : E2 := 5;", "Cannot assign INT to E2"],
    ["e : E2 := INT#1;", "Cannot assign INT to E2"],
    ["e : E2 := TRUE;", "Cannot assign BOOL to E2"],
    ["e : E2 := 'x';", "Cannot assign STRING to E2"],
    ["e : E2 := E2#Z;", "'Z' is not a value of enumeration E2"],
    ["e : E2 := E2.Z;", "'Z' is not a value of enumeration E2"],
    ["a : ARRAY[0..1] OF E2 := [E2#A, E3#C];", "Cannot assign E3 to E2"],
    ["a : ARRAY[0..1] OF E2 := [A, 1];", "Cannot assign INT to E2"],
    ["s : S1 := (e := E3#C);", "Cannot assign E3 to E2"],
    ["s : S1 := (e := 3, n := 1);", "Cannot assign INT to E2"],
  ])("refuses %s", (decl, message) => {
    expect(errorsFor(decl)).toEqual([message]);
    expect(errorsFor(decl, "iec-3")).toEqual([message]);
  });

  it("refuses it in every declaring scope", () => {
    const all = compile(
      `${TYPES}VAR_GLOBAL g : E2 := E3#C; END_VAR
FUNCTION F : INT VAR l : E2 := E3#C; END_VAR END_FUNCTION
FUNCTION_BLOCK FB VAR m : E2 := E3#C; END_VAR
METHOD M VAR t : E2 := E3#C; END_VAR END_METHOD
END_FUNCTION_BLOCK
TYPE S2 : STRUCT f : E2 := E3#C; END_STRUCT END_TYPE
PROGRAM Main END_PROGRAM
`,
      {},
    ).errors.map((e) => e.message);
    expect(all).toEqual(
      Array.from({ length: 5 }, () => "Cannot assign E3 to E2"),
    );
  });

  it("accepts a value of the enumeration", () => {
    const decls = `e1 : E2 := E2#B; e2 : E2 := B; e3 : E2 := E2.B; e4 : E3 := B;
      e5 : E2 := A; e6 : E2A := E2#B; e7 : E2A := B;
      a : ARRAY[0..1] OF E2 := [A, B]; a2 : ARRAY[0..1] OF E2 := [E2#A, E2.B];
      s : S1 := (e := B, n := 2); s2 : S1 := (e := E2#B);
      as : ARRAY[0..1] OF S1 := [(e := A), (e := E2#B)];
      i : INT := 5;`;
    expect(errorsFor(decls)).toEqual([]);
    expect(errorsFor(decls, "iec-3")).toEqual([]);
  });
});
