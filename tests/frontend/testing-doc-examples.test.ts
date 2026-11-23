// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * The test-file examples in docs/TESTING.md parse as written.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { parseTestFile } from "../../src/testing/test-parser.js";

const DOC = fs.readFileSync(
  path.join(__dirname, "../../docs/TESTING.md"),
  "utf8",
);

/** Every fenced block that holds a TEST block. */
const examples = [...DOC.matchAll(/```[a-z]*\n([\s\S]*?)```/g)]
  .map((m) => m[1]!)
  .filter((block) => /^TEST\b/m.test(block));

describe("docs/TESTING.md examples", () => {
  it("has examples", () => {
    expect(examples.length).toBeGreaterThan(3);
  });
  it("takes a TEST name in either quote form, as it says", () => {
    expect(DOC).toContain("`TEST 'name'` or `TEST \"name\"`");
    for (const name of ["'name'", '"name"']) {
      const { testFile, errors } = parseTestFile(
        `TEST ${name}\n  ASSERT_TRUE(TRUE);\nEND_TEST\n`,
        "quotes.st",
      );
      expect(errors.map((e) => e.message)).toEqual([]);
      expect(testFile?.testCases.map((t) => t.name)).toEqual(["name"]);
    }
  });
  for (const [i, block] of examples.entries()) {
    it(`parses example ${i + 1}`, () => {
      const { errors } = parseTestFile(block, `example${i + 1}.st`);
      expect(errors.map((e) => e.message)).toEqual([]);
    });
  }
});
