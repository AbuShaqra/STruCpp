/**
 * `TYPE ST_B EXTENDS ST_A : STRUCT ... END_STRUCT END_TYPE` parses in every
 * dialect; the feature struct_extends is checked by the analyzer. The parser
 * keeps the derived struct's own fields only; inheriting is semantic.
 */
import { describe, it, expect } from "vitest";
import { parse } from "../../src/frontend/parser.js";
import { buildAST } from "../../src/frontend/ast-builder.js";
import type { CompilationUnit } from "../../src/frontend/ast.js";

function build(source: string): CompilationUnit {
  const result = parse(source);
  expect(result.errors.map((e) => e.message)).toEqual([]);
  return buildAST(result.cst!);
}

describe("STRUCT EXTENDS parses", () => {
  it("records the base and keeps only the own fields", () => {
    const ast = build(`TYPE
  ST_A : STRUCT a1 : INT; END_STRUCT;
  ST_B EXTENDS ST_A : STRUCT b1 : INT; b2 : BOOL; END_STRUCT;
END_TYPE
`);
    const b = ast.types[1]!;
    expect(b.name).toBe("ST_B");
    expect(b.extends?.kind).toBe("TypeReference");
    expect(b.extends?.name).toBe("ST_A");
    expect(b.extends?.sourceSpan).toMatchObject({
      startLine: 3,
      startCol: 16,
    });
    expect(b.extendsKeywordSpan).toMatchObject({ startLine: 3, startCol: 8 });
    expect(b.definition.kind).toBe("StructDefinition");
    if (b.definition.kind !== "StructDefinition") return;
    expect(b.definition.fields.flatMap((f) => f.names)).toEqual(["B1", "B2"]);
    expect(b.definition.inheritedDeclarations).toBeUndefined();
    expect(ast.types[0]!.extends).toBeUndefined();
  });

  it("accepts each TYPE in its own block and no trailing semicolon", () => {
    const ast = build(`TYPE ST_C EXTENDS ST_B :
STRUCT
  c1 : REAL := 1.5;
END_STRUCT
END_TYPE
`);
    expect(ast.types[0]!.extends?.name).toBe("ST_B");
  });

  it("parses EXTENDS before a non-STRUCT definition (refused by the analyzer)", () => {
    const ast = build("TYPE T EXTENDS ST_A : INT; END_TYPE\n");
    expect(ast.types[0]!.extends?.name).toBe("ST_A");
    expect(ast.types[0]!.definition.kind).toBe("TypeReference");
  });

  it("keeps FUNCTION_BLOCK and INTERFACE EXTENDS unchanged", () => {
    const ast = build(`INTERFACE I_A END_INTERFACE
INTERFACE I_B EXTENDS I_A END_INTERFACE
FUNCTION_BLOCK FB_A END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_B EXTENDS FB_A END_FUNCTION_BLOCK
`);
    expect(ast.interfaces[1]!.extends).toEqual(["I_A"]);
    expect(ast.functionBlocks[1]!.extends).toBe("FB_A");
  });

  it("a plain TYPE has no extends", () => {
    const ast = build("TYPE ST_A : STRUCT a1 : INT; END_STRUCT; END_TYPE\n");
    expect(ast.types[0]).not.toHaveProperty("extends");
    expect(ast.types[0]).not.toHaveProperty("extendsKeywordSpan");
  });
});
