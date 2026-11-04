/**
 * CONTINUE (IEC 61131-3 3rd edition): skips to the next iteration of the
 * innermost FOR, WHILE or REPEAT loop.
 */

import { describe, it, expect } from "vitest";
import { parse } from "../../src/frontend/parser.js";
import { buildAST } from "../../src/frontend/ast-builder.js";
import { compile } from "../../src/index.js";
import type { Statement } from "../../src/frontend/ast.js";

function prog(body: string, vars = "VAR i : INT; n : INT; END_VAR"): string {
  return `PROGRAM Main\n${vars}\n${body}\nEND_PROGRAM\n`;
}

function bodyOf(source: string): Statement[] {
  const parsed = parse(source);
  expect(parsed.errors).toHaveLength(0);
  return buildAST(parsed.cst!).programs[0]!.body;
}

function find(stmts: Statement[], kind: string): boolean {
  return stmts.some((s) => {
    if (s.kind === kind) return true;
    const sub = s as unknown as Record<string, unknown>;
    return Object.values(sub).some(
      (v) =>
        Array.isArray(v) &&
        v.length > 0 &&
        typeof (v[0] as { kind?: unknown }).kind === "string" &&
        find(v as Statement[], kind),
    );
  });
}

describe("CONTINUE statement", () => {
  it("parses inside FOR", () => {
    const body = bodyOf(prog("FOR i := 1 TO 5 DO CONTINUE; END_FOR;"));
    const loop = body[0] as { body: Statement[] };
    expect(loop.body[0]!.kind).toBe("ContinueStatement");
  });

  it("parses inside IF inside FOR", () => {
    const body = bodyOf(
      prog("FOR i := 1 TO 5 DO IF i = 3 THEN CONTINUE; END_IF; END_FOR;"),
    );
    expect(find(body, "ContinueStatement")).toBe(true);
  });

  it("parses inside CASE inside FOR", () => {
    const body = bodyOf(
      prog(
        "FOR i := 1 TO 5 DO CASE i OF 3: CONTINUE; ELSE n := 1; END_CASE; END_FOR;",
      ),
    );
    expect(find(body, "ContinueStatement")).toBe(true);
  });

  it("parses in lower case", () => {
    const body = bodyOf(
      prog("for i := 1 to 5 do continue; end_for;"),
    );
    expect(find(body, "ContinueStatement")).toBe(true);
  });

  it("compiles inside WHILE and REPEAT", () => {
    const w = compile(
      prog("WHILE n < 5 DO n := n + 1; CONTINUE; END_WHILE;"),
    );
    expect(w.errors.map((e) => e.message)).toEqual([]);
    const r = compile(
      prog("REPEAT n := n + 1; CONTINUE; UNTIL n > 5 END_REPEAT;"),
    );
    expect(r.errors.map((e) => e.message)).toEqual([]);
  });

  it("is an error outside a loop, naming its line", () => {
    const result = compile(prog("n := 1;\nCONTINUE;\nn := 2;"));
    expect(result.success).toBe(false);
    const err = result.errors.find((e) =>
      e.message.includes(
        "CONTINUE must be inside a FOR, WHILE or REPEAT loop",
      ),
    );
    expect(err).toBeDefined();
    expect(err!.line).toBe(4);
  });

  it("is an error in an IF outside any loop", () => {
    const result = compile(prog("IF n = 0 THEN CONTINUE; END_IF;"));
    expect(
      result.errors.some((e) =>
        e.message.includes("CONTINUE must be inside a FOR, WHILE or REPEAT loop"),
      ),
    ).toBe(true);
  });

  it("continue_as_identifier_gives_a_line_error", () => {
    const result = compile(
      prog("continue := 1;", "VAR continue : INT; END_VAR"),
    );
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]!.line).toBe(2);
  });
});
