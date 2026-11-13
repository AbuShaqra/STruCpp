/** A STRING or WSTRING literal longer than where it is stored warns in every mode; the value is cut. */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const SOURCE = `TYPE ST : STRUCT f : STRING(2) := 'xyz'; END_STRUCT END_TYPE
FUNCTION F : INT
VAR_INPUT x : STRING(3); END_VAR
F := LEN(x);
END_FUNCTION
PROGRAM Main
VAR s : STRING(3) := 'abcdef'; ws : WSTRING(2) := "abcd"; r : INT; t : ST; ok : STRING(3) := 'abc'; d : STRING := 'short'; END_VAR
s := 'abcdef';
r := F('abcdef');
r := F(x := 'ab$Nc');
ws := "xyz";
END_PROGRAM
`;

describe("string literal longer than its target", () => {
  for (const [label, options] of [
    ["no dialect", {}],
    ["iec-3", { dialect: "iec-3" }],
    ["strict", { strict: true }],
  ] as const) {
    it(`warns where the value is cut (${label})`, () => {
      const r = compile(SOURCE, options);
      expect(r.errors).toEqual([]);
      expect(
        r.warnings.map((w) => `${w.line}:${w.column} ${w.message}`),
      ).toEqual([
        "1:35 A STRING literal of 3 characters is longer than STRING(2): it is cut to 2",
        "7:22 A STRING literal of 6 characters is longer than STRING(3): it is cut to 3",
        "7:51 A WSTRING literal of 4 characters is longer than WSTRING(2): it is cut to 2",
        "8:6 A STRING literal of 6 characters is longer than STRING(3): it is cut to 3",
        "9:8 A STRING literal of 6 characters is longer than STRING(3): it is cut to 3",
        "10:13 A STRING literal of 4 characters is longer than STRING(3): it is cut to 3",
        "11:7 A WSTRING literal of 3 characters is longer than WSTRING(2): it is cut to 2",
      ]);
    });
  }
});
