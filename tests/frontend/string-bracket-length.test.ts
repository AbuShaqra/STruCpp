// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * STRING[n] and WSTRING[n], the Ed. 3 spelling of a string length, are the
 * same types as STRING(n) and WSTRING(n), wherever a type is written.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];

const SOURCE = `VAR_GLOBAL CONSTANT L : INT := 6; END_VAR
TYPE TS : STRING[10]; END_TYPE
TYPE ST : STRUCT f : STRING[5]; w : WSTRING[4]; END_STRUCT END_TYPE
FUNCTION F : STRING[8]
VAR_INPUT a : STRING[3]; END_VAR
VAR_IN_OUT io : WSTRING[2]; END_VAR
F := CONCAT(a, 'xyz');
END_FUNCTION
PROGRAM Main
VAR
  s : STRING[4] := 'abcd';
  c : STRING[L];
  w : WSTRING[2] := "ab";
  t : TS;
  st : ST;
  arr : ARRAY[1..2] OF STRING[2];
  r : REF_TO WSTRING[2];
  x : STRING;
END_VAR
x := F(s, w);
arr[1] := 'ab';
END_PROGRAM
`;
const parenthesised = SOURCE.replace(
  /STRING\[([A-Za-z0-9_]+)\]/g,
  "STRING($1)",
);

describe("STRING[n] and WSTRING[n]", () => {
  it("rewrites every bracketed length in the comparison source", () => {
    expect(parenthesised).not.toMatch(/STRING\[/);
  });

  for (const [label, options] of MODES) {
    it(`emits what STRING(n) emits (${label})`, () => {
      const bracketed = compile(SOURCE, options);
      const parens = compile(parenthesised, options);
      expect(bracketed.errors).toEqual([]);
      expect(parens.errors).toEqual([]);
      expect(bracketed.headerCode).toBe(parens.headerCode);
      expect(bracketed.cppCode).toBe(parens.cppCode);
      expect(bracketed.headerCode).toContain("IECStringVar<4> S");
    });
  }

  it("keeps array subscripts and array types apart", () => {
    const r = compile(
      "PROGRAM Main\nVAR a : ARRAY[0..3] OF INT; s : STRING[3]; END_VAR\na[1] := LEN(s);\nEND_PROGRAM\n",
      {},
    );
    expect(r.errors.some((e) => /Expected/.test(e.message))).toBe(false);
  });

  it("reads an Unsigned_Int length with underscores, in either spelling", () => {
    for (const t of ["STRING[1_0]", "STRING(1_0)", "WSTRING[1_0]"]) {
      const r = compile(
        `PROGRAM Main\nVAR s : ${t}; END_VAR\nEND_PROGRAM\n`,
        {},
      );
      expect(r.errors).toEqual([]);
      expect(r.headerCode).toMatch(/StringVar<10> S;/);
    }
  });

  it("reads a based length in parentheses and refuses one in brackets", () => {
    const paren = compile(
      "PROGRAM Main\nVAR s : STRING(16#20); END_VAR\nEND_PROGRAM\n",
      {},
    );
    expect(paren.errors).toEqual([]);
    expect(paren.headerCode).toContain("IECStringVar<32> S;");
    expect(
      compile("PROGRAM Main\nVAR s : STRING[16#20]; END_VAR\nEND_PROGRAM\n", {})
        .errors.length,
    ).toBeGreaterThan(0);
  });

  it("refuses both length spellings at once", () => {
    expect(
      compile("PROGRAM Main\nVAR s : STRING(3)[5]; END_VAR\nEND_PROGRAM\n", {})
        .errors.length,
    ).toBeGreaterThan(0);
  });
});
