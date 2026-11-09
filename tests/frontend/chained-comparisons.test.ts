/**
 * Chained comparisons: the comparison operators follow the IEC 61131-3
 * Annex A grammar. `<`, `>`, `<=` and `>=` bind tighter than `=` and `<>`,
 * and both levels repeat left-associatively. Single comparisons and the
 * other precedence levels keep their shape.
 */
import { describe, it, expect } from "vitest";
import { parse } from "../../src/frontend/parser.js";
import { buildAST } from "../../src/frontend/ast-builder.js";
import type {
  AssignmentStatement,
  Expression,
} from "../../src/frontend/ast.js";

/** Render an expression fully parenthesised, so the tree shape is visible. */
function shape(expr: Expression): string {
  switch (expr.kind) {
    case "BinaryExpression":
      return `(${shape(expr.left)} ${expr.operator} ${shape(expr.right)})`;
    case "UnaryExpression":
      return `(${expr.operator} ${shape(expr.operand)})`;
    case "ParenthesizedExpression":
      return `[${shape(expr.expression)}]`;
    case "VariableExpression":
      return expr.name.toLowerCase();
    case "LiteralExpression":
      return String(expr.rawValue);
    default:
      return expr.kind;
  }
}

/** Parse `r := <expr>;` in a program and return the right-hand side. */
function rhs(expr: string): Expression {
  const result = parse(
    `PROGRAM P\nVAR a, b, c, d, r : INT; END_VAR\nr := ${expr};\nEND_PROGRAM\n`,
  );
  expect(result.errors.map((e) => e.message)).toEqual([]);
  const ast = buildAST(result.cst!);
  const stmt = ast.programs[0]!.body[0] as AssignmentStatement;
  return stmt.value;
}

describe("chained comparisons (Annex A grouping)", () => {
  const cases: [string, string][] = [
    ["a < b < c", "((a < b) < c)"],
    ["a > b >= c <= d", "(((a > b) >= c) <= d)"],
    ["a = b = c", "((a = b) = c)"],
    ["a <> b = c", "((a <> b) = c)"],
    ["a = b <> c = d", "(((a = b) <> c) = d)"],
    ["a < b = c", "((a < b) = c)"],
    ["a = b < c", "(a = (b < c))"],
    ["a <> b >= c", "(a <> (b >= c))"],
    ["a < b = c > d", "((a < b) = (c > d))"],
    ["a = b < c < d", "(a = ((b < c) < d))"],
    ["a < b = c = d", "(((a < b) = c) = d)"],
    ["a + 1 < b * 2 = c - 3", "(((a + 1) < (b * 2)) = (c - 3))"],
    ["a < b < c AND d", "(((a < b) < c) AND d)"],
    ["a = b = c OR a < b < c", "(((a = b) = c) OR ((a < b) < c))"],
    ["a XOR b = c < d", "(a XOR (b = (c < d)))"],
    ["NOT a = b < c", "((NOT a) = (b < c))"],
    ["a & b <> c > d", "(a AND (b <> (c > d)))"],
  ];
  for (const [src, expected] of cases) {
    it(`${src}  ->  ${expected}`, () => {
      expect(shape(rhs(src))).toBe(expected);
    });
  }

  it("keeps explicit parentheses", () => {
    expect(shape(rhs("(a = b) < c"))).toBe("([(a = b)] < c)");
    expect(shape(rhs("a < (b = c)"))).toBe("(a < [(b = c)])");
  });

  it("leaves single comparisons and other levels unchanged", () => {
    expect(shape(rhs("a < b"))).toBe("(a < b)");
    expect(shape(rhs("a = b"))).toBe("(a = b)");
    expect(shape(rhs("a + b * c - d"))).toBe("((a + (b * c)) - d)");
    expect(shape(rhs("a < b AND c = d OR a XOR b"))).toBe(
      "(((a < b) AND (c = d)) OR (a XOR b))",
    );
    expect(shape(rhs("a ** b"))).toBe("(a ** b)");
  });

  it("spans each comparison from its first operand to its last", () => {
    const expr = rhs("a < b = c");
    expect(expr.kind).toBe("BinaryExpression");
    if (expr.kind !== "BinaryExpression") return;
    const inner = expr.left;
    // "r := " occupies columns 1-5 on line 3, so `a` starts at column 6.
    expect(inner.sourceSpan.startLine).toBe(3);
    expect(inner.sourceSpan.startCol).toBe(6);
    expect(inner.sourceSpan.endCol).toBe(10);
    expect(expr.sourceSpan.startCol).toBe(6);
    expect(expr.sourceSpan.endCol).toBe(14);
  });
});
