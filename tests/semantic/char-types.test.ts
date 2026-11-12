// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * CHAR and WCHAR (IEC 61131-3 Ed. 3, Table 10): CHAR# and WCHAR# literals of
 * one character, s[i] on a STRING or WSTRING, and the conversions of Table 26
 * kind between characters, bit strings and strings.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];

const program = (body: string): string => `PROGRAM Main
VAR c : CHAR; w : WCHAR; s : STRING; ws : WSTRING; b : BYTE; wd : WORD; x : BOOL; END_VAR
${body}
END_PROGRAM
`;
const result = (body: string, options: Options) =>
  compile(program(body), { ...options, headerFileName: "generated.hpp" });
const errors = (body: string, options: Options): string[] =>
  result(body, options).errors.map((e) => e.message);

describe("CHAR and WCHAR", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      it("declares them and emits a literal as its code", () => {
        const r = result(
          `c := CHAR#'A';\nc := CHAR#'€';\nc := CHAR#'$41';\nc := CHAR#'$'';\nw := WCHAR#"☃";\nw := WCHAR#"$20AC";`,
          options,
        );
        expect(r.errors).toEqual([]);
        expect(r.headerCode).toContain("IEC_CHAR C;");
        expect(r.headerCode).toContain("IEC_WCHAR W;");
        expect(r.cppCode).toContain("C = static_cast<CHAR_t>(65);");
        expect(r.cppCode).toContain("C = static_cast<CHAR_t>(128);");
        expect(r.cppCode).toContain("C = static_cast<CHAR_t>(39);");
        expect(r.cppCode).toContain("W = static_cast<WCHAR_t>(9731);");
        expect(r.cppCode).toContain("W = static_cast<WCHAR_t>(8364);");
      });

      it("refuses a literal of other than one character, or a CHAR CP1252 lacks", () => {
        expect(errors("c := CHAR#'AB';", options)).toEqual([
          "A CHAR literal holds exactly one character; CHAR#'AB' holds 2",
        ]);
        expect(errors('w := WCHAR#"";', options)).toEqual([
          'A WCHAR literal holds exactly one character; WCHAR#"" holds 0',
        ]);
        expect(errors("c := CHAR#'☃';", options)).toEqual([
          "CHAR#'☃' holds a character Windows-1252 lacks, which a CHAR cannot store; use a WCHAR literal (WCHAR#\"...\") for it",
        ]);
      });

      it("indexes a STRING to a CHAR and a WSTRING to a WCHAR", () => {
        const r = result(
          "c := s[2];\ns[1] := c;\nw := ws[1];\nws[2] := w;",
          options,
        );
        expect(r.errors).toEqual([]);
        expect(r.cppCode).toContain("C = S.at(2);");
        expect(r.cppCode).toContain("S.at(1) = C;");
        expect(errors("w := s[1];", options)).toEqual([
          "Cannot assign CHAR to WCHAR",
        ]);
        expect(errors("c := s[1, 2];", options)).toEqual([
          "A STRING takes one index (a character position), not 2",
        ]);
      });

      it("keeps CHAR apart from STRING, WCHAR and integers", () => {
        expect(errors("c := s;", options)).toEqual([
          "Cannot assign STRING to CHAR",
        ]);
        expect(errors("s := c;", options)).toEqual([
          "Cannot assign CHAR to STRING",
        ]);
        expect(errors("c := w;", options)).toEqual([
          "Cannot assign WCHAR to CHAR",
        ]);
      });

      it("converts explicitly, by Windows-1252 code", () => {
        const r = result(
          "b := CHAR_TO_BYTE(c);\nc := BYTE_TO_CHAR(b);\nwd := WCHAR_TO_WORD(w);\nw := WORD_TO_WCHAR(wd);\ns := CHAR_TO_STRING(c);\nws := WCHAR_TO_WSTRING(w);\nw := CHAR_TO_WCHAR(c);\nc := WCHAR_TO_CHAR(w);\nx := c < CHAR#'z';",
          options,
        );
        expect(r.errors).toEqual([]);
        expect(r.cppCode).toContain(
          "B = TO_BYTE(static_cast<uint8_t>(iec_unwrap(C)));",
        );
        expect(r.cppCode).toContain(
          "X = static_cast<uint8_t>(iec_unwrap(C)) < static_cast<uint8_t>(iec_unwrap(static_cast<CHAR_t>(122)));",
        );
      });

      it("refuses CHAR beside a number, a WCHAR or a STRING variable, and arithmetic", () => {
        expect(errors("b := 1; x := c = b;", options)).toContain(
          "Cannot compare CHAR with BYTE",
        );
        expect(errors("x := c = w;", options)).toEqual([
          "Cannot compare CHAR with WCHAR",
        ]);
        expect(errors("x := c = s;", options)).toEqual([
          "Cannot compare CHAR with STRING",
        ]);
        expect(errors("c := c + CHAR#'a';", options)).toEqual([
          "Operator '+' does not apply to CHAR",
        ]);
        expect(errors("c := MAX(c, b);", options)).toEqual([
          "Argument of 'MAX' is BYTE where the others are CHAR; CHAR does not convert implicitly",
        ]);
      });

      it("reads a one-character literal as a CHAR or WCHAR where one is expected", () => {
        const r = result(
          "c := 'A';\nw := \"A\";\nx := c = 'B';\nx := s[1] = 'a';\nc := MAX(c, 'z');",
          options,
        );
        expect(r.errors).toEqual([]);
        expect(r.cppCode).toContain("C = static_cast<CHAR_t>(65);");
        expect(r.cppCode).toContain("W = static_cast<WCHAR_t>(65);");
        expect(errors("c := 'AB';", options)).toEqual([
          "Cannot assign STRING to CHAR",
        ]);
      });

      it("takes WCHAR#'X' and a code as CHAR#16#41", () => {
        const r = result(
          "w := WCHAR#'X';\nc := CHAR#16#41;\nw := WCHAR#8364;",
          options,
        );
        expect(r.errors).toEqual([]);
        expect(r.cppCode).toContain("W = static_cast<WCHAR_t>(88);");
        expect(r.cppCode).toContain("C = static_cast<CHAR_t>(65);");
        expect(errors("c := CHAR#16#141;", options)).toEqual([
          "CHAR#16#141 is past the CHAR range",
        ]);
      });

      it("refuses s[i] as an in/out argument or REF() operand", () => {
        expect(errors("x := REF(s[1]) = REF(s[2]);", options)[0]).toContain(
          "REF() cannot take a character of a string",
        );
      });

      it("takes CHAR labels on a CHAR selector", () => {
        expect(
          errors(
            "CASE c OF CHAR#'a': b := 1; 'b', 'c': b := 2; ELSE b := 0; END_CASE;",
            options,
          ),
        ).toEqual([]);
        expect(errors("CASE c OF 1: b := 1; END_CASE;", options)).toEqual([
          "CASE label of type INT does not match the selector of type CHAR",
        ]);
      });
    });
  }
});
