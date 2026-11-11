// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * A STRING holds one Windows-1252 byte per character: a STRING literal is
 * emitted as CP1252 bytes, and a character CP1252 lacks is refused at its
 * position. A WSTRING literal holds any character.
 */
import { describe, it, expect } from "vitest";
import { analyzeTestFile, compile, parseTestFile } from "../../src/index.js";
import { cp1252Byte, cp1252CodePoint } from "../../src/byte-utils.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];

const program = (decls: string, body = ""): string => `PROGRAM Main
VAR
${decls}
END_VAR
${body}
END_PROGRAM
`;

describe("Windows-1252 table", () => {
  it("maps 0x80-0x9F to the CP1252 characters and back", () => {
    expect(cp1252CodePoint(0x80)).toBe(0x20ac);
    expect(cp1252CodePoint(0x9f)).toBe(0x178);
    expect(cp1252CodePoint(0x81)).toBe(0x81);
    expect(cp1252CodePoint(0xe4)).toBe(0xe4);
    for (let b = 0; b < 256; b++) {
      expect(cp1252Byte(cp1252CodePoint(b))).toBe(b);
    }
    expect(cp1252Byte(0x80)).toBeUndefined();
    expect(cp1252Byte(0x2603)).toBeUndefined();
  });
});

describe("STRING literals are Windows-1252", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      it("emits each non-ASCII character as its CP1252 byte", () => {
        const r = compile(
          program(
            "s : STRING := 'ä€';\nw : WSTRING := \"ä€\";",
            "s := 'Grüße';",
          ),
          options,
        );
        expect(r.errors).toEqual([]);
        expect(r.cppCode).toContain('S("\\344\\200")');
        expect(r.cppCode).toContain('S = "Gr\\374\\337e";');
        expect(r.cppCode).toContain('W(u"ä€")');
      });

      it("keeps $XX escapes as the byte they name", () => {
        const r = compile(program("s : STRING := '$E4$80';"), options);
        expect(r.errors).toEqual([]);
        expect(r.cppCode).toContain('S("\\344\\200")');
      });

      it("refuses a character CP1252 lacks, at its position", () => {
        const r = compile(program("s : STRING := 'ab☃c';"), options);
        expect(r.errors.map((e) => [e.message, e.line, e.column])).toEqual([
          [
            "Character '☃' (U+2603) cannot be stored in a STRING, which holds Windows-1252 characters; use a WSTRING literal (\"...\") for it",
            3,
            18,
          ],
        ]);
      });

      it("refuses one in a statement, a STRUCT default and outside the BMP", () => {
        const src = `TYPE T : STRUCT a : STRING := 'x→'; END_STRUCT END_TYPE
${program("s : STRING; t : T;", "s := '😀';")}`;
        const msgs = compile(src, options).errors.map((e) => e.message);
        expect(msgs).toHaveLength(2);
        expect(msgs.some((m) => m.includes("'→' (U+2192)"))).toBe(true);
        expect(msgs.some((m) => m.includes("'😀' (U+1F600)"))).toBe(true);
      });

      it("places a bad character of a literal spanning lines on its own line", () => {
        const r = compile(program("s : STRING;", "s := 'ab\n  x☃c';"), options);
        expect(r.errors.map((e) => [e.line, e.column])).toEqual([[6, 4]]);
      });

      it("says a U+FFFD comes from a source that is not UTF-8", () => {
        expect(
          compile(program("s : STRING := 'a\uFFFDb';"), options).errors.map(
            (e) => e.message,
          ),
        ).toEqual([
          "A STRING literal holds U+FFFD, a byte the source could not decode: the file is probably not UTF-8 (saved as Windows-1252?); save it as UTF-8",
        ]);
      });

      it("checks an assertion message in a test file", () => {
        const source = compile(program("s : STRING;"), options);
        const parsed = parseTestFile(
          `TEST 'T'\n  VAR uut : Main; END_VAR\n  ASSERT_EQ(uut.s, 'a', 'bad ☃');\nEND_TEST\n`,
          "test_t.st",
        );
        expect(parsed.errors).toEqual([]);
        const found = analyzeTestFile(parsed.testFile!, source.symbolTables!);
        expect(found.errors.map((e) => [e.message, e.line, e.column])).toEqual([
          [
            "Character '☃' (U+2603) cannot be stored in a STRING, which holds Windows-1252 characters; use a WSTRING literal (\"...\") for it",
            3,
            30,
          ],
        ]);
      });

      it("accepts any character in a WSTRING literal", () => {
        expect(
          compile(program('w : WSTRING := "☃😀→";'), options).errors,
        ).toEqual([]);
      });
    });
  }
});
