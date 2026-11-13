/**
 * Upper-casing keeps the source's length: a character whose upper case is
 * longer ('ß', 'ΐ', 'ﬁ') is kept as written, so later columns stay right.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { uppercaseSource } from "../../src/frontend/lexer.js";

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
      "2:5: 'ﬁ' is not allowed in a name: identifiers use A–Z, digits and _",
      "3:1: 'ﬁ' is not allowed in a name: identifiers use A–Z, digits and _",
    ]);
    expect(
      errors("PROGRAM P\nVAR straße : INT; END_VAR\nEND_PROGRAM\n")[0],
    ).toBe(
      "2:9: 'ß' is not allowed in a name: identifiers use A–Z, digits and _",
    );
  });
});

describe("names hold A–Z, digits and _ only", () => {
  const msg = (at: string, ch: string): string =>
    `${at}: '${ch}' is not allowed in a name: identifiers use A–Z, digits and _`;

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
    `${at}: '${ch}' is not allowed in a name: identifiers use A–Z, digits and _`;
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
