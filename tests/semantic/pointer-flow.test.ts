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
    expect(
      targetsOf(
        `FUNCTION_BLOCK FB_A
VAR p : POINTER TO INT; END_VAR
METHOD M : INT
gp := ADR(gb);
THIS^.p := ADR(ga);
M := 0;
END_METHOD
END_FUNCTION_BLOCK
${GLOBALS}`,
        "GP",
      ),
    ).toEqual(["GA", "GB"]);
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
