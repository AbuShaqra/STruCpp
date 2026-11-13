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
      "2:5: unexpected character: ->ﬁ<- at offset: 14, skipped 1 characters.",
      "3:1: unexpected character: ->ﬁ<- at offset: 32, skipped 1 characters.",
    ]);
  });
});
