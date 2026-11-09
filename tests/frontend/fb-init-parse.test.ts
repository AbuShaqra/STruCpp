/**
 * Init arguments after an FB instance's type, `fb : FB_A(p := 1);`, parse in
 * every dialect (the feature fb_init is checked by the analyzer), also after
 * `ARRAY[..] OF FB_A`, in VAR_GLOBAL and together with an IEC `:= (...)`
 * initial value. The IEC form alone, a subrange and STRING(n) parse as before.
 */
import { describe, it, expect } from "vitest";
import { parse } from "../../src/frontend/parser.js";
import { buildAST } from "../../src/frontend/ast-builder.js";
import type {
  CompilationUnit,
  VarDeclaration,
} from "../../src/frontend/ast.js";

function build(source: string): CompilationUnit {
  const result = parse(source);
  expect(result.errors.map((e) => e.message)).toEqual([]);
  return buildAST(result.cst!);
}

function decls(ast: CompilationUnit): VarDeclaration[] {
  return [
    ...ast.globalVarBlocks,
    ...ast.programs.flatMap((p) => p.varBlocks),
  ].flatMap((b) => b.declarations);
}

/** Each init argument as `NAME:=` (or `=>`) or `<pos>`, with its value's kind. */
function args(decl: VarDeclaration | undefined): string[] {
  return (decl?.fbInitArguments ?? []).map(
    (a) =>
      `${a.name === undefined ? "<pos>" : a.name + (a.isOutput ? "=>" : ":=")}${a.value.kind}`,
  );
}

describe("FB init arguments parse", () => {
  it("after a type, an array type and in VAR_GLOBAL, with the span of '('", () => {
    const ast = build(`VAR_GLOBAL
  g : FB_A(p := 1, q := x + 1);
END_VAR
PROGRAM P
VAR
  a, b : FB_A(p := 2);
  arr : ARRAY[0..1] OF FB_A(p := 3);
  c : FB_A(p := 4) := (q := 5);
  plain : FB_A;
END_VAR
END_PROGRAM
`);
    const [g, ab, arr, c, plain] = decls(ast);
    expect(args(g)).toEqual(["P:=LiteralExpression", "Q:=BinaryExpression"]);
    expect(g!.fbInitSpan).toMatchObject({ startLine: 2, startCol: 11 });
    expect(g!.type.name).toBe("FB_A");
    expect(ab!.names).toEqual(["A", "B"]);
    expect(args(ab)).toEqual(["P:=LiteralExpression"]);
    expect(arr!.type.elementTypeName).toBe("FB_A");
    expect(args(arr)).toEqual(["P:=LiteralExpression"]);
    expect(args(c)).toEqual(["P:=LiteralExpression"]);
    expect(c!.initialValue?.kind).toBe("StructInitializerExpression");
    expect(plain).not.toHaveProperty("fbInitArguments");
    expect(plain).not.toHaveProperty("fbInitSpan");
  });

  it("keeps positional and '=>' arguments for the analyzer to refuse", () => {
    const ast = build(`PROGRAM P
VAR f : FB_A(1, q => r); END_VAR
END_PROGRAM
`);
    expect(args(decls(ast)[0])).toEqual([
      "<pos>LiteralExpression",
      "Q=>VariableExpression",
    ]);
  });

  it("leaves the IEC form, a subrange and STRING(n) as before", () => {
    const ast = build(`PROGRAM P
VAR
  f : FB_A := (p := 3);
  lvl : INT(0..100) := 5;
  s : STRING(10);
END_VAR
END_PROGRAM
`);
    const [f, lvl, s] = decls(ast);
    for (const d of [f, lvl, s]) {
      expect(d).not.toHaveProperty("fbInitArguments");
    }
    expect(f!.initialValue?.kind).toBe("StructInitializerExpression");
    expect(lvl!.type.inlineDefinition?.kind).toBe("SubrangeDefinition");
    expect(s!.type.maxLength).toBe(10);
  });

  it("an empty list is a parse error", () => {
    expect(
      parse(`PROGRAM P VAR f : FB_A(); END_VAR END_PROGRAM`).errors,
    ).not.toEqual([]);
  });
});
