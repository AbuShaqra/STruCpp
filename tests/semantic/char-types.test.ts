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

      it("types SEL, MUX, LIMIT, MAX and MIN of CHAR as CHAR", () => {
        const r = result(
          "x := c = SEL(x, c, c);\nx := c < MUX(1, c, c);\nx := c = LIMIT(c, c, c);\nx := EQ(c, SEL(x, c, c));\nx := SEL(x, c, c) = 'a';\nc := SEL(x, 'a', 'b');",
          options,
        );
        expect(r.errors).toEqual([]);
        expect(r.cppCode).toContain(
          "C = SEL(X, static_cast<CHAR_t>(97), static_cast<CHAR_t>(98));",
        );
        expect(errors("c := SEL(x, 'ab', 'b');", options)).toEqual([
          "Argument of 'SEL' is STRING where the others are CHAR; CHAR does not convert implicitly",
        ]);
      });

      it("takes a one-character literal for a CHAR input, element, field or alias", () => {
        const source = `TYPE MyC : CHAR; END_TYPE
TYPE St : STRUCT k : CHAR := 'q'; END_STRUCT END_TYPE
FUNCTION FIn : INT VAR_INPUT c : CHAR; END_VAR FIn := CHAR_TO_INT(c); END_FUNCTION
PROGRAM Main
VAR m : MyC := 'B'; a : ARRAY[0..1] OF CHAR := ['x', 'y']; s : St := (k := 'r'); i : INT; w : WCHAR; END_VAR
i := FIn('D') + FIn(c := 'E');
w := STRING_TO_WCHAR('ab');
i := CHAR_TO_INT('A');
END_PROGRAM
`;
        const r = compile(source, {
          ...options,
          headerFileName: "generated.hpp",
        });
        expect(r.errors).toEqual([]);
        expect(r.cppCode).toContain("M(static_cast<CHAR_t>(66))");
        expect(r.cppCode).toContain(
          "{static_cast<CHAR_t>(120), static_cast<CHAR_t>(121)}",
        );
        expect(r.cppCode).toContain("FIN(static_cast<CHAR_t>(68))");
        expect(r.cppCode).toContain("static_cast<CHAR_t>(65)");
      });

      it("refuses a value of another type for a CHAR input, element or alias", () => {
        const source = `TYPE MyC : CHAR; END_TYPE
FUNCTION FIn : INT VAR_INPUT c : CHAR; END_VAR FIn := CHAR_TO_INT(c); END_FUNCTION
PROGRAM Main
VAR m : MyC := 'BC'; a : ARRAY[0..1] OF CHAR := [1, 'y']; i : INT; w : WCHAR := 'a'; END_VAR
i := FIn('DE');
i := FIn(w);
END_PROGRAM
`;
        const r = compile(source, {
          ...options,
          headerFileName: "generated.hpp",
        });
        expect(r.errors.map((e) => e.message)).toEqual([
          "Cannot assign STRING to MYC",
          "Cannot assign INT to CHAR",
          "Cannot assign STRING to WCHAR",
          "Cannot assign STRING to parameter 'C' of type CHAR",
          "Cannot assign WCHAR to parameter 'C' of type CHAR",
        ]);
      });

      it("expands a CHAR or WCHAR range label to every code in it", () => {
        const r = result(
          "CASE c OF 'a'..'c': b := 1; ELSE b := 0; END_CASE;\nCASE w OF \"x\"..\"y\": b := 2; END_CASE;",
          options,
        );
        expect(r.errors).toEqual([]);
        for (const code of [97, 98, 99]) {
          expect(r.cppCode).toContain(`case static_cast<CHAR_t>(${code}):`);
        }
        expect(r.cppCode).toContain("case static_cast<WCHAR_t>(121):");
      });

      it("takes no EN or ENO of a nested CHAR call as an operand", () => {
        const r = result(
          "b := CHAR_TO_BYTE(MAX(EN := x, IN1 := c, IN2 := c, ENO => x));",
          options,
        );
        expect(r.errors).toEqual([]);
        expect(r.cppCode).toContain(
          "const bool en_ = X; X = en_; return en_ ?",
        );
        expect(r.cppCode).not.toContain(", X, X)");
      });
    });
  }
});
