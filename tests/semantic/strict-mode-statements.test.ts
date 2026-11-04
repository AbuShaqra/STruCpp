/**
 * --strict: reserved names, FOR bodies, discarded function results, statement
 * terminators and FB call parameters, which matiec rejected. Each case also
 * pins the non-strict result, so a rule that leaks out of strict mode fails.
 *
 * The lexer upper-cases identifiers, so names appear upper-case in messages.
 *
 */
import { describe, it, expect } from "vitest";
import { resolve } from "path";
import { compile } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";

const libraries = discoverStlibs(resolve(__dirname, "../../libs"));

function strict(source: string) {
  return compile(source, { strict: true, libraries });
}
function lax(source: string) {
  return compile(source, { libraries });
}
function msgs(source: string): string[] {
  return strict(source).errors.map((e) => `${e.line}: ${e.message}`);
}
function laxMsgs(source: string): string[] {
  return lax(source).errors.map((e) => `${e.line}: ${e.message}`);
}

/** A PROGRAM whose body starts on line 5. */
function prog(decls: string, body: string, pre = ""): string {
  return `${pre}PROGRAM main
  VAR
    ${decls}
  END_VAR
  ${body}
END_PROGRAM
`;
}

/** Strict result, and the same source compiling clean without --strict. */
function pin(source: string, expected: string[], laxExpected: string[] = []) {
  expect(msgs(source)).toEqual(expected);
  expect(laxMsgs(source)).toEqual(laxExpected);
}

const FB = `FUNCTION_BLOCK Cnt
  VAR_INPUT inc : INT; END_VAR
  VAR_OUTPUT q : INT; END_VAR
  q := inc;
END_FUNCTION_BLOCK
`;
const FN = `FUNCTION F : INT
  VAR_INPUT a : INT; END_VAR
  F := a;
END_FUNCTION
`;

describe("strict mode: row g, reserved names", () => {
  it("rejects a variable named ON, STEP or MOVE in any case", () => {
    pin(prog("on : BOOL;", "on := TRUE;"), ["3: ON is a reserved name"]);
    pin(prog("Step : BOOL;", "Step := TRUE;"), ["3: STEP is a reserved name"]);
    pin(prog("MOVE : BOOL;", "MOVE := TRUE;"), ["3: MOVE is a reserved name"]);
  });
  it("rejects an FB instance, a program, an FB, a type and an enum value", () => {
    pin(prog("on : TON;", ";"), ["3: ON is a reserved name"]);
    pin(`PROGRAM step\n  VAR x : INT; END_VAR\n  x := 1;\nEND_PROGRAM\n`, [
      "1: STEP is a reserved name",
    ]);
    pin(
      `FUNCTION_BLOCK move\n  VAR x : INT; END_VAR\n  x := 1;\nEND_FUNCTION_BLOCK\n`,
      ["1: MOVE is a reserved name"],
    );
    pin(prog("x : INT;", "x := 1;", "TYPE step : INT; END_TYPE\n"), [
      "1: STEP is a reserved name",
    ]);
    // `on` as a type name is already a syntax error without --strict.
    const onType = prog("x : INT;", "x := 1;", "TYPE on : INT; END_TYPE\n");
    expect(msgs(onType)).toEqual([
      "1: Expected `END_TYPE`, found `ON`.",
      "1: Expected `Colon`, found `;`.",
    ]);
    expect(laxMsgs(onType)).toEqual(msgs(onType));
    pin(prog("c : Col;", "c := Col.A;", "TYPE Col : (A, STEP); END_TYPE\n"), [
      "1: STEP is a reserved name",
    ]);
  });
  it("rejects a function named ON or STEP, and a method named MOVE", () => {
    pin(
      prog(
        "x : INT;",
        "x := 1;",
        "FUNCTION on : INT\n  VAR_INPUT a : INT; END_VAR\n  on := a;\nEND_FUNCTION\n",
      ),
      ["1: ON is a reserved name"],
    );
    pin(
      `FUNCTION_BLOCK Fb
  METHOD Move : INT
    Move := 1;
  END_METHOD
END_FUNCTION_BLOCK
`,
      ["2: MOVE is a reserved name"],
    );
  });
  it("accepts a function named MOVE, which matiec accepts", () => {
    const src = prog(
      "x : INT;",
      "x := 1;",
      "FUNCTION Move : INT\n  VAR_INPUT a : INT; END_VAR\n  Move := a;\nEND_FUNCTION\n",
    );
    expect(strict(src).errors).toEqual([]);
    expect(laxMsgs(src)).toEqual([]);
  });
  it("accepts names that only contain a reserved word", () => {
    const src = prog(
      "onoff : BOOL; stepper : INT; mover : INT;",
      "onoff := TRUE;",
    );
    expect(strict(src).errors).toEqual([]);
    expect(laxMsgs(src)).toEqual([]);
  });
});

describe("strict mode: row h, FOR body", () => {
  it("rejects a FOR loop with no statement, and one with only ';'", () => {
    pin(prog("k : INT;", "FOR k := 1 TO 3 DO\n  END_FOR;"), [
      "5: A FOR loop must have a body",
    ]);
    pin(prog("k : INT;", "FOR k := 1 TO 3 DO ; END_FOR;"), [
      "5: A FOR loop must have a body",
    ]);
  });
  it("accepts a FOR loop with a body", () => {
    const src = prog(
      "k : INT; y : INT;",
      "FOR k := 1 TO 3 DO y := k; END_FOR;",
    );
    expect(strict(src).errors).toEqual([]);
    expect(laxMsgs(src)).toEqual([]);
  });
});

describe("strict mode: row i, discarded function result", () => {
  it("rejects a function with a return type called as a statement", () => {
    pin(prog("k : INT;", "F(a := 1);", FN), [
      "9: The result of F is not used; assign it or use it in an expression",
    ]);
  });
  it("rejects a library function called as a statement", () => {
    pin(prog("k : INT;", "ABS(k);"), [
      "5: The result of ABS is not used; assign it or use it in an expression",
    ]);
  });
  it("accepts FB calls, method calls and used results", () => {
    const src =
      `FUNCTION_BLOCK Cnt
  VAR_INPUT inc : INT; END_VAR
  METHOD M : INT
    M := 1;
  END_METHOD
END_FUNCTION_BLOCK
` +
      FN +
      prog(
        "k : INT; t : TON; c : Cnt;",
        "t(IN := TRUE, PT := T#1s);\n  c(inc := 1);\n  c.M();\n  k := F(a := 1);",
      );
    expect(strict(src).errors).toEqual([]);
    expect(laxMsgs(src)).toEqual([]);
  });
});

describe("strict mode: row j, terminator after END_x", () => {
  const cases: Array<[string, string, string]> = [
    ["END_IF", "b : BOOL;", "IF b THEN b := FALSE; END_IF"],
    ["END_CASE", "k : INT;", "CASE k OF 1: k := 2; END_CASE"],
    ["END_FOR", "k : INT;", "FOR k := 1 TO 3 DO k := 1; END_FOR"],
    ["END_WHILE", "k : INT;", "WHILE k < 3 DO k := k + 1; END_WHILE"],
    ["END_REPEAT", "k : INT;", "REPEAT k := k + 1; UNTIL k > 3 END_REPEAT"],
  ];
  for (const [end, decls, body] of cases) {
    it(`rejects ${end} without ';' and accepts it with`, () => {
      const missing = prog(decls, body);
      // END_FOR with k := 1 assigns the control variable; fine for STruC++.
      expect(msgs(missing)).toEqual([`5: Missing ';' after ${end}`]);
      expect(laxMsgs(missing)).toEqual([]);
      const ok = prog(decls, body + ";");
      expect(strict(ok).errors).toEqual([]);
      expect(laxMsgs(ok)).toEqual([]);
    });
  }
  it("reports the line of the END_x keyword", () => {
    pin(prog("b : BOOL;", "IF b THEN\n    b := FALSE;\n  END_IF\n"), [
      "7: Missing ';' after END_IF",
    ]);
  });
  it("accepts ';' alone and an empty CASE element", () => {
    const src = prog("k : INT;", ";\n  CASE k OF 0: ; 1: k := 2; END_CASE;");
    expect(strict(src).errors).toEqual([]);
    expect(laxMsgs(src)).toEqual([]);
  });
});

describe("strict mode: row k, FB call parameters", () => {
  it("rejects an unknown input of a standard FB", () => {
    pin(prog("x : BOOL; r : R_TRIG;", "r(IN := x);"), [
      "5: R_TRIG has no input or output named IN",
    ]);
  });
  it("rejects an unknown parameter of TON and a unknown output", () => {
    pin(prog("t : TON; y : BOOL;", "t(IN := TRUE, PT := T#1s, FOO := 1);"), [
      "5: TON has no input or output named FOO",
    ]);
    pin(prog("t : TON; y : BOOL;", "t(IN := TRUE, PT := T#1s, ZZ => y);"), [
      "5: TON has no input or output named ZZ",
    ]);
  });
  it("rejects an unknown parameter of a user FB", () => {
    pin(prog("c : Cnt;", "c(zz := 1);", FB), [
      "10: CNT has no input or output named ZZ",
    ]);
  });
  it("accepts the FB's own inputs and outputs", () => {
    const src = prog(
      "x : BOOL; r : R_TRIG; c : Cnt; y : INT;",
      "r(CLK := x);\n  c(inc := 1, q => y);",
      FB,
    );
    expect(strict(src).errors).toEqual([]);
    expect(laxMsgs(src)).toEqual([]);
  });
  it("checks an inherited input", () => {
    const src =
      FB +
      `FUNCTION_BLOCK Sub EXTENDS Cnt\nEND_FUNCTION_BLOCK\n` +
      prog("s : Sub;", "s(inc := 1);\n  s(nope := 1);");
    expect(msgs(src)).toEqual(["13: SUB has no input or output named NOPE"]);
    expect(laxMsgs(src)).toEqual([]);
  });
});

describe("strict mode: row l, duplicate CASE labels", () => {
  // matiec only warns about these, but the C++ build fails with
  // "duplicate case value", so strict mode reports them at their ST line.
  it("rejects a repeated integer label at the repeat's line", () => {
    pin(
      prog(
        "k : INT;",
        "CASE k OF\n    1: k := 2;\n    1: k := 3;\n  END_CASE;",
      ),
      ["7: Duplicate CASE label 1"],
    );
  });
  it("expands ranges", () => {
    pin(prog("k : INT;", "CASE k OF 1, 1..3: k := 2; END_CASE;"), [
      "5: Duplicate CASE label 1",
    ]);
    pin(prog("k : INT;", "CASE k OF 1..3: k := 2;\n 2..4: k := 3; END_CASE;"), [
      "6: Duplicate CASE label 2",
      "6: Duplicate CASE label 3",
    ]);
  });
  it("rejects a repeated negative label", () => {
    pin(prog("k : INT;", "CASE k OF -1: k := 2; -1: k := 3; END_CASE;"), [
      "5: Duplicate CASE label -1",
    ]);
  });
  it("rejects a repeated enum label, bare or qualified", () => {
    const pre = "TYPE Col : (AA, BB); END_TYPE\n";
    pin(
      prog("c : Col;", "CASE c OF AA: c := BB;\n AA: c := BB; END_CASE;", pre),
      ["7: Duplicate CASE label AA"],
    );
    pin(
      prog(
        "c : Col;",
        "CASE c OF AA: c := BB;\n Col.AA: c := BB; END_CASE;",
        pre,
      ),
      ["7: Duplicate CASE label AA"],
    );
  });
  it("accepts distinct labels, disjoint ranges and an ELSE", () => {
    const src = prog(
      "k : INT;",
      "CASE k OF 1: k := 2; 2..4: k := 3; 5, 7: k := 1; ELSE k := 0; END_CASE;",
    );
    expect(strict(src).errors).toEqual([]);
    expect(laxMsgs(src)).toEqual([]);
  });
  it("non-strict is unchanged (the duplicate only fails in the C++ build)", () => {
    const src = prog("k : INT;", "CASE k OF 1: k := 2; 1: k := 3; END_CASE;");
    expect(laxMsgs(src)).toEqual([]);
  });
});

describe("strict mode: {external} blocks are not checked inside", () => {
  it("does not look at END_IF or names inside the block", () => {
    const src = prog(
      "k : INT;",
      "{external IF on THEN FOR step := 1 TO 3 DO END_FOR END_IF }\n  k := 1;",
    );
    expect(strict(src).errors).toEqual([]);
    expect(laxMsgs(src)).toEqual([]);
  });
});
