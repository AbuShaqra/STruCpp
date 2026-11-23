/**
 * Selectors on a call result parse in every dialect: `F(1).n`, `fb.M()[2].a`,
 * `a.b.M().c`, `F().M()`. The feature call_result_access is checked by the
 * analyzer. A write to one (`F().a := v;`, `r REF= F().a;`, `REF(F().a)`)
 * parses too, so the type checker can refuse it.
 */
import { describe, it, expect } from "vitest";
import { analyze } from "../../src/index.js";
import { parse } from "../../src/frontend/parser.js";
import { buildAST } from "../../src/frontend/ast-builder.js";
import type {
  AssignmentStatement,
  CompilationUnit,
  Expression,
  RefAssignStatement,
  Statement,
} from "../../src/frontend/ast.js";

function build(source: string): CompilationUnit {
  const result = parse(source);
  expect(result.errors.map((e) => e.message)).toEqual([]);
  return buildAST(result.cst!);
}

/** The body statements of PROGRAM P around `body`. */
function body(statements: string): Statement[] {
  const ast = build(`PROGRAM P
VAR x : INT; fb : FB_A; r : REFERENCE TO INT; END_VAR
${statements}
END_PROGRAM
`);
  return ast.programs[0]!.body;
}

function assigned(statements: string): Expression {
  const stmt = body(statements)[0] as AssignmentStatement;
  expect(stmt.kind).toBe("AssignmentStatement");
  return stmt.value;
}

describe("member access on a call result parses", () => {
  it("`F(1).nCode` is a field on a function call", () => {
    const value = assigned("x := F(1).nCode;");
    expect(value.kind).toBe("CallResultAccessExpression");
    if (value.kind !== "CallResultAccessExpression") return;
    expect(value.call.kind).toBe("FunctionCallExpression");
    expect(value.call).toMatchObject({ functionName: "F" });
    expect(value.accessChain).toEqual([{ kind: "field", name: "NCODE" }]);
    expect(value.selectorSpan).toMatchObject({ startLine: 3, startCol: 10 });
  });

  it("`fb.M(5)[2].a.0` keeps subscripts, fields and bits in order", () => {
    const value = assigned("x := fb.M(5)[2].a.0;");
    if (value.kind !== "CallResultAccessExpression") {
      throw new Error(value.kind);
    }
    expect(value.call).toMatchObject({ functionName: "FB.M" });
    expect(value.accessChain.map((s) => s.kind)).toEqual([
      "subscript",
      "field",
      "field",
    ]);
    expect(value.accessChain[2]).toEqual({ kind: "field", name: "0" });
    expect(value.selectorSpan).toMatchObject({ startLine: 3, startCol: 13 });
  });

  it("`a.GetB().GetC().n` chains methods, then the field", () => {
    const value = assigned("x := a.GetB().GetC().n;");
    if (value.kind !== "CallResultAccessExpression") {
      throw new Error(value.kind);
    }
    expect(value.call.kind).toBe("MethodCallExpression");
    expect(value.call).toMatchObject({ methodName: "GETC" });
    expect(value.accessChain).toEqual([{ kind: "field", name: "N" }]);
  });

  it("`F().b.M().c` nests a method call on a member of a call result", () => {
    const value = assigned("x := F().b.M().c;");
    if (value.kind !== "CallResultAccessExpression") {
      throw new Error(value.kind);
    }
    const method = value.call;
    expect(method.kind).toBe("MethodCallExpression");
    if (method.kind !== "MethodCallExpression") return;
    expect(method.methodName).toBe("M");
    expect(method.object.kind).toBe("CallResultAccessExpression");
  });

  it("`F().M()` is a method call on a function's result", () => {
    const value = assigned("x := F().M();");
    expect(value.kind).toBe("MethodCallExpression");
    if (value.kind !== "MethodCallExpression") return;
    expect(value.object).toMatchObject({
      kind: "FunctionCallExpression",
      functionName: "F",
    });
  });

  it("`a.b.M(1).c` follows a call through a member chain", () => {
    const value = assigned("x := a.b.M(1).c + 1;");
    expect(value.kind).toBe("BinaryExpression");
    if (value.kind !== "BinaryExpression") return;
    expect(value.left.kind).toBe("CallResultAccessExpression");
  });

  it("a method chain without selectors is unchanged", () => {
    const value = assigned("x := h.GetItf().Run();");
    expect(value.kind).toBe("MethodCallExpression");
  });
});

describe("writes to a call result parse for the type checker to refuse", () => {
  it("`F().a := 1;` is an assignment with the access as target", () => {
    const stmt = body("F().a := 1;")[0] as AssignmentStatement;
    expect(stmt.kind).toBe("AssignmentStatement");
    expect(stmt.target.kind).toBe("CallResultAccessExpression");
  });

  it("`F()[2] := 1;` and `fb.M().a := 1;` too", () => {
    const stmts = body("F()[2] := 1;\nfb.M().a := 1;");
    expect(stmts.map((s) => (s as AssignmentStatement).target.kind)).toEqual([
      "CallResultAccessExpression",
      "CallResultAccessExpression",
    ]);
  });

  it("`r REF= F().a;` and `F().a REF= x;` are REF= statements", () => {
    const [source, target] = body("r REF= F().a;\nF().a REF= x;") as [
      RefAssignStatement,
      RefAssignStatement,
    ];
    expect(source.kind).toBe("RefAssignStatement");
    expect(source.source.kind).toBe("CallResultAccessExpression");
    expect(target.kind).toBe("RefAssignStatement");
    expect(target.target.kind).toBe("CallResultAccessExpression");
  });

  it("`REF(F().a)` takes the access as its operand", () => {
    const value = assigned("x := REF(F().a);");
    expect(value).toMatchObject({
      kind: "RefExpression",
      operand: { kind: "CallResultAccessExpression" },
    });
  });

  it("statements that only read a call result are unchanged", () => {
    const stmts = body(
      "x := F().a;\nfb(i := F().a);\nIF F().a = 1 THEN x := 2; END_IF",
    );
    expect(stmts.map((s) => s.kind)).toEqual([
      "AssignmentStatement",
      "FunctionCallStatement",
      "IfStatement",
    ]);
  });
});

describe("parse errors near the new forms read as before", () => {
  const wrap = (stmt: string): string =>
    `PROGRAM P\nVAR r : REFERENCE TO INT; y : INT; x : INT; END_VAR\n${stmt}\ny := 1;\nEND_PROGRAM\n`;
  const messages = (stmt: string): string[] =>
    analyze(wrap(stmt)).errors.map(
      (e) => `${e.line}:${e.column}: ${e.message}`,
    );

  it.each([
    [
      "r REF= ;",
      ["3:8: Unexpected `;` after `REF=` while parsing an identifier."],
    ],
    [
      "r REF= 5;",
      [
        "3:8: Unexpected integer literal `5` after `REF=` while parsing an identifier.",
      ],
    ],
    [
      "r REF= THIS^;",
      [
        "3:8: Unexpected `THIS` after `REF=` while parsing an identifier.",
        "3:8: Unexpected `THIS` after `REF=` while parsing a statement.",
        "3:8: Expected `END_PROGRAM`, found `THIS`.",
      ],
    ],
    ["x := F(1).;", ["3:10: Expected `Semicolon`, found `.`."]],
    ["x := F().[1];", ["3:9: Expected `Semicolon`, found `.`."]],
    [
      "IF := 1;",
      ["3:4: Unexpected `:=` after `IF` while parsing an expression."],
    ],
  ])("`%s`", (stmt, expected) => {
    expect(messages(stmt)).toEqual(expected);
  });

  it("no message names a grammar rule", () => {
    for (const stmt of [
      "x := F(1).",
      "F().a := ;",
      "r REF= F().;",
      "x := F()[;",
    ]) {
      for (const message of messages(stmt)) {
        expect(message).not.toMatch(/rule `|callResult/);
      }
    }
  });
});
