// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * A CHAR or WCHAR reached through `^` (`p^`, `pa^[i]`, `pr^.c`, `r^`) takes a
 * one-character literal as that character, in a store, a comparison and the
 * standard comparison functions and as a CASE label; a STRING, WSTRING or the
 * other character type there is refused, as it is for a CHAR variable.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { withoutSites } from "../support/fault-sites.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", { features: ["+pointer_to"] }],
  ["iec-3", { dialect: "iec-3", features: ["+pointer_to"] }],
  ["strict", { strict: true, features: ["+pointer_to"] }],
];

const program = (
  body: string,
): string => `TYPE R : STRUCT c : CHAR; END_STRUCT; END_TYPE
PROGRAM Main
VAR
  c : CHAR; wc : WCHAR; s : STRING; ws : WSTRING; x : BOOL; arr : ARRAY[1..3] OF CHAR;
  p : POINTER TO CHAR; pw : POINTER TO WCHAR; pa : POINTER TO ARRAY[1..3] OF CHAR;
  pr : POINTER TO R; rc : REF_TO CHAR;
END_VAR
${body}
END_PROGRAM
`;
const result = (body: string, options: Options) =>
  compile(program(body), { ...options, headerFileName: "generated.hpp" });
const errors = (body: string, options: Options): string[] =>
  result(body, options).errors.map((e) => e.message);

describe("one-character literals through ^", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      it("stores a CHAR or WCHAR literal, not a string", () => {
        const r = result(
          `p^ := 'b';\npw^ := "c";\npa^[2] := 'd';\npr^.c := 'e';\nrc^ := 'f';`,
          options,
        );
        expect(r.errors).toEqual([]);
        const cpp = withoutSites(r.cppCode);
        expect(cpp).toContain("= static_cast<CHAR_t>(98);");
        expect(cpp).toContain("= static_cast<WCHAR_t>(99);");
        expect(cpp).toContain("= static_cast<CHAR_t>(100);");
        expect(cpp).toContain("= static_cast<CHAR_t>(101);");
        expect(cpp).toContain("= static_cast<CHAR_t>(102);");
        expect(cpp).not.toMatch(/= "[b-f]";/);
      });

      it("compares with a CHAR or WCHAR literal", () => {
        const r = result(
          `x := p^ = 'b';\nx := 'a' < p^;\nx := pw^ <> "c";\nx := rc^ = 'f';\nx := EQ(p^, 'b');`,
          options,
        );
        expect(r.errors).toEqual([]);
        expect(withoutSites(r.cppCode)).not.toContain("iec_str_cmp");
      });

      it("takes CHAR labels on a dereferenced CHAR selector", () => {
        const r = result(
          "CASE p^ OF 'a': x := TRUE; CHAR#'b': x := FALSE; END_CASE;",
          options,
        );
        expect(r.errors).toEqual([]);
        expect(withoutSites(r.cppCode)).not.toContain('case "a"');
        expect(
          errors("CASE p^ OF 'ab': x := TRUE; END_CASE;", options),
        ).toEqual([
          "CASE label of type STRING does not match the selector of type CHAR",
        ]);
      });

      it("refuses a STRING or WSTRING into or against a dereferenced CHAR", () => {
        expect(errors("p^ := 'bc';", options)).toEqual([
          "Cannot assign STRING to CHAR",
        ]);
        expect(errors("p^ := s;", options)).toEqual([
          "Cannot assign STRING to CHAR",
        ]);
        expect(errors("pw^ := 'b';", options)).toEqual([
          "Cannot assign STRING to WCHAR",
        ]);
        expect(errors('p^ := "b";', options)).toEqual([
          "Cannot assign WSTRING to CHAR",
        ]);
        expect(errors("x := p^ = 'bc';", options)).toEqual([
          "Cannot compare CHAR with STRING",
        ]);
        expect(errors("x := s <> p^;", options)).toEqual([
          "Cannot compare STRING with CHAR",
        ]);
        expect(errors("p^ := wc;", options)).toEqual([
          "Cannot assign WCHAR to CHAR",
        ]);
        expect(errors("pw^ := c;", options)).toEqual([
          "Cannot assign CHAR to WCHAR",
        ]);
        expect(errors("x := EQ(p^, s);", options)).toEqual([
          "Argument of 'EQ' is STRING where the others are CHAR; CHAR does not convert implicitly",
        ]);
      });
    });
  }
});
