/**
 * ACTION ... END_ACTION (parser and AST): the top-level form `ACTION Owner.Name`
 * and the form inside a PROGRAM or FUNCTION_BLOCK after its body. `action` stays
 * usable as a plain identifier.
 */
import { describe, it, expect } from "vitest";
import { parse } from "../../src/frontend/parser.js";
import { buildAST } from "../../src/frontend/ast-builder.js";
import { mergeCompilationUnits } from "../../src/merge.js";

function build(source: string) {
  const result = parse(source);
  expect(result.errors).toHaveLength(0);
  return buildAST(result.cst!);
}

describe("ACTION declarations", () => {
  it("top-level ACTION Owner.Name with and without colon", () => {
    const ast = build(`
PROGRAM MAIN
  VAR n : INT; END_VAR
  n := 0;
END_PROGRAM
ACTION MAIN.Bump:
  n := n + 1;
END_ACTION
ACTION MAIN.Reset
  n := 0;
END_ACTION
`);
    expect(ast.actions.map((a) => [a.owner, a.name])).toEqual([
      ["MAIN", "BUMP"],
      ["MAIN", "RESET"],
    ]);
    expect(ast.actions[0]!.body).toHaveLength(1);
    expect(ast.programs[0]!.actions).toHaveLength(0);
  });

  it("in-POU ACTION in a PROGRAM after the body, with and without colon", () => {
    const ast = build(`
PROGRAM MAIN
  VAR n : INT; END_VAR
  n := 1;
  ACTION Bump:
    n := n + 1;
  END_ACTION
  ACTION Reset
    n := 0;
  END_ACTION
END_PROGRAM
`);
    const p = ast.programs[0]!;
    expect(p.body).toHaveLength(1);
    expect(p.actions.map((a) => a.name)).toEqual(["BUMP", "RESET"]);
    expect(p.actions[0]!.owner).toBeUndefined();
    expect(p.actions[0]!.body).toHaveLength(1);
    expect(ast.actions).toHaveLength(0);
  });

  it("in-POU ACTION in a FUNCTION_BLOCK after methods and body", () => {
    const ast = build(`
FUNCTION_BLOCK Fb
  VAR n : INT; END_VAR
  METHOD Inc
    n := n + 1;
  END_METHOD
  Inc();
  ACTION Twice:
    Inc();
    Inc();
  END_ACTION
END_FUNCTION_BLOCK
`);
    const fb = ast.functionBlocks[0]!;
    expect(fb.methods).toHaveLength(1);
    expect(fb.body).toHaveLength(1);
    expect(fb.actions).toHaveLength(1);
    expect(fb.actions[0]!.body).toHaveLength(2);
  });

  it("several actions in one POU", () => {
    const ast = build(`
PROGRAM P
  ACTION A1 END_ACTION
  ACTION A2 END_ACTION
  ACTION A3 END_ACTION
END_PROGRAM
`);
    expect(ast.programs[0]!.actions.map((a) => a.name)).toEqual([
      "A1",
      "A2",
      "A3",
    ]);
  });

  it("an empty action", () => {
    const ast = build(`
PROGRAM P
  ACTION Nothing: END_ACTION
END_PROGRAM
`);
    expect(ast.programs[0]!.actions[0]!.body).toEqual([]);
  });

  it("a variable named action still parses", () => {
    const ast = build(`
PROGRAM P
  VAR action : INT; END_VAR
  action := 1;
  action := action + 1;
END_PROGRAM
`);
    expect(ast.programs[0]!.body).toHaveLength(2);
    expect(ast.programs[0]!.actions).toHaveLength(0);
  });

  it("action as an FB field and a method parameter", () => {
    const ast = build(`
FUNCTION_BLOCK Fb
  VAR action : INT; n : INT; END_VAR
  METHOD Store
    VAR_INPUT action : INT; END_VAR
    n := action;
  END_METHOD
  action := 2;
  ACTION Later
    action := 3;
  END_ACTION
END_FUNCTION_BLOCK
`);
    const fb = ast.functionBlocks[0]!;
    expect(fb.varBlocks[0]!.declarations[0]!.names).toEqual(["ACTION"]);
    expect(fb.methods[0]!.varBlocks[0]!.declarations[0]!.names).toEqual([
      "ACTION",
    ]);
    expect(fb.body).toHaveLength(1);
    expect(fb.actions.map((a) => a.name)).toEqual(["LATER"]);
  });

  it("an action named Set or On", () => {
    const ast = build(`
PROGRAM P
  ACTION Set
    ;
  END_ACTION
  ACTION On:
    ;
  END_ACTION
END_PROGRAM
ACTION P.Get
  ;
END_ACTION
`);
    expect(ast.programs[0]!.actions.map((a) => a.name)).toEqual(["SET", "ON"]);
    expect(ast.actions[0]!.name).toBe("GET");
  });

  it("END_ACTION missing is a syntax error at EOF", () => {
    const result = parse(`
PROGRAM P
  ACTION A
    ;
END_PROGRAM
`);
    expect(result.errors.length).toBeGreaterThan(0);
    const top = parse(`ACTION P.A\n  ;\n`);
    expect(top.errors.length).toBeGreaterThan(0);
  });

  it("VAR inside an action is a syntax error", () => {
    const result = parse(`
PROGRAM P
  ACTION A:
    VAR x : INT; END_VAR
    x := 1;
  END_ACTION
END_PROGRAM
`);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]!.message).not.toMatch(/undefined|\[object/);
  });

  it("the AST carries owner, name, body and spans", () => {
    const ast = build(`ACTION MAIN.Bump:
  n := 1;
  m := 2;
END_ACTION
`);
    const a = ast.actions[0]!;
    expect(a.kind).toBe("ActionDeclaration");
    expect(a.owner).toBe("MAIN");
    expect(a.name).toBe("BUMP");
    expect(a.body).toHaveLength(2);
    expect(a.sourceSpan.startLine).toBe(1);
    expect(a.sourceSpan.endLine).toBe(4);
    expect(a.body[1]!.sourceSpan.startLine).toBe(3);
  });

  it("mergeCompilationUnits carries top-level actions", () => {
    const a = build(`ACTION M.A1\n ;\nEND_ACTION\n`);
    const b = build(`ACTION M.A2\n ;\nEND_ACTION\n`);
    const merged = mergeCompilationUnits([a, b]);
    expect(merged.actions.map((x) => x.name)).toEqual(["A1", "A2"]);
  });
});
