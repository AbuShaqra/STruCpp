// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * A TEST name is a string literal: its `$` escapes (Ed. 3 Table 6) and doubled
 * quotes are decoded, in single and double quotes, and the decoded name is
 * what the test runner prints.
 */
import { describe, it, expect } from "vitest";
import { parseTestFile } from "../../src/index.js";
import { decodeStringLiteral } from "../../src/literal-utils.js";
import { hasGpp, runE2ETestPipeline } from "./test-helpers.js";

describe("decodeStringLiteral", () => {
  it("decodes the escapes of each quote", () => {
    expect(decodeStringLiteral("'it$'s'")).toBe("it's");
    expect(decodeStringLiteral("'a$$b'")).toBe("a$b");
    expect(decodeStringLiteral("'say $\"hi$\"'")).toBe('say "hi"');
    expect(decodeStringLiteral("'two$Nlines'")).toBe("two\nlines");
    expect(decodeStringLiteral("'tab$t$R$L$P'")).toBe("tab\t\r\n\f");
    expect(decodeStringLiteral("'hex $41'")).toBe("hex A");
    expect(decodeStringLiteral("'don''t'")).toBe("don't");
    expect(decodeStringLiteral('"wide $20AC $""')).toBe('wide € "');
  });
});

describe("TEST names", () => {
  it("are decoded when parsed", () => {
    const parsed = parseTestFile(
      `TEST 'it$'s $$5'\nASSERT_TRUE(TRUE);\nEND_TEST\nTEST "say $"hi$""\nASSERT_TRUE(TRUE);\nEND_TEST\n`,
      "t.st",
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.testFile!.testCases.map((t) => t.name)).toEqual([
      "it's $5",
      'say "hi"',
    ]);
  });
});

describe.skipIf(!hasGpp)("TEST names — g++ e2e", () => {
  it("prints the decoded name", () => {
    const { stdout, exitCode } = runE2ETestPipeline({
      sourceST: `PROGRAM Counter\nVAR count : INT; END_VAR\ncount := count + 1;\nEND_PROGRAM\n`,
      testST: `TEST 'it$'s $$5 "ok"'\nVAR uut : Counter; END_VAR\nuut();\nASSERT_EQ(uut.count, 1);\nEND_TEST\nTEST "wide $0041 name"\nASSERT_TRUE(TRUE);\nEND_TEST\n`,
      testFileName: "test_names.st",
      tempDirPrefix: "strucpp-test-names-",
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`[PASS] it's $5 "ok"`);
    expect(stdout).toContain("[PASS] wide A name");
  });
});
