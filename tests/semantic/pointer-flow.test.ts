/** What a pointer may point to, for ordering the creation of globals (pointer-flow.ts). */
import { describe, it, expect } from "vitest";
import { parse } from "../../src/index.js";
import { PointerFlow } from "../../src/semantic/pointer-flow.js";
import type { VarDeclaration } from "../../src/frontend/ast.js";

/** The flow of `source`, and the targets of a global pointer. */
function targetsOf(source: string, pointer: string): string[] {
  const { ast } = parse(source);
  if (!ast) throw new Error("parse failed");
  const owner = new Map<string, string>();
  const globals = new Map<string, VarDeclaration>();
  for (const block of ast.globalVarBlocks) {
    for (const decl of block.declarations) {
      for (const name of decl.names) {
        owner.set(name.toUpperCase(), name.toUpperCase());
        globals.set(name.toUpperCase(), decl);
      }
    }
  }
  const flow = new PointerFlow(ast, owner, globals);
  return [...flow.pointsTo(`G:${pointer}`)].sort();
}

const GLOBALS = `VAR_GLOBAL gp : POINTER TO INT; ga : INT; gb : INT; END_VAR
PROGRAM Main END_PROGRAM
`;

describe("pointer flow", () => {
  it("follows an address stored into a pointer", () => {
    expect(
      targetsOf(
        `FUNCTION_BLOCK FB_A
METHOD M : INT
gp := ADR(gb);
M := 0;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION F : INT
VAR q : POINTER TO INT; END_VAR
q := ADR(ga);
F := 0;
END_FUNCTION
${GLOBALS}`,
        "GP",
      ),
    ).toEqual(["GB"]);
  });

  it("takes a pointer copied from a field as pointing anywhere an address is taken", () => {
    expect(
      targetsOf(
        `TYPE ST : STRUCT p : POINTER TO INT; END_STRUCT END_TYPE
FUNCTION_BLOCK FB_A
VAR s : ST; END_VAR
METHOD M : INT
s.p := ADR(gb);
gp := s.p;
M := 0;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION F : INT
VAR q : POINTER TO INT; END_VAR
q := ADR(ga);
F := 0;
END_FUNCTION
${GLOBALS}`,
        "GP",
      ),
    ).toEqual(["GA", "GB"]);
  });

  it("takes every pointer as pointing anywhere once a store it cannot place is met", () => {
    for (const store of [
      "pp^ := ADR(ga);",
      "lib.p := ADR(ga);",
      "pi^ := ADR(ga);",
    ]) {
      expect(
        targetsOf(
          `FUNCTION_BLOCK FB_A
VAR pp : POINTER TO POINTER TO INT; lib : LIB_FB; pi : POINTER TO INT; END_VAR
METHOD M : INT
gp := ADR(gb);
${store}
M := 0;
END_METHOD
END_FUNCTION_BLOCK
${GLOBALS}`,
          "GP",
        ),
      ).toEqual(["GA", "GB"]);
    }
  });

  it("places a store into a pointer member reached by a path", () => {
    for (const store of [
      "THIS^.p := ADR(ga);",
      "fx.p := ADR(ga);",
      "px^.p := ADR(ga);",
      "arr[1].p := ADR(ga);",
      "s.q := ADR(ga);",
      "e[0] := ADR(ga);",
    ]) {
      expect(
        targetsOf(
          `TYPE ST : STRUCT q : POINTER TO INT; END_STRUCT END_TYPE
FUNCTION_BLOCK FB_A
VAR p : POINTER TO INT; fx : FB_A; px : POINTER TO FB_A;
  arr : ARRAY[0..1] OF FB_A; s : ST; e : ARRAY[0..1] OF POINTER TO INT; END_VAR
METHOD M : INT
gp := ADR(gb);
${store}
M := 0;
END_METHOD
END_FUNCTION_BLOCK
${GLOBALS}`,
          "GP",
        ),
      ).toEqual(["GB"]);
    }
  });

  it("follows a pointer copied from a member reached by a path", () => {
    expect(
      targetsOf(
        `FUNCTION_BLOCK FB_A
VAR_OUTPUT p : POINTER TO INT; END_VAR
p := ADR(gb);
END_FUNCTION_BLOCK
FUNCTION F : INT
VAR_EXTERNAL fa : FB_A; END_VAR
VAR q : POINTER TO INT; END_VAR
q := ADR(ga);
gp := fa.p;
F := 0;
END_FUNCTION
VAR_GLOBAL fa : FB_A; END_VAR
${GLOBALS}`,
        "GP",
      ),
    ).toEqual(["GB"]);
  });

  it("takes the pointer members of a function block whose address is taken as pointing anywhere", () => {
    for (const [address, expected] of [
      ["ADR(fa)", ["FA", "GA", "GB"]],
      ["ADR(st.inner)", ["GA", "GB", "ST"]],
      ["ADR(fa.p)", ["FA", "GA", "GB"]],
    ] as const) {
      expect(
        targetsOf(
          `FUNCTION_BLOCK FB_A
VAR_OUTPUT p : POINTER TO INT; END_VAR
p := ADR(gb);
END_FUNCTION_BLOCK
TYPE ST : STRUCT inner : FB_A; END_STRUCT END_TYPE
FUNCTION F : INT
VAR_EXTERNAL fa : FB_A; st : ST; END_VAR
VAR q : POINTER TO INT; n : ULINT; END_VAR
q := ADR(ga);
n := MEMCPY(${address}, ADR(q), 8);
gp := fa.p;
F := 0;
END_FUNCTION
VAR_GLOBAL fa : FB_A; st : ST; END_VAR
${GLOBALS}`,
          "GP",
        ),
      ).toEqual(expected);
    }
  });

  it("takes a pointer whose address is taken, or passed to an unknown call, as pointing anywhere", () => {
    for (const [use, expected] of [
      ["pp := ADR(gp);", ["GA", "GB", "GP"]],
      ["LIB_CALL(gp);", ["GA", "GB"]],
    ] as const) {
      expect(
        targetsOf(
          `FUNCTION_BLOCK FB_A
VAR pp : POINTER TO POINTER TO INT; END_VAR
METHOD M : INT
gp := ADR(gb);
${use}
M := 0;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION F : INT
VAR q : POINTER TO INT; END_VAR
q := ADR(ga);
F := 0;
END_FUNCTION
${GLOBALS}`,
          "GP",
        ),
      ).toEqual(expected);
    }
  });
});
