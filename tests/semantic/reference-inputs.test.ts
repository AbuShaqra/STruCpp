/**
 * A REFERENCE TO input is bound to its argument for the call, so the argument
 * must be a variable of exactly the referenced type (or a REFERENCE TO it):
 * an expression, a constant, another type or a subrange variable is refused
 * at analysis. An alias of the referenced type is accepted by analysis;
 * compile refuses binding to an alias-typed variable as not supported yet.
 */

import { describe, it, expect } from "vitest";
import { analyze, compile } from "../../src/index.js";

const HEADER = `
TYPE MyInt : INT; END_TYPE
TYPE MyInt2 : MyInt; END_TYPE
TYPE Small : INT(0..10); END_TYPE
TYPE Pt : STRUCT x : INT; END_STRUCT; END_TYPE
FUNCTION_BLOCK FB_R
VAR_INPUT r : REFERENCE TO INT; k : INT; END_VAR
  r := r + k;
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_A
VAR_INPUT r : REFERENCE TO MyInt; END_VAR
  r := r + 1;
END_FUNCTION_BLOCK
FUNCTION F_R : INT
VAR_INPUT r : REFERENCE TO INT; END_VAR
  F_R := r;
END_FUNCTION
FUNCTION_BLOCK FB_M
METHOD M : INT
VAR_INPUT r : REFERENCE TO INT; END_VAR
  M := r;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM main
VAR CONSTANT cn : INT := 3; END_VAR
VAR
  f : FB_R; fa : FB_A; m : FB_M; n : INT; d : DINT; a : INT;
  rr : REFERENCE TO INT; p : REF_TO INT; mi : MyInt; m2 : MyInt2;
  sm : Small; pt : Pt; arr : ARRAY[1..2] OF INT;
END_VAR
`;

function source(body: string): string {
  return `${HEADER}${body}\nEND_PROGRAM\n`;
}

function analysisErrors(body: string): string[] {
  return analyze(source(body)).errors.map((e) => e.message);
}

function compileErrors(body: string): string[] {
  return compile(source(body)).errors.map((e) => e.message);
}

const NOT_EXPRESSION =
  "REFERENCE TO input 'R' needs a variable to refer to, not an expression";

describe("REFERENCE TO input arguments", () => {
  it.each([
    ["FB, named", "f(r := 5, k := 1);"],
    ["FB, positional", "f(n + 1, 1);"],
    ["function, named", "a := F_R(r := 5);"],
    ["function, positional", "a := F_R(n * 2);"],
    ["method, named", "a := m.M(r := n + 1);"],
    ["method, positional", "a := m.M(4);"],
  ])("refuses an expression (%s)", (_label, body) => {
    expect(analysisErrors(body)).toEqual([NOT_EXPRESSION]);
  });

  it("refuses a constant", () => {
    expect(analysisErrors("f(r := cn, k := 1);")).toEqual([
      "REFERENCE TO input 'R' needs a variable to refer to, not a constant",
    ]);
  });

  it.each([
    ["FB", "f(r := d, k := 1);"],
    ["FB, positional", "f(d, 1);"],
    ["function", "a := F_R(d);"],
    ["method", "a := m.M(r := d);"],
  ])("refuses a variable of another type (%s)", (_label, body) => {
    expect(analysisErrors(body)).toEqual([
      "REFERENCE TO INT cannot refer to a DINT variable",
    ]);
  });

  it("refuses a REF_TO variable (its target is the type, not the REF_TO)", () => {
    expect(analysisErrors("f(r := p, k := 1);")).toEqual([
      "REFERENCE TO INT cannot refer to a REF_TO INT variable",
    ]);
  });

  it("refuses a subrange variable with the range reason", () => {
    expect(analysisErrors("f(r := sm, k := 1);")).toEqual([
      "REFERENCE TO INT cannot refer to a SMALL variable: writes through the reference would not be checked against the subrange",
    ]);
  });

  it.each([
    ["a local", "f(r := n, k := 1);"],
    ["an array element", "f(r := arr[2], k := 1);"],
    ["a STRUCT field", "a := F_R(r := pt.x);"],
    ["a REF_TO dereference", "a := m.M(p^);"],
    ["a REFERENCE TO (forwarded)", "a := F_R(rr);"],
    ["an omitted FB input", "f(k := 1);"],
    ["an omitted method input", "a := m.M();"],
  ])("accepts %s", (_label, body) => {
    expect(analysisErrors(body)).toEqual([]);
    expect(compileErrors(body)).toEqual([]);
  });

  it("an INT variable binds a REFERENCE TO an alias of INT", () => {
    expect(compileErrors("fa(r := n);")).toEqual([]);
  });

  it.each([
    ["alias", "f(r := mi, k := 1);", "INT", "MYINT"],
    ["alias of an alias", "f(r := m2, k := 1);", "INT", "MYINT2"],
    ["alias, reference to the alias", "fa(r := mi);", "MYINT", "MYINT"],
    ["alias, REF=", "rr REF= mi;", "INT", "MYINT"],
  ])(
    "an %s variable passes analysis and compile refuses it as not supported yet",
    (_label, body, ref, alias) => {
      expect(analysisErrors(body)).toEqual([]);
      expect(compileErrors(body)).toEqual([
        `binding a REFERENCE TO ${ref} to a variable of alias type '${alias}' is not supported yet`,
      ]);
    },
  );

  it("a function call without its REFERENCE TO input is still an error", () => {
    expect(analysisErrors("a := F_R();")).toEqual([
      "'F_R' is missing required input: R",
    ]);
  });

  it("REFERENCE TO stays behind the feature reference_to", () => {
    const result = analyze(source("f(r := n, k := 1);"), { dialect: "iec-3" });
    expect(
      result.errors.some((e) => e.message.includes("REFERENCE TO")),
    ).toBe(true);
  });
});
