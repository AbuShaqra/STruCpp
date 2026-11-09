/**
 * PROGRAM methods (parser and AST): a PROGRAM takes METHODs interleaved with
 * its VAR blocks, before the body, as a FUNCTION_BLOCK does. Whether they are
 * allowed is the analyzer's call (feature program_methods), not the parser's.
 */
import { describe, it, expect } from "vitest";
import { parse } from "../../src/frontend/parser.js";
import { buildAST } from "../../src/frontend/ast-builder.js";
import { findEnclosingPOU, walkAST } from "../../src/ast-utils.js";

function build(source: string) {
  const result = parse(source);
  expect(result.errors).toHaveLength(0);
  return buildAST(result.cst!);
}

describe("PROGRAM methods: parser", () => {
  it("parses a PROGRAM with VARs, two METHODs and a body", () => {
    const ast = build(`
PROGRAM MAIN
VAR
  n : INT;
END_VAR
METHOD Count
  n := n + 1;
END_METHOD
METHOD Twice : INT
VAR_INPUT x : INT; END_VAR
  Twice := x * 2;
END_METHOD
  Count();
  n := Twice(n);
END_PROGRAM
`);
    const prog = ast.programs[0]!;
    expect(prog.name).toBe("MAIN");
    expect(prog.varBlocks).toHaveLength(1);
    expect(prog.methods.map((m) => m.name.toUpperCase())).toEqual([
      "COUNT",
      "TWICE",
    ]);
    expect(prog.methods[1]!.returnType?.name).toBe("INT");
    expect(prog.methods[1]!.varBlocks[0]!.blockType).toBe("VAR_INPUT");
    expect(prog.body).toHaveLength(2);
    expect(prog.methods[0]!.fromAction).toBeUndefined();
  });

  it("parses methods interleaved with VAR blocks", () => {
    const ast = build(`
PROGRAM MAIN
VAR a : INT; END_VAR
METHOD One
  a := 1;
END_METHOD
VAR b : INT; END_VAR
METHOD Two
  b := 2;
END_METHOD
VAR_TEMP c : INT; END_VAR
  One();
END_PROGRAM
`);
    const prog = ast.programs[0]!;
    expect(prog.varBlocks.map((b) => b.blockType)).toEqual([
      "VAR",
      "VAR",
      "VAR_TEMP",
    ]);
    expect(prog.methods.map((m) => m.name.toUpperCase())).toEqual([
      "ONE",
      "TWO",
    ]);
    expect(prog.body).toHaveLength(1);
  });

  it("a PROGRAM without methods has an empty methods list", () => {
    const ast = build(`
PROGRAM MAIN
VAR a : INT; END_VAR
  a := 1;
END_PROGRAM
`);
    expect(ast.programs[0]!.methods).toEqual([]);
  });

  it("a PROGRAM with only methods and no body parses", () => {
    const ast = build(`
PROGRAM MAIN
METHOD Init
END_METHOD
END_PROGRAM
`);
    expect(ast.programs[0]!.methods.map((m) => m.name.toUpperCase())).toEqual([
      "INIT",
    ]);
    expect(ast.programs[0]!.body).toEqual([]);
  });

  it("PROPERTY stays out of programs", () => {
    const result = parse(`
PROGRAM MAIN
VAR a : INT; END_VAR
PROPERTY P : INT
  GET
    P := a;
  END_GET
END_PROPERTY
END_PROGRAM
`);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("AST walkers and the enclosing-POU lookup see program methods", () => {
    const result = parse(
      `PROGRAM MAIN
VAR n : INT; END_VAR
METHOD Count
  n := n + 1;
END_METHOD
  Count();
END_PROGRAM
`,
    );
    expect(result.errors).toHaveLength(0);
    const ast = buildAST(result.cst!, "main.st");
    const kinds: string[] = [];
    walkAST(ast.programs[0]!, (node) => {
      kinds.push(node.kind);
    });
    expect(kinds).toContain("MethodDeclaration");
    expect(findEnclosingPOU(ast, "main.st", 4, 3)).toEqual({
      kind: "method",
      name: "COUNT",
      parentName: "MAIN",
    });
    expect(findEnclosingPOU(ast, "main.st", 6, 3)).toEqual({
      kind: "program",
      name: "MAIN",
    });
  });
});
