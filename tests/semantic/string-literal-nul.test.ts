// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * A stored STRING / WSTRING ends at its first NUL, so a literal is the text
 * before `$00`: the check warns when characters follow it (in every mode), the
 * length check counts only what is stored, and the C++ literal stops there.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { stringBodyBeforeNul } from "../../src/literal-utils.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];

const SOURCE = `PROGRAM Main
VAR s : STRING; t : STRING(2) := 'ab$00cdef'; w : WSTRING; b : BOOL; n : INT; END_VAR
s := 'a$00b';
s := 'tail$00';
w := "x$0000y";
b := 'a' = 'a$00b';
n := LEN('$$00 kept');
END_PROGRAM
`;

describe("$00 in a STRING / WSTRING literal", () => {
  for (const [label, options] of MODES) {
    it(`warns at the $00 when text follows it (${label})`, () => {
      const result = compile(SOURCE, options);
      expect(result.errors).toEqual([]);
      const nul = result.warnings
        .filter((w) => /ends the/.test(w.message))
        .map((w) => `${w.line}:${w.column} ${w.message}`);
      expect(nul).toEqual([
        "2:37 $00 ends the STRING; the rest of the literal is dropped",
        "3:8 $00 ends the STRING; the rest of the literal is dropped",
        "5:8 $0000 ends the WSTRING; the rest of the literal is dropped",
        "6:14 $00 ends the STRING; the rest of the literal is dropped",
      ]);
      // 'ab' fits STRING(2): the dropped text is not counted
      expect(
        result.warnings.filter((w) => /longer than/.test(w.message)),
      ).toEqual([]);
    });
  }

  it("still counts a stored literal longer than its STRING(n)", () => {
    const result = compile(
      `PROGRAM Main
VAR t : STRING(2) := 'abc$00d'; END_VAR
END_PROGRAM
`,
    );
    expect(result.warnings.map((w) => w.message)).toContain(
      "A STRING literal of 3 characters is longer than STRING(2): it is cut to 2",
    );
  });

  it("writes the C++ literal up to the $00", () => {
    const result = compile(SOURCE);
    expect(result.cppCode).toContain('S = "a";');
    expect(result.cppCode).toContain('S = "tail";');
    expect(result.cppCode).toContain('W = u"x";');
    expect(result.cppCode).toContain('strucpp::iec_str_cmp("a", "a") == 0');
    expect(result.cppCode).toContain('LEN("$00 kept")');
    expect(result.cppCode).toContain(`T("ab")`);
    expect(result.cppCode).not.toContain("\\000");
  });

  it("cuts a body at the first NUL escape only", () => {
    expect(stringBodyBeforeNul("a$00b")).toEqual({ body: "a", dropped: true });
    expect(stringBodyBeforeNul("a$00")).toEqual({ body: "a", dropped: false });
    expect(stringBodyBeforeNul("a$$00b")).toEqual({
      body: "a$$00b",
      dropped: false,
    });
    expect(stringBodyBeforeNul("a$0Ab$00")).toEqual({
      body: "a$0Ab",
      dropped: false,
    });
    expect(stringBodyBeforeNul("x$0000y", true)).toEqual({
      body: "x",
      dropped: true,
    });
    // In a WSTRING `$0041` is one character, not $00 then '41'
    expect(stringBodyBeforeNul("$0041", true)).toEqual({
      body: "$0041",
      dropped: false,
    });
    expect(stringBodyBeforeNul("$0041")).toEqual({ body: "", dropped: true });
  });
});
