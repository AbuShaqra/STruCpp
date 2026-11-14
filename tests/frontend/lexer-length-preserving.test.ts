/**
 * Upper-casing keeps the source's length: a character whose upper case is
 * longer ('ß', 'ΐ', 'ﬁ') is kept as written, so later columns stay right.
 */
import { describe, it, expect } from "vitest";
import { analyze, compile } from "../../src/index.js";
import { uppercaseSource } from "../../src/frontend/lexer.js";

/** How the refusal shows a character: quoted when visible, with its code points. */
function nameText(ch: string): string {
  const points = [...ch]
    .map(
      (c) =>
        `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`,
    )
    .join(" ");
  const visible = [...ch].some(
    (c) => !/^[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{M}]$/u.test(c),
  );
  return visible ? `'${ch}' (${points})` : points;
}

const errors = (src: string, features: string[] = []): string[] =>
  compile(src, { features }).errors.map(
    (e) => `${e.line}:${e.column}: ${e.message}`,
  );

describe("length-preserving upper-casing", () => {
  it("keeps characters whose upper case is longer", () => {
    for (const ch of ["ß", "ΐ", "ﬁ"]) {
      const text = `{a ${ch}} x`;
      expect(uppercaseSource(text)).toBe(`{A ${ch}} X`);
    }
    expect(uppercaseSource("straße")).toHaveLength("straße".length);
  });

  it("reports columns after such characters in a pragma as written", () => {
    for (const ch of ["ßßßß", "ΐΐΐΐ", "ﬁﬁﬁﬁ"]) {
      expect(
        errors(
          `PROGRAM P\nVAR x, y : INT; END_VAR\nx := 1; {${ch}} y := q;\nEND_PROGRAM\n`,
        ),
      ).toEqual(["3:21: Undeclared variable 'Q'"]);
    }
  });

  it("gives __POSITION the column as written", () => {
    const r = compile(
      "PROGRAM P\nVAR s : STRING; END_VAR\n{info ßΐﬁ} s := __POSITION();\nEND_PROGRAM\n",
      { features: ["+vendor_operators"] },
    );
    expect(r.errors).toEqual([]);
    expect(r.cppCode).toContain('S = "Line 3, Column 17 (Impl)"');
  });

  it("refuses a ligature in an identifier instead of reading it as FI", () => {
    expect(
      errors("PROGRAM P\nVAR ﬁx : INT; END_VAR\nﬁx := 1;\nEND_PROGRAM\n"),
    ).toEqual([
      "2:5: 'ﬁ' (U+FB01) is not allowed in a name: identifiers use A–Z, digits and _",
      "3:1: 'ﬁ' (U+FB01) is not allowed in a name: identifiers use A–Z, digits and _",
    ]);
    expect(
      errors("PROGRAM P\nVAR straße : INT; END_VAR\nEND_PROGRAM\n")[0],
    ).toBe(
      "2:9: 'ß' (U+00DF) is not allowed in a name: identifiers use A–Z, digits and _",
    );
  });
});

describe("names hold A–Z, digits and _ only", () => {
  const msg = (at: string, ch: string): string =>
    `${at}: ${nameText(ch)} is not allowed in a name: identifiers use A–Z, digits and _`;

  it("never turns a non-ASCII character into ASCII", () => {
    expect(uppercaseSource("ınt ſ x")).toBe("ıNT ſ X");
    expect(
      errors(
        "PROGRAM P\nVAR x : ınt; ıx : INT; ix : INT; END_VAR\nEND_PROGRAM\n",
      ),
    ).toEqual([msg("2:9", "ı"), msg("2:14", "ı")]);
  });

  it("refuses each such letter once, the word staying one name", () => {
    expect(
      errors(
        "PROGRAM P\nVAR straße : INT; aßäb : INT; bär : INT; END_VAR\nEND_PROGRAM\n",
      ),
    ).toEqual([
      msg("2:9", "ß"),
      msg("2:20", "ß"),
      msg("2:21", "ä"),
      msg("2:32", "ä"),
    ]);
  });

  it("quotes an astral letter and a combining mark whole", () => {
    expect(
      errors(
        "PROGRAM P\nVAR a\u{1D465} : INT; café : INT; END_VAR\nEND_PROGRAM\n",
      ),
    ).toEqual([msg("2:6", "\u{1D465}"), msg("2:19", "é")]);
  });
});

describe("names: every non-ASCII character but whitespace (recheck)", () => {
  const msg = (at: string, ch: string): string =>
    `${at}: ${nameText(ch)} is not allowed in a name: identifiers use A–Z, digits and _`;
  const decl = (name: string): string[] =>
    errors(`PROGRAM P\nVAR\n  ${name} : INT;\nEND_VAR\nEND_PROGRAM\n`);

  it("keeps a word with any such letter one name (#1, #5)", () => {
    for (const cp of [0x212a, 0x212b, 0xff21, 0xaa, 0x2113, 0x2160]) {
      const ch = String.fromCodePoint(cp);
      expect(decl(`x${ch}y`)).toEqual([msg("3:4", ch)]);
    }
  });

  it("keeps marks and joiners in the name, quoted with their base (#2)", () => {
    for (const cp of [0x20d7, 0xfe20, 0x200d, 0x200c]) {
      const ch = String.fromCodePoint(cp);
      expect(decl(`x${ch}y`)).toEqual([msg("3:3", `x${ch}`)]);
    }
  });

  it("quotes a base with all its marks once (#3)", () => {
    expect(decl("é̂x")).toEqual([msg("3:3", "é̂")]);
    expect(decl("é̂x")).toEqual([msg("3:3", "é̂")]);
    expect(decl("a\u{1D465}́")).toEqual([msg("3:4", "\u{1D465}́")]);
  });

  it("gives one error for a letter glued to a literal (#4)", () => {
    const body = (stmt: string): string[] =>
      errors(
        `PROGRAM P\nVAR x : INT; t : TIME; r : REAL; b : BOOL; s : STRING; END_VAR\n${stmt}\nEND_PROGRAM\n`,
      );
    expect(body("x := 16#FFä;")).toEqual([msg("3:11", "ä")]);
    expect(body("x := 5ä;")).toEqual([msg("3:7", "ä")]);
    expect(body("r := 1.5ä;")).toEqual([msg("3:9", "ä")]);
    expect(body("t := T#1sä;")).toEqual([msg("3:10", "ä")]);
    expect(
      errors("PROGRAM P\nVAR q AT %IX0.0ä : BOOL; END_VAR\nEND_PROGRAM\n"),
    ).toEqual([msg("2:16", "ä")]);
    expect(body("s := 'abc'ä;")).toEqual([msg("3:11", "ä")]);
  });

  it("keeps every whitespace character whitespace (#6)", () => {
    for (const cp of [
      0xa0, 0x1680, 0x2000, 0x2005, 0x200a, 0x202f, 0x205f, 0x3000, 0xfeff,
    ]) {
      const ch = String.fromCodePoint(cp);
      expect(
        errors(
          `PROGRAM P\nVAR ab : INT; ccc : INT; END_VAR\nccc := ab${ch}+ 1;\nEND_PROGRAM\n`,
        ),
      ).toEqual([]);
    }
  });
});

describe("names: clusters, invisible characters, glued runs (recheck 2)", () => {
  const msg = (at: string, ch: string): string =>
    `${at}: ${nameText(ch)} is not allowed in a name: identifiers use A–Z, digits and _`;
  const decl = (name: string): string[] =>
    errors(`PROGRAM P\nVAR\n  ${name} : INT;\nEND_VAR\nEND_PROGRAM\n`);
  const body = (stmt: string): string[] =>
    errors(
      `PROGRAM P\nVAR x : INT; r : REAL; t : TIME; s : STRING; ab : INT; END_VAR\n${stmt}\nEND_PROGRAM\n`,
    );

  it("gives one error for a run glued to any other token (#4)", () => {
    expect(body("x := (1)ä;")).toEqual([msg("3:9", "ä")]);
    expect(body("IF TRUE THEN x:=1; END_IFä")).toEqual([msg("3:26", "ä")]);
  });

  it("refuses a whole grapheme cluster once (#1)", () => {
    const cp = (...c: number[]): string => String.fromCodePoint(...c);
    for (const cluster of [
      cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467),
      cp(0x1f1e9, 0x1f1ea),
      cp(0x1f44d, 0x1f3fb),
      cp(0x1100, 0x1161),
    ]) {
      expect(decl(`x${cluster}y`)).toEqual([msg("3:4", cluster)]);
    }
  });

  it("names an invisible, format or bidi character by its code point (#2)", () => {
    expect(decl("x\u0085y")).toEqual([
      "3:4: U+0085 is not allowed in a name: identifiers use A–Z, digits and _",
    ]);
    expect(decl("x\u202Ey")).toEqual([
      "3:4: U+202E is not allowed in a name: identifiers use A–Z, digits and _",
    ]);
    expect(decl("\u200Dx")).toEqual([
      "3:3: U+200D is not allowed in a name: identifiers use A–Z, digits and _",
    ]);
  });

  it("quotes a mark glued to a literal with its base (#5)", () => {
    expect(body("x := 5\u0301;")).toEqual([msg("3:6", "5\u0301")]);
  });
});

describe("names: one rule for refused characters (recheck 3)", () => {
  const msg = (at: string, ch: string): string =>
    `${at}: ${nameText(ch)} is not allowed in a name: identifiers use A–Z, digits and _`;
  // As --check reports: the analysis goes on past a refused character.
  const checked = (src: string): string[] =>
    analyze(src).errors.map((e) => `${e.line}:${e.column}: ${e.message}`);
  const body = (stmt: string): string[] =>
    checked(
      `PROGRAM P\nVAR x : INT; y : INT; r : REAL; s : STRING; ab : INT; b : INT; c : INT; END_VAR\n${stmt}\nEND_PROGRAM\n`,
    );
  const qq = "3:{c}: Undeclared variable 'QQ'";
  const und = (col: number): string => qq.replace("{c}", String(col));

  it("refuses a run after a comment or pragma once (#1)", () => {
    expect(body("x := 1; (* c *)ä y := 2; x := qq;")).toEqual([
      msg("3:16", "ä"),
      und(31),
    ]);
    expect(body("x := 1 (* c *)ä; x := qq;")).toEqual([
      msg("3:15", "ä"),
      und(23),
    ]);
    expect(body("{attribute 'hide'}ä x := 1; y := qq;")).toEqual([
      msg("3:19", "ä"),
      und(34),
    ]);
  });

  it("keeps the ASCII letters after a refused run (#2, #6)", () => {
    expect(body("x := 1;äy := qq;")).toEqual([msg("3:8", "ä"), und(14)]);
    expect(body("x := 1 +äy; y := qq;")).toEqual([msg("3:9", "ä"), und(18)]);
    // Without the refused character END_IF and x join: one undeclared name.
    expect(body("END_IFäx := qq;")).toEqual([
      msg("3:7", "ä"),
      "3:1: Undeclared variable 'END_IFX'",
      und(13),
    ]);
    expect(body("x :=äb;")).toEqual([msg("3:5", "ä")]);
    expect(body("x := ABS(äb);")).toEqual([msg("3:10", "ä")]);
    // Without the refused character AND and c join into the name ANDC.
    expect(body("x := b ANDäc;")).toEqual([
      msg("3:11", "ä"),
      "3:8: Expected `Semicolon`, found identifier `ANDC`.",
      "3:8: Unexpected identifier `ANDC` after identifier `B` while parsing a statement.",
      "3:8: Expected `END_PROGRAM`, found identifier `ANDC`.",
    ]);
  });

  it("names the variable without the refused character (#3)", () => {
    for (const cp of [0x9b, 0x200b, 0x202e]) {
      const ch = String.fromCodePoint(cp);
      expect(body(`x${ch} := 1;`)).toEqual([msg("3:2", ch)]);
    }
  });

  it("refuses a C0 control in a name by code point (#4)", () => {
    expect(
      checked("PROGRAM P\nVAR\n  x\u0007y : INT;\nEND_VAR\nEND_PROGRAM\n"),
    ).toEqual([msg("3:4", "\u0007")]);
    expect(body("x := 1\u0007;")).toEqual([msg("3:7", "\u0007")]);
  });

  it("quotes a mark glued to a keyword with its last letter (#5, #7)", () => {
    expect(body("IF TRUÉ THEN x := 1; END_IF;")).toEqual([msg("3:7", "É")]);
    expect(body("IF TRUE THEN x:=1; END_IF́")).toEqual([msg("3:25", "F́")]);
    expect(
      errors("PROGRAM P\nVAR x : INT; END_VAR\nx := 1;\nEND_PROGRAḾ"),
    ).toEqual([msg("4:11", "Ḿ")]);
  });
});

describe("names: lexed as if the refused characters were not there (recheck 4)", () => {
  const msg = (at: string, ch: string): string =>
    `${at}: ${nameText(ch)} is not allowed in a name: identifiers use A–Z, digits and _`;
  const checked = (src: string): string[] =>
    analyze(src).errors.map((e) => `${e.line}:${e.column}: ${e.message}`);
  const body = (stmt: string): string[] =>
    checked(
      `PROGRAM P\nVAR x : INT; y : INT; r : REAL; t : TIME; b : INT; END_VAR\n${stmt}\nEND_PROGRAM\n`,
    );

  it("lexes a keyword split by a refused character as the keyword (#1)", () => {
    expect(body("IäF TRUE THEN x := 1; END_IF;")).toEqual([msg("3:2", "ä")]);
    expect(body("IF TRUE THEN x := 1; ENDä_IF;")).toEqual([msg("3:25", "ä")]);
    expect(body("x := b MäOD 2;")).toEqual([msg("3:9", "ä")]);
  });

  it("lexes a literal split by a refused character as the literal (#2)", () => {
    expect(body("x := 1ä2;")).toEqual([msg("3:7", "ä")]);
    expect(body("x := 16#FäF;")).toEqual([msg("3:10", "ä")]);
    expect(body("r := 1.ä5;")).toEqual([msg("3:8", "ä")]);
    expect(body("t := T#1äs;")).toEqual([msg("3:9", "ä")]);
    expect(body("x := äb;")).toEqual([msg("3:6", "ä")]);
  });

  it("gives a name after the refused character its own column (#3, #6)", () => {
    expect(body("IF TRUE THEN x := 1; END_IF; äqq := 2;")).toEqual([
      msg("3:30", "ä"),
      "3:31: Undeclared variable 'QQ'",
    ]);
  });

  it("lexes the digits left after a refused character as a number (#7)", () => {
    expect(body("x := ä1;")).toEqual([msg("3:6", "ä")]);
    expect(body("x := INT#ä5; y := 2;")).toEqual([msg("3:10", "ä")]);
  });

  it("re-lexes a test file with the test lexer (#4)", async () => {
    const { tokenizeTest } = await import("../../src/frontend/lexer.js");
    const r = tokenizeTest("TEST 't'\n  x := 1;\nEND_TESTä\n");
    expect(r.errors.map((e) => e.message)).toEqual([
      `${nameText("ä")} is not allowed in a name: identifiers use A–Z, digits and _`,
    ]);
    expect(r.tokens.map((t) => t.tokenType.name)).toContain("END_TEST");
  });
});

describe("two-pass positions (recheck 5)", () => {
  const checked = (src: string): string[] =>
    analyze(src).errors.map((e) => `${e.line}:${e.column}: ${e.message}`);

  it("maps columns after a refused character in a CR-only file (#1, #7)", () => {
    const errs = checked(
      "PROGRAM P\rVAR x : INT; END_VAR\rx := xä + q1;\rx := q2;\rEND_PROGRAM\r",
    );
    expect(errs).toContain("3:11: Undeclared variable 'Q1'");
    expect(errs).toContain("4:6: Undeclared variable 'Q2'");
  });

  it("quotes the source offset in a second-pass lexer error (#2)", () => {
    const src =
      "PROGRAM P\nVAR x : INT; y : INT; b : BOOL; s : STRING; END_VAR\nx := xä; y := 1 ? 2;\nEND_PROGRAM\n";
    const err = analyze(src).errors.find((e) => e.message.includes("?"));
    expect(err?.message).toContain(`at offset: ${src.indexOf("?")},`);
  });

  it("ends a refusal after the whole character (#3)", () => {
    const err = analyze(
      "PROGRAM P\nVAR x : INT; END_VAR\nx := \u{1F600}x;\nEND_PROGRAM\n",
    ).errors.find((e) => e.message.includes("U+1F600"));
    expect([err?.column, err?.endColumn]).toEqual([6, 8]);
  });
});

describe("two-pass error spans (recheck 6)", () => {
  it("spans a second-pass error over the refused characters inside it", async () => {
    const { tokenize } = await import("../../src/frontend/lexer.js");
    const src = "x := 1 ?\u00e4? 2;";
    const err = tokenize(src).errors.find((e) => e.message.includes("?"));
    expect(err?.offset).toBe(src.indexOf("?"));
    expect(err?.length).toBe(3);
  });
});
