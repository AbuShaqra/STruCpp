// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Test files: a misplaced underscore in a numeric literal (Ed. 3 Table 5) is
 * refused under iec-3 and --strict in declarations too (STRING lengths, ARRAY
 * bounds), spelled as written; --strict reaches test files; the check reads
 * the parser's tokens instead of lexing each source again.
 */
import { describe, it, expect } from "vitest";
import { compile, parseTestFile, analyzeTestFile } from "../../src/index.js";
import { parse } from "../../src/frontend/parser.js";
import { tokenize } from "../../src/frontend/lexer.js";
import { resolveDialect } from "../../src/dialect.js";

const SOURCE = `PROGRAM Main
VAR x : INT; END_VAR
x := 1;
END_PROGRAM
`;

const TEST = `TEST 'u'
VAR s : STRING[1__0]; a : ARRAY[0..1_] OF INT; t : TIME := T#1_ms; END_VAR
ASSERT_EQ(a[0], 0);
END_TEST
`;

const underscore = (spelling: string): string =>
  `An underscore in a numeric literal must stand between two digits (IEC 61131-3 Ed. 3): '${spelling}'`;

function testErrors(opts: { dialect?: string; strict?: boolean }): string[] {
  const src = compile(SOURCE, opts);
  expect(src.errors).toEqual([]);
  const parsed = parseTestFile(TEST, "t.st", opts);
  expect(parsed.errors).toEqual([]);
  return analyzeTestFile(
    parsed.testFile!,
    src.symbolTables!,
    src.ast,
    resolveDialect(opts),
    opts.strict,
  ).errors.map((e) => `${e.line}:${e.column}: ${e.message}`);
}

describe("literal underscores in test files", () => {
  const expected = [
    `2:16: ${underscore("1__0")}`,
    `2:36: ${underscore("1_")}`,
    `2:60: ${underscore("T#1_ms")}`,
  ];

  it("are refused in declarations under iec-3", () => {
    expect(testErrors({ dialect: "iec-3" })).toEqual(expected);
  });

  it("are refused under --strict, which reaches the test file", () => {
    expect(testErrors({ strict: true })).toEqual(expected);
  });

  it("are accepted by default", () => {
    expect(testErrors({})).toEqual([]);
  });
});

describe("the literal check reads the parser's tokens", () => {
  it("parse() hands back the lexer's tokens", () => {
    const text = "PROGRAM P\nVAR x : INT := 1_0; END_VAR\nEND_PROGRAM\n";
    const parsed = parse(text);
    expect(parsed.tokens.map((t) => t.image)).toEqual(
      tokenize(text).tokens.map((t) => t.image),
    );
  });
});
