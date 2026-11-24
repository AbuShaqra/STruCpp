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
        "7:51 A WSTRING literal of 4 UTF-16 code units is longer than WSTRING(2): it is cut to 2",
        "8:6 A STRING literal of 6 characters is longer than STRING(3): it is cut to 3",
        "9:8 A STRING literal of 6 characters is longer than STRING(3): it is cut to 3",
        "10:13 A STRING literal of 4 characters is longer than STRING(3): it is cut to 3",
        "11:7 A WSTRING literal of 3 UTF-16 code units is longer than WSTRING(2): it is cut to 2",
      ]);
    });
  }
  it("warns once per initial value, in initialisers, aliases and results", () => {
    const r = compile(`TYPE ST : STRUCT f : STRING(2); END_STRUCT END_TYPE
TYPE MyS : STRING(3); END_TYPE
FUNCTION F : STRING(3)
F := 'abcdef';
END_FUNCTION
FUNCTION_BLOCK FB
VAR q : STRING(2) := 'xyz'; END_VAR
METHOD M1 : STRING(1)
M1 := 'zz';
END_METHOD
METHOD M2 : INT
M2 := 2;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main
VAR a : ARRAY[1..2] OF STRING(2) := ['abc', 'd']; t : ST := (f := 'xyz'); m : MyS := 'abcdef';
z : STRING(0); ws : WSTRING(1) := "\u{1F600}"; r : STRING; END_VAR
z := 'a';
r := F();
END_PROGRAM
`);
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((w) => `${w.line}:${w.column} ${w.message}`)).toEqual(
      [
        "16:38 A STRING literal of 3 characters is longer than STRING(2): it is cut to 2",
        "16:67 A STRING literal of 3 characters is longer than STRING(2): it is cut to 2",
        "16:86 A STRING literal of 6 characters is longer than STRING(3): it is cut to 3",
        "17:35 A WSTRING literal of 2 UTF-16 code units is longer than WSTRING(1): it is cut to 1",
        "18:6 A STRING literal of 1 character is longer than STRING(0): it is cut to 0",
        "4:6 A STRING literal of 6 characters is longer than STRING(3): it is cut to 3",
        "7:22 A STRING literal of 3 characters is longer than STRING(2): it is cut to 2",
        "9:7 A STRING literal of 2 characters is longer than STRING(1): it is cut to 1",
      ],
    );
  });
  const warnings = (source: string): string[] => {
    const r = compile(source);
    expect(r.errors).toEqual([]);
    return r.warnings.map((w) => `${w.line}:${w.column} ${w.message}`);
  };
  it("counts a # inside a STRING literal as a character", () => {
    expect(
      warnings(`PROGRAM Main
VAR a : STRING(3) := 'ab#cdef'; b : STRING(3) := '#abcde'; c : STRING(7) := 'a#''bcdef'; d : STRING(3) := 'a#b'; END_VAR
END_PROGRAM
`),
    ).toEqual([
      "2:22 A STRING literal of 7 characters is longer than STRING(3): it is cut to 3",
      "2:50 A STRING literal of 6 characters is longer than STRING(3): it is cut to 3",
      "2:77 A STRING literal of 8 characters is longer than STRING(7): it is cut to 7",
    ]);
  });
  it("resolves a variable inherited through EXTENDS before a global", () => {
    expect(
      warnings(`VAR_GLOBAL v : STRING(1); i : STRING(1); END_VAR
FUNCTION_BLOCK PA
VAR v : STRING(5); END_VAR
VAR_INPUT i : STRING(5); END_VAR
END_FUNCTION_BLOCK
FUNCTION_BLOCK MID EXTENDS PA
END_FUNCTION_BLOCK
FUNCTION_BLOCK CH EXTENDS MID
METHOD M : INT
v := 'abc';
i := 'abc';
END_METHOD
v := 'abc';
i := 'abc';
END_FUNCTION_BLOCK
PROGRAM Main
VAR c : CH; END_VAR
c(i := 'abc');
END_PROGRAM
`),
    ).toEqual([]);
  });
  it("warns for an inherited variable that is too short", () => {
    expect(
      warnings(`FUNCTION_BLOCK PA
VAR v : STRING(2); END_VAR
VAR_INPUT i : STRING(2); END_VAR
END_FUNCTION_BLOCK
FUNCTION_BLOCK CH EXTENDS PA
METHOD M : INT
v := 'abcd';
END_METHOD
v := 'abc';
END_FUNCTION_BLOCK
PROGRAM Main
VAR c : CH; END_VAR
c(i := 'abcde');
END_PROGRAM
`),
    ).toEqual([
      "13:8 A STRING literal of 5 characters is longer than STRING(2): it is cut to 2",
      "9:6 A STRING literal of 3 characters is longer than STRING(2): it is cut to 2",
      "7:6 A STRING literal of 4 characters is longer than STRING(2): it is cut to 2",
    ]);
  });
  it("warns once for a repeated array element", () => {
    expect(
      warnings(`PROGRAM Main
VAR a : ARRAY[1..3] OF STRING(2) := [3('abc')]; END_VAR
END_PROGRAM
`),
    ).toEqual([
      "2:40 A STRING literal of 3 characters is longer than STRING(2): it is cut to 2",
    ]);
  });
});

describe("string literal longer than its target: calls and stores reached through members", () => {
  const warned = (source: string): string[] => {
    const r = compile(source);
    expect(r.errors).toEqual([]);
    return r.warnings
      .filter((w) => w.message.includes("is cut to"))
      .map((w) => `${w.line}:${w.column}`);
  };

  it("warns at METHOD calls, FB calls through an element or member, initialisers, member stores and PROPERTY bodies", () => {
    const src = `TYPE S : STRUCT t : STRING(3); f : FB1; END_STRUCT; END_TYPE
FUNCTION_BLOCK FB1
VAR_INPUT s : STRING(3); END_VAR
METHOD M : INT
VAR_INPUT t : STRING(3); END_VAR
M := 1;
END_METHOD
METHOD Own : INT
Own := M(t := 'own-long');
END_METHOD
PROPERTY P : STRING(3)
GET P := 'propget'; END_GET
SET s := 'setlong'; END_SET
END_PROPERTY
END_FUNCTION_BLOCK
PROGRAM Prg
VAR
  f : FB1;
  g : FB1 := (s := 'initlong');
  arr : ARRAY[0..1] OF FB1;
  st : S;
  sa : ARRAY[0..2] OF STRING(3);
  rs : REF_TO STRING(3);
  n : INT;
END_VAR
n := f.M(t := 'methodlong');
arr[0](s := 'elemlong');
st.f(s := 'memberlong');
st.t := 'fieldlong';
sa[1] := 'elementlong';
rs := REF(sa[0]);
rs^ := 'dereflong';
f.P := 'proplong';
n := f.M('poslong');
END_PROGRAM
`;
    expect(warned(src).sort()).toEqual(
      [
        "9:15",
        "12:10",
        "13:10",
        "19:20",
        "26:15",
        "27:13",
        "28:11",
        "29:9",
        "30:10",
        "32:8",
        "33:8",
        "34:10",
      ].sort(),
    );
  });

  it("stays silent where the target is not known for certain", () => {
    const src = `FUNCTION_BLOCK FB1
VAR_INPUT s : STRING(3); END_VAR
END_FUNCTION_BLOCK
PROGRAM Prg
VAR
  m : ARRAY[0..1, 0..1] OF STRING(3);
  w : STRING(20);
  f : FB1;
END_VAR
w := 'a long enough text';
m[0, 1] := 'abc';
f(s := 'abc');
END_PROGRAM
`;
    expect(warned(src)).toEqual([]);
  });
});
