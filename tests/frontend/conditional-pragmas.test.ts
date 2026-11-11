// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * Conditional pragmas: the line-preserving source pass on its own
 * (applyConditionalPragmas), with the program and the test lexer.
 */

import { describe, it, expect } from "vitest";
import {
  applyConditionalPragmas,
  sourcePrepFor,
  type PragmaDirectiveError,
} from "../../src/frontend/conditional-pragmas.js";
import {
  hasConditionalPragma,
  tokenize,
  tokenizeTest,
} from "../../src/frontend/lexer.js";
import { resolveDialect } from "../../src/dialect.js";

function defs(o: Record<string, string> = {}): Map<string, string> {
  return new Map(Object.entries(o).map(([k, v]) => [k.toUpperCase(), v]));
}

function run(
  src: string,
  o: Record<string, string> = {},
): { text: string; errors: PragmaDirectiveError[] } {
  return applyConditionalPragmas(src, defs(o), tokenize);
}

/** The non-blank lines of the result, trimmed. */
function kept(src: string, o: Record<string, string> = {}): string[] {
  return run(src, o)
    .text.split(/\r\n|\n|\r/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

function errs(src: string, o: Record<string, string> = {}): string[] {
  return run(src, o).errors.map((e) => `${e.line}:${e.column} ${e.message}`);
}

function lineBreaks(s: string): string[] {
  return s.match(/\r\n|\n|\r/g) ?? [];
}

describe("fast path", () => {
  it("returns the identical string when no directive is present", () => {
    const src = "PROGRAM P\n{attribute 'x'}\nEND_PROGRAM\n";
    const r = run(src);
    expect(r.text).toBe(src);
    expect(r.errors).toEqual([]);
  });

  it("returns the identical string when the only hit is in a comment or string", () => {
    const src = "(* {IF defined(X)} *)\ns := '{END_IF}'; // {ELSE}\n";
    expect(hasConditionalPragma(src)).toBe(true);
    const r = run(src);
    expect(r.text).toBe(src);
    expect(r.errors).toEqual([]);
  });

  it("an {IF} inside {external} is not a directive", () => {
    const src = "{external {IF x} }\nx := 1;\n";
    const r = run(src);
    expect(r.text).toBe(src);
    expect(r.errors).toEqual([]);
  });
});

describe("line preservation", () => {
  const SRC =
    "a := 1;\n{IF defined(SIM)}\nb := 2;\n{ELSE}\nc := 3;\n{END_IF}\nd := 4;\n";

  it("keeps length, line count and the active text", () => {
    for (const o of [{}, { SIM: "" }]) {
      const r = run(SRC, o);
      expect(r.text.length).toBe(SRC.length);
      expect(lineBreaks(r.text)).toEqual(lineBreaks(SRC));
    }
    expect(kept(SRC, { SIM: "" })).toEqual(["a := 1;", "b := 2;", "d := 4;"]);
    expect(kept(SRC)).toEqual(["a := 1;", "c := 3;", "d := 4;"]);
  });

  it("keeps CRLF and lone CR line endings", () => {
    const crlf = SRC.replace(/\n/g, "\r\n");
    const cr = SRC.replace(/\n/g, "\r");
    for (const s of [crlf, cr]) {
      const r = run(s);
      expect(r.text.length).toBe(s.length);
      expect(lineBreaks(r.text)).toEqual(lineBreaks(s));
      expect(kept(s)).toEqual(["a := 1;", "c := 3;", "d := 4;"]);
    }
  });

  it("keeps columns after an {END_IF} on the same line", () => {
    const src = "{IF defined(X)} a := 1; {END_IF} b := 2;";
    const r = run(src);
    expect(r.text.indexOf("b := 2;")).toBe(src.indexOf("b := 2;"));
    expect(r.text.trim()).toBe("b := 2;");
  });

  it("blanks tabs and surrogate pairs unit for unit", () => {
    const src = "{IF defined(X)}\n\tс := '\u{1F600}';\n{END_IF}\n\tz := 1;";
    const r = run(src);
    expect(r.text.length).toBe(src.length);
    expect(r.text.indexOf("z := 1;")).toBe(src.indexOf("z := 1;"));
    expect(r.text.split("\n")[1]).toBe(" ".repeat(src.split("\n")[1]!.length));
  });

  it("a multi-line directive keeps its line breaks", () => {
    const src = "{IF defined(A)\n   OR defined(B)}\nx := 1;\n{END_IF}\ny := 2;";
    const r = run(src, { B: "" });
    expect(lineBreaks(r.text)).toEqual(lineBreaks(src));
    expect(kept(src, { B: "" })).toEqual(["x := 1;", "y := 2;"]);
    expect(kept(src)).toEqual(["y := 2;"]);
  });

  it("never cuts a comment or a string in a dead branch", () => {
    const src =
      "{IF defined(X)}\n(* {END_IF} *) s := '{ELSE}';\n{END_IF}\nk := 1;";
    expect(kept(src)).toEqual(["k := 1;"]);
    expect(run(src).errors).toEqual([]);
  });
});

describe("branch selection", () => {
  const CHAIN = [
    "{IF defined(A)}",
    "a;",
    "{ELSIF defined(B)}",
    "b;",
    "{ELSIF defined(C)}",
    "c;",
    "{ELSE}",
    "e;",
    "{END_IF}",
  ].join("\n");

  it("takes the first true branch of an ELSIF chain", () => {
    expect(kept(CHAIN, { A: "", B: "" })).toEqual(["a;"]);
    expect(kept(CHAIN, { B: "", C: "" })).toEqual(["b;"]);
    expect(kept(CHAIN, { C: "" })).toEqual(["c;"]);
    expect(kept(CHAIN)).toEqual(["e;"]);
  });

  it("an IF without ELSE keeps nothing when false", () => {
    expect(kept("{IF defined(A)}\na;\n{END_IF}\n")).toEqual([]);
  });

  it("nests three deep", () => {
    const src = [
      "{IF defined(A)}",
      "a1;",
      "{IF defined(B)}",
      "b1;",
      "{IF defined(C)}",
      "c1;",
      "{ELSE}",
      "c2;",
      "{END_IF}",
      "b2;",
      "{ELSE}",
      "b3;",
      "{END_IF}",
      "a2;",
      "{END_IF}",
      "z;",
    ].join("\n");
    expect(kept(src, { A: "", B: "", C: "" })).toEqual([
      "a1;",
      "b1;",
      "c1;",
      "b2;",
      "a2;",
      "z;",
    ]);
    expect(kept(src, { A: "", B: "" })).toEqual([
      "a1;",
      "b1;",
      "c2;",
      "b2;",
      "a2;",
      "z;",
    ]);
    expect(kept(src, { A: "" })).toEqual(["a1;", "b3;", "a2;", "z;"]);
    expect(kept(src)).toEqual(["z;"]);
  });

  it("a true inner condition inside a dead outer branch stays dead", () => {
    const src =
      "{IF defined(A)}\n{IF defined(B)}\nb;\n{ELSE}\nnb;\n{END_IF}\n{END_IF}\nz;";
    expect(kept(src, { B: "" })).toEqual(["z;"]);
    expect(kept(src)).toEqual(["z;"]);
  });

  it("works with the test lexer too", () => {
    const src =
      "TEST 't'\n{IF defined(A)}\nASSERT_TRUE(TRUE);\n{END_IF}\nEND_TEST\n";
    const r = applyConditionalPragmas(src, defs(), tokenizeTest);
    expect(r.errors).toEqual([]);
    expect(r.text).not.toContain("ASSERT_TRUE");
    expect(r.text.length).toBe(src.length);
  });
});

describe("operators", () => {
  const cases: Array<[string, Record<string, string>, boolean]> = [
    ["defined(A)", { A: "" }, true],
    ["defined(A)", {}, false],
    ["defined(a)", { A: "" }, true],
    ["DEFINED(A)", { a: "" }, true],
    ["project_defined(A)", { A: "" }, true],
    ["project_defined(A)", {}, false],
    ["hasvalue(M, 'fast')", { M: "fast" }, true],
    ["hasvalue(M, 'fast')", { M: "Fast" }, false],
    ["hasvalue(M, 'fast')", { M: "" }, false],
    ["hasvalue(M, '')", { M: "" }, true],
    ["hasvalue(M, 'fast')", {}, false],
    ["HASVALUE(m, 'x')", { M: "x" }, true],
    ["NOT defined(A)", {}, true],
    ["not defined(A)", { A: "" }, false],
    ["NOT NOT defined(A)", { A: "" }, true],
    ["defined(A) AND defined(B)", { A: "", B: "" }, true],
    ["defined(A) AND defined(B)", { A: "" }, false],
    ["defined(A) and defined(B)", { B: "" }, false],
    ["defined(A) OR defined(B)", { B: "" }, true],
    ["defined(A) or defined(B)", {}, false],
    // AND binds tighter than OR; NOT tighter than AND
    ["defined(A) OR defined(B) AND defined(C)", { A: "" }, true],
    ["(defined(A) OR defined(B)) AND defined(C)", { A: "" }, false],
    ["NOT defined(A) AND defined(B)", { B: "" }, true],
    ["NOT (defined(A) AND defined(B))", { A: "", B: "" }, false],
    ["NOT (defined(A) AND defined(B))", { A: "" }, true],
  ];
  it.each(cases)("%s with %j is %s", (cond, o, expected) => {
    const src = `{IF ${cond}}\nyes;\n{ELSE}\nno;\n{END_IF}\n`;
    expect(errs(src, o)).toEqual([]);
    expect(kept(src, o)).toEqual([expected ? "yes;" : "no;"]);
  });
});

describe("errors", () => {
  it("structural errors at the directive", () => {
    expect(errs("x;\n{END_IF}\n")).toEqual([
      "2:1 {END_IF} without a matching {IF}",
    ]);
    expect(errs("  {ELSIF defined(A)}\n")).toEqual([
      "1:3 {ELSIF} without a matching {IF}",
    ]);
    expect(errs("{ELSE}")).toEqual(["1:1 {ELSE} without a matching {IF}"]);
    expect(
      errs("{IF defined(A)}\n{ELSE}\n{ELSIF defined(B)}\n{END_IF}"),
    ).toEqual(["3:1 {ELSIF} after {ELSE}"]);
    expect(errs("{IF defined(A)}\n{ELSE}\n {ELSE}\n{END_IF}")).toEqual([
      "3:2 second {ELSE} in one {IF}",
    ]);
  });

  it("an unterminated {IF} is reported at the IF and closed at EOF", () => {
    const src = "a;\n  {IF defined(A)}\nb;\n";
    expect(errs(src)).toEqual(["2:3 {IF} has no matching {END_IF}"]);
    expect(kept(src)).toEqual(["a;"]);
    expect(errs("{IF defined(A)}\n{IF defined(B)}\n")).toEqual([
      "1:1 {IF} has no matching {END_IF}",
      "2:1 {IF} has no matching {END_IF}",
    ]);
  });

  it("{define} and {undefine} are refused and blanked", () => {
    const src = "{define X}\n {undefine Y}\nz;";
    expect(errs(src)).toEqual([
      "1:1 {define} is not supported; pass defines with -D",
      "2:2 {undefine} is not supported; pass defines with -D",
    ]);
    expect(kept(src)).toEqual(["z;"]);
  });

  it("refused operators at the operator's column", () => {
    for (const [cond, op] of [
      ["defined(variable:x)", "defined(variable:...)"],
      ["defined(type:T)", "defined(type:...)"],
      ["defined(pou:P)", "defined(pou:...)"],
      ["hasattribute(pou:P, 'a')", "hasattribute"],
      ["hastype(variable:x, INT)", "hastype"],
      ["hasconstantvalue(c, 1, =)", "hasconstantvalue"],
      ["hasconstanttype(c, INT)", "hasconstanttype"],
    ]) {
      expect(errs(`x;\n{IF defined(A) OR ${cond}}\n{END_IF}`)).toEqual([
        `2:19 Conditional pragma operator '${op}' is not supported`,
      ]);
    }
  });

  it("unknown operators and a bad defined kind", () => {
    expect(errs("{IF frobnicate(A)}\n{END_IF}")).toEqual([
      "1:5 unknown operator 'frobnicate' in a conditional pragma",
    ]);
    expect(errs("{IF defined(widget:A)}\n{END_IF}")).toEqual([
      "1:5 unknown operator 'defined(widget:...)' in a conditional pragma",
    ]);
  });

  it("syntax errors at the offending character", () => {
    expect(errs("{IF defined(A}\n{END_IF}")).toEqual([
      "1:14 Malformed conditional pragma expression: expected ')'",
    ]);
    expect(errs("{IF (defined(A)\n}\n{END_IF}")).toEqual([
      "2:1 Malformed conditional pragma expression: expected ')'",
    ]);
    expect(errs("{IF}\n{END_IF}")).toEqual([
      "1:4 Malformed conditional pragma expression: expected a condition",
    ]);
    expect(errs("{IF defined(A) defined(B)}\n{END_IF}")).toEqual([
      "1:16 Malformed conditional pragma expression: expected end of condition",
    ]);
    expect(errs("{IF SIM}\n{END_IF}")).toEqual([
      "1:8 Malformed conditional pragma expression: expected '('",
    ]);
    expect(errs("{IF hasvalue(M, fast)}\n{END_IF}")).toEqual([
      "1:17 Malformed conditional pragma expression: expected a quoted value",
    ]);
    expect(errs("{IF hasvalue(M, 'x)}\n{END_IF}")).toEqual([
      "1:17 Malformed conditional pragma expression: unterminated string",
    ]);
    expect(errs("{IF defined(A)}\n{ELSE junk}\n{END_IF}")).toEqual([
      "2:7 Malformed conditional pragma: {ELSE} takes no condition",
    ]);
  });

  it("errors in dead branches are reported and do not depend on the defines", () => {
    const src = [
      "{IF defined(A)}",
      "{IF hastype(variable:x, INT)}",
      "{END_IF}",
      "{ELSIF defined(pou:P)}",
      "{ELSE}",
      "{IF defined(B}",
      "{END_IF}",
      "{END_IF}",
    ].join("\n");
    const expected = [
      "2:5 Conditional pragma operator 'hastype' is not supported",
      "4:8 Conditional pragma operator 'defined(pou:...)' is not supported",
      "6:14 Malformed conditional pragma expression: expected ')'",
    ];
    expect(errs(src)).toEqual(expected);
    expect(errs(src, { A: "" })).toEqual(expected);
    expect(errs(src, { A: "", B: "" })).toEqual(expected);
  });

  it("an error carries offset and length", () => {
    const r = run("ab\n{ELSE}");
    expect(r.errors[0]).toMatchObject({
      offset: 3,
      length: 6,
      line: 2,
      column: 1,
    });
  });
});

describe("sourcePrepFor", () => {
  it("is enabled by the feature and upper-cases the define names", () => {
    const off = sourcePrepFor(resolveDialect({}), { sim: "" });
    expect(off.enabled).toBe(false);
    const on = sourcePrepFor(
      resolveDialect({ features: ["+conditional_pragmas"] }),
      { sim: "", Mode: "fast" },
    );
    expect(on.enabled).toBe(true);
    expect([...on.defines]).toEqual([
      ["SIM", ""],
      ["MODE", "fast"],
    ]);
    expect(sourcePrepFor(resolveDialect({ dialect: "iec-3" })).enabled).toBe(
      false,
    );
  });
});

describe("characters whose upper case changes length", () => {
  const SRC = [
    "PROGRAM Main",
    "VAR",
    "  maß : INT := 5;",
    "  ﬁx : INT;",
    "END_VAR",
    "{IF defined(SIM)} x := 1; {END_IF}",
    "y := 7;",
    "{attribute 'x'}",
    "END_PROGRAM",
    "",
  ].join("\n");

  it("blanks each directive exactly, so later active text survives", () => {
    const r = run(SRC);
    expect(r.errors).toEqual([]);
    expect(r.text.length).toBe(SRC.length);
    const lines = r.text.split("\n");
    expect(lines[5]!.trim()).toBe("");
    expect(lines[6]).toBe("y := 7;");
    expect(lines[7]).toBe("{attribute 'x'}");
  });

  it("reads the condition from the source text", () => {
    const src = SRC.replace("defined(SIM)", "hasvalue(MODE, 'ä')");
    expect(run(src, { MODE: "ä" }).text.split("\n")[5]!.trim()).toBe("x := 1;");
  });
});

describe("string literals that span lines", () => {
  it("a directive swallowed by a string in a dead branch is an error", () => {
    const src = [
      "{IF defined(A)}",
      "s := 'oops;",
      "{ELSE}",
      "b := 'q';",
      "{END_IF}",
      "",
    ].join("\n");
    expect(errs(src)).toEqual([
      "3:1 Conditional pragma directive inside a string literal that spans lines",
    ]);
  });

  it("a multi-line string without a directive line is not an error", () => {
    const src = "{IF defined(A)}\ns := 'a\nb';\n{END_IF}\n";
    expect(run(src).errors).toEqual([]);
  });
});

describe("blankedLines", () => {
  it("lists lines that held text and are blank after the pass", () => {
    const src =
      "a;\n{IF defined(A)}\nb;\n\n{ELSE}\nc; {IF defined(B)} d; {END_IF}\n{END_IF}\n";
    expect(applyConditionalPragmas(src, defs(), tokenize).blankedLines).toEqual(
      [2, 3, 5, 7],
    );
  });
});
