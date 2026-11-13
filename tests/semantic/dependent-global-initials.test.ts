/** A global's initial value reading a non-CONSTANT global: ordered with no flag, refused under iec-3 and --strict. */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const SOURCE = `VAR_GLOBAL CONSTANT K : INT := 5; END_VAR
VAR_GLOBAL a : INT := b + 1; b : INT := K * 2; c, d : INT := K; END_VAR
PROGRAM Main VAR x : INT; END_VAR x := a; END_PROGRAM
`;

describe("dependent global initial values", () => {
  it("are ordered with no dialect flag", () => {
    expect(compile(SOURCE).errors).toEqual([]);
  });
  for (const [label, options] of [
    ["iec-3", { dialect: "iec-3" }],
    ["strict", { strict: true }],
  ] as const) {
    it(`are refused (${label})`, () => {
      expect(
        compile(SOURCE, options).errors.map(
          (e) => `${e.line}:${e.column} ${e.message}`,
        ),
      ).toEqual([
        "2:23 The initial value of global 'A' reads global 'B', which is no CONSTANT: an initial value is a constant expression",
      ]);
    });
  }
});
