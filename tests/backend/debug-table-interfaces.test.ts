/**
 * Interface-typed variables in the debug table.
 *
 * An interface variable holds a reference to the implementing instance, so it
 * is left out like a POINTER TO / REFERENCE TO, with a build warning naming
 * it; an array of interfaces is left out once, as a whole. The table used to
 * crash on them, because interfaces are type symbols without a declaration.
 */

import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const SOURCE = `
INTERFACE I_S
METHOD Reset : BOOL
END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB_A IMPLEMENTS I_S
VAR n : INT; END_VAR
METHOD Reset : BOOL
Reset := TRUE;
END_METHOD
END_FUNCTION_BLOCK
TYPE TA : ARRAY[0..1] OF I_S; END_TYPE
TYPE ST_H : STRUCT one : I_S; list : TA; v : INT; END_STRUCT; END_TYPE
FUNCTION_BLOCK FB_H
VAR_INPUT src : I_S; END_VAR
VAR held : I_S; slots : ARRAY[1..2] OF I_S; k : INT; END_VAR
END_FUNCTION_BLOCK
PROGRAM Main
VAR
  a : FB_A;
  one : I_S;
  arr : ARRAY[1..2] OF I_S;
  grid : ARRAY[0..1, 0..1] OF I_S;
  named : TA;
  st : ST_H;
  h : FB_H;
  b : BOOL;
END_VAR
one := a; arr[1] := a;
b := one.Reset();
END_PROGRAM
CONFIGURATION Cfg
VAR_GLOBAL gIf : I_S; gArr : ARRAY[1..2] OF I_S; gN : INT; END_VAR
RESOURCE Res ON PLC
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM P WITH T : Main;
END_RESOURCE
END_CONFIGURATION
`;

describe("debug table and interface variables", () => {
  const result = compile(SOURCE);

  it("compiles with a CONFIGURATION", () => {
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
    expect(result.debugTableCpp).toBeDefined();
    expect(result.debugMap).toBeDefined();
  });

  it("registers only the value leaves", () => {
    expect(result.debugMap?.leaves.map((l) => `${l.path}:${l.type}`)).toEqual([
      "GN:INT",
      "P.A.N:INT",
      "P.ST.V:INT",
      "P.H.K:INT",
      "P.B:BOOL",
    ]);
  });

  it("names every interface variable it leaves out", () => {
    const skipped = result.warnings
      .map((w) => w.message)
      .filter((m) => m.includes("is not debuggable"));
    const one = (p: string): string =>
      `${p} is not debuggable: an interface reference (I_S) holds an address, which the debugger cannot show or write.`;
    const many = (p: string): string =>
      `${p} is not debuggable: an array of interface references holds addresses, which the debugger cannot show or write.`;
    expect(skipped).toEqual([
      one("GIF"),
      many("GARR"),
      one("P.ONE"),
      many("P.ARR"),
      many("P.GRID"),
      many("P.NAMED"),
      one("P.ST.ONE"),
      many("P.ST.LIST"),
      one("P.H.SRC"),
      one("P.H.HELD"),
      many("P.H.SLOTS"),
    ]);
  });

  it("the debug table C++ has no entry for an interface variable", () => {
    expect(result.debugTableCpp).not.toMatch(
      /\bONE\b|\bARR\b|\bGRID\b|\bNAMED\b|\bHELD\b|\bSLOTS\b|\bGIF\b|\bGARR\b/,
    );
  });
});
