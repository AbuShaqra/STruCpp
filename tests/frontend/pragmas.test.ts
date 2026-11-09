// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * Pragmas `{ ... }` (IEC 61131-3 Ed.3, 6.2 / Table 4): skipped like
 * whitespace with a "pragma ignored" warning; conditional-compilation
 * pragmas are errors; `{external ...}` keeps its own token.
 */

import { describe, it, expect } from "vitest";
import { compile, analyze } from "../../src/index.js";
import { tokenize } from "../../src/frontend/lexer.js";
import { parse as parseCst } from "../../src/frontend/parser.js";
import type { CompileError } from "../../src/types.js";

const PLAIN = `PROGRAM Main
VAR
  x : INT;
  y : INT;
END_VAR
x := 1 + 2;
y := x;
END_PROGRAM
`;

function pragmaWarnings(list: ReadonlyArray<CompileError>): CompileError[] {
  return list.filter((w) => /pragma ignored/i.test(w.message));
}

function errorsOf(source: string): CompileError[] {
  return compile(source).errors;
}

describe("pragma lexing", () => {
  it("a pragma is trivia: no token, no error", () => {
    const r = tokenize("{attribute 'hide'} VAR");
    expect(r.errors).toEqual([]);
    expect(r.tokens.map((t) => t.tokenType.name)).toEqual(["VAR"]);
  });

  it("a multi-line pragma is one pragma and keeps line counting right", () => {
    const r = tokenize("{text\n line two\n line three}\nVAR");
    expect(r.errors).toEqual([]);
    expect(r.tokens).toHaveLength(1);
    expect(r.tokens[0]).toMatchObject({ startLine: 4, startColumn: 1 });
  });

  it("the first '}' ends a pragma; pragmas do not nest", () => {
    const r = tokenize("{a {b} c} VAR");
    expect(r.tokens.map((t) => t.tokenType.name)).toContain("VAR");
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ line: 1, column: 9 });
    expect(r.errors[0]!.message).toMatch(/'}'/);
  });

  it("braces inside a string literal are not a pragma", () => {
    const r = tokenize("s := '{attribute x}';");
    expect(r.errors).toEqual([]);
    expect(r.tokens.map((t) => t.tokenType.name)).toContain("StringLiteral");
    expect(r.groups.pragmas ?? []).toHaveLength(0);
  });

  it("braces inside comments are not a pragma", () => {
    const r = tokenize("(* {IF x} *) // {define y}\nVAR");
    expect(r.errors).toEqual([]);
    expect(r.groups.pragmas ?? []).toHaveLength(0);
  });

  it("an unterminated '{' is a lexer error at its real position", () => {
    const r = tokenize("VAR\n  x : INT; {attribute 'a'\nEND_VAR");
    const err = r.errors.find((e) => /unterminated pragma/i.test(e.message));
    expect(err).toMatchObject({ line: 2, column: 12 });
  });

  it("{external ...} is still its own token", () => {
    const r = tokenize("{external int x = 0; }");
    expect(r.errors).toEqual([]);
    expect(r.tokens.map((t) => t.tokenType.name)).toEqual(["ExternalPragma"]);
  });

  it("conditional-compilation pragmas are lexer errors, any case", () => {
    for (const p of [
      "{IF defined(X)}",
      "{elsif defined(Y)}",
      "{ELSE}",
      "{ END_IF }",
      "{define X}",
      "{Undefine X}",
    ]) {
      const r = tokenize(`x := 1; ${p}\ny := 2;`);
      expect(r.errors, p).toHaveLength(1);
      expect(r.errors[0]!.message).toMatch(
        /conditional compilation pragmas are not supported/i,
      );
      expect(r.errors[0]).toMatchObject({ line: 1, column: 9 });
    }
  });

  it("a word that only starts like a conditional keyword is a plain pragma", () => {
    const r = tokenize("{IFDEF_NOTE} {elsewhere} VAR");
    expect(r.errors).toEqual([]);
  });

  it("the parser sees through pragmas and reports them", () => {
    const res = parseCst("{A} PROGRAM Main {B} END_PROGRAM");
    expect(res.errors).toEqual([]);
    expect(res.pragmas.map((p) => p.image)).toEqual(["{A}", "{B}"]);
  });
});

describe("pragmas in programs", () => {
  const placements: Array<[string, string]> = [
    ["before a declaration", `{attribute 'scoped'}\n${PLAIN}`],
    [
      "inside a VAR block",
      PLAIN.replace("  y : INT;", "  {attribute 'hide'}\n  y : INT;"),
    ],
    [
      "before a statement",
      PLAIN.replace("y := x;", "{warning 'check this'}\ny := x;"),
    ],
    ["mid-expression", PLAIN.replace("1 + 2", "1 + {note} 2")],
    ["at end of file", `${PLAIN}{end of file note}`],
    [
      "multi-line",
      PLAIN.replace("y := x;", "{a pragma\n  over two lines}\ny := x;"),
    ],
  ];

  for (const [name, source] of placements) {
    it(`${name}: compiles with one warning`, () => {
      const result = compile(source);
      expect(result.errors).toEqual([]);
      expect(result.success).toBe(true);
      expect(pragmaWarnings(result.warnings)).toHaveLength(1);
    });
  }

  it("generated code is the same as without the pragmas", () => {
    const withPragmas = compile(placements[1]![1]);
    const without = compile(PLAIN);
    expect(withPragmas.cppCode).toBe(without.cppCode);
    expect(withPragmas.headerCode).toBe(without.headerCode);
  });

  it("the warning carries line, column, file and the pragma text", () => {
    const src = PLAIN.replace("y := x;", "  {attribute 'hide'} y := x;");
    const result = compile(src, { fileName: "p.st" });
    const [w] = pragmaWarnings(result.warnings);
    expect(w).toMatchObject({
      line: 7,
      column: 3,
      severity: "warning",
      file: "p.st",
    });
    expect(w!.message).toContain("{attribute 'hide'}");
  });

  it("long pragma text is shortened in the warning", () => {
    const long = `{${"x".repeat(200)}}`;
    const result = compile(`${long}\n${PLAIN}`);
    const [w] = pragmaWarnings(result.warnings);
    expect(w).toBeDefined();
    expect(w!.message.length).toBeLessThan(120);
  });

  it("is accepted under --dialect iec-3", () => {
    const result = compile(`{attribute 'x'}\n${PLAIN}`, { dialect: "iec-3" });
    expect(result.errors).toEqual([]);
    expect(pragmaWarnings(result.warnings)).toHaveLength(1);
  });

  it("analyze reports the warning too", () => {
    const result = analyze(`{attribute 'x'}\n${PLAIN}`);
    expect(pragmaWarnings(result.warnings)).toHaveLength(1);
  });

  it("an additional source file's pragma warning names that file", () => {
    const result = compile(PLAIN, {
      fileName: "main.st",
      additionalSources: [
        {
          fileName: "lib.st",
          source: "{attribute 'x'}\nFUNCTION F : INT\nF := 1;\nEND_FUNCTION\n",
        },
      ],
    });
    expect(result.errors).toEqual([]);
    expect(pragmaWarnings(result.warnings)).toMatchObject([
      { file: "lib.st", line: 1, column: 1 },
    ]);
  });

  it("a conditional pragma fails the compile with its position", () => {
    const src = PLAIN.replace("y := x;", "{IF defined(SIM)}\ny := x;\n{END_IF}");
    const errs = errorsOf(src);
    expect(errs.map((e) => [e.line, e.column])).toEqual([
      [7, 1],
      [9, 1],
    ]);
    for (const e of errs) {
      expect(e.message).toMatch(/conditional compilation pragmas are not supported/i);
    }
    expect(errs[0]!.message).toContain("{IF defined(SIM)}");
    const result = compile(src);
    expect(pragmaWarnings(result.warnings)).toEqual([]);
  });

  it("an unterminated pragma fails the compile with its position", () => {
    const errs = errorsOf(PLAIN.replace("y := x;", "y := x; {oops"));
    expect(errs[0]).toMatchObject({ line: 7, column: 9, severity: "error" });
    expect(errs[0]!.message).toMatch(/unterminated pragma/i);
  });
});
