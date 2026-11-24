// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Typed string literals (IEC 61131-3 Ed. 3 Table 6): STRING#'...' and
 * WSTRING#"..." parse as a STRING and a WSTRING of that type; the other
 * quotes (STRING#"...", WSTRING#'...', CHAR#"...") are refused cleanly.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { withoutSites } from "../support/fault-sites.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];

const program = (body: string): string => `PROGRAM Main
VAR s : STRING; w : WSTRING; c : CHAR; wc : WCHAR; x : BOOL; n : INT; END_VAR
${body}
END_PROGRAM
`;
const result = (body: string, options: Options) =>
  compile(program(body), { ...options, headerFileName: "generated.hpp" });
const errors = (body: string, options: Options): string[] =>
  result(body, options).errors.map((e) => e.message);

describe("typed string literals", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      it("parses STRING#'...' and WSTRING#\"...\" as their text", () => {
        const r = result(
          `s := STRING#'abc';\nw := WSTRING#"$20AC";\ns := string#'a$'b';\nx := s = STRING#'abc';\nn := LEN(STRING#'abcd');`,
          options,
        );
        expect(r.errors).toEqual([]);
        const cpp = withoutSites(r.cppCode);
        expect(cpp).toContain('S = "abc";');
        expect(cpp).toContain('W = u"\\x20ac" u"";');
        expect(cpp).toContain(`S = "a'b";`);
      });

      it("keeps the literal's own type: no CHAR or WSTRING adaptation", () => {
        expect(errors("c := STRING#'a';", options)).toEqual([
          "Cannot assign STRING to CHAR",
        ]);
        expect(errors("w := STRING#'a';", options)).toEqual([
          "Cannot assign STRING to WSTRING",
        ]);
        expect(errors('s := WSTRING#"a";', options)).toEqual([
          "Cannot assign WSTRING to STRING",
        ]);
      });

      it("refuses a typed literal in the other quotes", () => {
        expect(errors('s := STRING#"abc";', options)).toEqual([
          "A STRING literal is written in single quotes: STRING#'...'",
        ]);
        expect(errors("w := WSTRING#'abc';", options)).toEqual([
          'A WSTRING literal is written in double quotes: WSTRING#"..."',
        ]);
        expect(errors('c := CHAR#"a";', options)).toEqual([
          "A CHAR literal is written in single quotes: CHAR#'...'",
        ]);
      });
    });
  }
});
