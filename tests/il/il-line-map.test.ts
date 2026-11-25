// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * The ST an IL body becomes is laid out on the IL lines it comes from, so a
 * diagnostic inside an IL body points at the IL source line: straight-line
 * bodies and CASE state machines (labels, jumps) alike.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { transpileILSource } from "../../src/il/il-transpiler.js";

const STRAIGHT = `FUNCTION_BLOCK FB_Il
VAR_INPUT a : INT; END_VAR
VAR_OUTPUT q : INT; END_VAR
VAR s : STRING; END_VAR
  LD a
  ADD 1
  ST q

  (* a comment *)
  LD s
  ST q
END_FUNCTION_BLOCK
`;

const JUMPS = `FUNCTION_BLOCK FB_Jmp
VAR_INPUT a : INT; END_VAR
VAR_OUTPUT q : INT; END_VAR
VAR s : STRING; END_VAR
  LD a
  GT 3
  JMPC skip
  LD s
  ST q
skip:
  LD undeclaredX
  ST q
END_FUNCTION_BLOCK
`;

const AFTER = `PROGRAM Main
VAR x : INT; END_VAR
x := 'abc';
END_PROGRAM
`;

const at = (src: string): string[] =>
  compile(src, { fileName: "il.st" })
    .errors.map((e) => `${e.line}: ${e.message}`)
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

describe("IL to ST line map", () => {
  it("reports a straight-line body's error at the IL store", () => {
    expect(at(STRAIGHT + AFTER)).toEqual([
      "11: Cannot assign STRING to INT",
      "15: Cannot assign STRING to INT",
    ]);
  });

  it("reports a state machine's errors at their IL lines", () => {
    expect(at(JUMPS + AFTER)).toEqual([
      "9: Cannot assign STRING to INT",
      "12: Undeclared variable 'undeclaredX'",
      "16: Cannot assign STRING to INT",
    ]);
  });

  it("keeps each POU's line count", () => {
    for (const il of [STRAIGHT, JUMPS]) {
      const result = transpileILSource(il + AFTER, "il.st");
      expect(result.stSource.split("\n").length).toBe(
        (il + AFTER).split("\n").length,
      );
    }
  });
});
