// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * Diagnostic positions for lexer and parser errors on every entry path
 * (compile, analyze, parse, library compile, test parser), and parsing that
 * continues after a lexer error.
 */

import { describe, it, expect } from "vitest";
import { compile, analyze, parse } from "../../src/index.js";
import { compileStlib } from "../../src/library/library-compiler.js";
import { parseTestFile } from "../../src/testing/test-parser.js";
import { toCompileErrors } from "../../src/frontend/parse-errors.js";
import { tokenize } from "../../src/frontend/lexer.js";
import { parse as parseCst } from "../../src/frontend/parser.js";

/** `$` on line 3, column 8 is not a token. */
const LEX_BAD = `PROGRAM Main
VAR x : INT; END_VAR
x := 1 $ 2;
END_PROGRAM
`;

/** A lexer error on line 3 and an undeclared variable on line 4. */
const LEX_AND_SEMANTIC = `PROGRAM Main
VAR x : INT; END_VAR
x := 1 $;
x := undeclaredThing;
END_PROGRAM
`;

/** The file ends before END_PROGRAM; the last token is on line 3. */
const EOF_BAD = `PROGRAM Main
VAR x : INT; END_VAR
x := 1;
`;

const LIB_SEMANTIC = `FUNCTION F : INT
VAR_INPUT a : INT; END_VAR
F := zz;
END_FUNCTION
`;

const LIB_LEX_BAD = `FUNCTION F : INT
VAR_INPUT a : INT; END_VAR
F := a $ 1;
END_FUNCTION
`;

const LIB_OPTS = { name: "l", version: "1.0.0", namespace: "l" };

function lexerErrorOf(errors: ReadonlyArray<{ message: string }>) {
  return errors.find((e) => e.message.includes("unexpected character"));
}

describe("toCompileErrors", () => {
  it("converts a lexer error with its 1-based line and column and the file", () => {
    const lex = tokenize(LEX_BAD);
    expect(lex.errors).toHaveLength(1);
    const [err] = toCompileErrors(lex.errors, "a.st");
    expect(err).toMatchObject({
      line: 3,
      column: 8,
      severity: "error",
      file: "a.st",
    });
  });

  it("omits the file when none is given", () => {
    const [err] = toCompileErrors(tokenize(LEX_BAD).errors);
    expect(err).toBeDefined();
    expect(err!.file).toBeUndefined();
  });

  it("places a parse error at EOF after the last token, never NaN or 0", () => {
    const { errors } = parseCst(EOF_BAD);
    const converted = toCompileErrors(errors, "a.st");
    expect(converted.length).toBeGreaterThan(0);
    for (const e of converted) {
      expect(Number.isFinite(e.line)).toBe(true);
      expect(Number.isFinite(e.column)).toBe(true);
      expect(e.line).toBe(3);
      expect(e.column).toBeGreaterThan(0);
    }
  });

  it("falls back to 1:1 for an EOF error with no tokens at all", () => {
    const converted = toCompileErrors(parseCst("").errors);
    for (const e of converted) {
      expect(e.line).toBe(1);
      expect(e.column).toBe(1);
    }
  });
});

describe("the parser runs after lexer errors", () => {
  it("returns a CST and the lexer error together", () => {
    const r = parseCst(LEX_BAD);
    expect(r.cst).not.toBeNull();
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

describe("lexer error positions on every path", () => {
  it("compile(): real line/column and file, and compile fails", () => {
    const r = compile(LEX_BAD, { fileName: "a.st" });
    expect(r.success).toBe(false);
    expect(lexerErrorOf(r.errors)).toMatchObject({
      line: 3,
      column: 8,
      file: "a.st",
    });
  });

  it("compile(): a lexer error in an additional source carries that file", () => {
    const clean = "PROGRAM P2\nVAR y : INT; END_VAR\ny := 1;\nEND_PROGRAM\n";
    const r = compile(clean, {
      fileName: "main.st",
      additionalSources: [{ source: LEX_BAD, fileName: "extra.st" }],
    });
    expect(r.success).toBe(false);
    expect(lexerErrorOf(r.errors)).toMatchObject({
      line: 3,
      column: 8,
      file: "extra.st",
    });
  });

  it("analyze(): real position and no 'no CST produced' error", () => {
    const r = analyze(LEX_BAD, { fileName: "a.st" });
    expect(lexerErrorOf(r.errors)).toMatchObject({
      line: 3,
      column: 8,
      file: "a.st",
    });
    expect(r.errors.some((e) => e.message.includes("no CST"))).toBe(false);
    expect(r.ast).toBeDefined();
  });

  it("analyze(): one bad token still yields the file's other diagnostics", () => {
    const r = analyze(LEX_AND_SEMANTIC, { fileName: "a.st" });
    expect(lexerErrorOf(r.errors)).toMatchObject({ line: 3, column: 8 });
    const undeclared = r.errors.find((e) =>
      e.message.toUpperCase().includes("UNDECLAREDTHING"),
    );
    expect(undeclared).toMatchObject({ line: 4 });
  });

  it("analyze(): an EOF parse error has a finite position", () => {
    const r = analyze(EOF_BAD, { fileName: "a.st" });
    expect(r.errors.length).toBeGreaterThan(0);
    for (const e of r.errors) {
      expect(Number.isFinite(e.line)).toBe(true);
      expect(Number.isFinite(e.column)).toBe(true);
    }
  });

  it("parse(): real lexer error position", () => {
    const r = parse(LEX_BAD);
    expect(r.ast).toBeUndefined();
    expect(lexerErrorOf(r.errors)).toMatchObject({ line: 3, column: 8 });
  });

  it("compileStlib(): lexer error with real line, column and file", () => {
    const r = compileStlib([{ source: LIB_LEX_BAD, fileName: "lib1.st" }], {
      ...LIB_OPTS,
    });
    expect(r.success).toBe(false);
    expect(lexerErrorOf(r.errors)).toMatchObject({
      line: 3,
      column: 8,
      file: "lib1.st",
    });
  });

  it("compileStlib(): a semantic error in the first file names that file and a column", () => {
    const r = compileStlib([{ source: LIB_SEMANTIC, fileName: "lib1.st" }], {
      ...LIB_OPTS,
    });
    expect(r.success).toBe(false);
    const err = r.errors.find((e) => e.message.includes("ZZ"));
    expect(err).toMatchObject({ line: 3, file: "lib1.st" });
    expect(err!.column).toBeGreaterThan(0);
  });

  it("parseTestFile(): real lexer error position and file", () => {
    const src = `TEST 'one'\n  ASSERT_TRUE(1 $ 1);\nEND_TEST\n`;
    const r = parseTestFile(src, "t.st");
    expect(r.testFile).toBeUndefined();
    expect(lexerErrorOf(r.errors)).toMatchObject({
      line: 2,
      column: 17,
      file: "t.st",
    });
  });
});
