// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * The ST an IL body becomes is laid out on the IL lines it comes from, so a
 * diagnostic inside an IL body points at the IL source line: a statement's
 * own at the instruction that ends it (the store), one at an operand at the
 * instruction naming that operand. Straight-line bodies and CASE state
 * machines (labels, jumps) alike.
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
  it("reports a straight-line body's errors at the IL operand", () => {
    expect(at(STRAIGHT + AFTER)).toEqual([
      "10: Cannot assign STRING to INT",
      "15: Cannot assign STRING to INT",
    ]);
  });

  it("reports a state machine's errors at their IL operands", () => {
    expect(at(JUMPS + AFTER)).toEqual([
      "8: Cannot assign STRING to INT",
      "11: Undeclared variable 'undeclaredX'",
      "16: Cannot assign STRING to INT",
    ]);
  });

  it("moves an operand's error to its instruction, a store's stays at the store", () => {
    const src = `FUNCTION_BLOCK FB_Op
VAR_INPUT q : INT; END_VAR
VAR n : INT; END_VAR
  LD q
  ADD undeclaredY
  ST n
  LD q
  ST undeclaredZ
END_FUNCTION_BLOCK
`;
    expect(
      compile(src, { fileName: "il.st" }).errors.map(
        (e) => `${e.line}:${e.column} ${e.message}`,
      ),
    ).toEqual([
      "5:7 Undeclared variable 'undeclaredY'",
      "8:6 Undeclared variable 'undeclaredZ'",
    ]);
  });

  it("places an operand's column after its label and operator, outside comments", () => {
    const src = `FUNCTION_BLOCK FB_Col
VAR q : INT; END_VAR
  LD d
  ST q
  LD (* undJ *) undJ
  ST q
undK: LD undK
  ST q
  CAL undFb(IN := undF)
  JMP undK
END_FUNCTION_BLOCK
`;
    expect(
      compile(src, { fileName: "il.st" })
        .errors.map((e) => `${e.line}:${e.column} ${e.message}`)
        .sort(),
    ).toEqual([
      "3:6 Undeclared variable 'd'",
      "5:17 Undeclared variable 'undJ'",
      "7:10 Undeclared variable 'undK'",
      "9:19 Undeclared variable 'undF'",
      "9:7 Undeclared function 'undFb'",
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
