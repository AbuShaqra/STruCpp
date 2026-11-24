/**
 * Under iec-3 (features enum_dot_qualify and struct_compare off): `E.M` is
 * refused wherever a TYPE declaration writes it, whether or not a variable
 * uses the type, and also when a type error stops the later checks; `=` of
 * two UNIONs names UNION; a test file's `((p1)) = p2` of two STRUCTs is refused.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { parseTestFile } from "../../src/testing/test-parser.js";
import { analyzeTestFile } from "../../src/semantic/analyzer.js";
import { resolveDialect } from "../../src/dialect.js";

const IEC3 = { dialect: "iec-3" } as const;
const at = (d: { line: number; column: number; message: string }): string =>
  `${d.line}:${d.column}: ${d.message}`;
const enumDot = (e: string, m: string): string =>
  `${e}.${m} needs the feature enum_dot_qualify`;

describe("E.M in a TYPE declaration", () => {
  const TYPES = `TYPE E : (A, B); END_TYPE
TYPE TA : ARRAY[0..1] OF E := [E.A, E.B]; END_TYPE
TYPE TS : STRUCT x : E := E.A; y : TA; END_STRUCT; END_TYPE
`;
  const expected = [
    `2:32: ${enumDot("E", "A")}`,
    `2:37: ${enumDot("E", "B")}`,
    `3:27: ${enumDot("E", "A")}`,
  ];
  const refusals = (src: string): string[] =>
    compile(src, IEC3)
      .errors.filter((e) => e.message.includes("enum_dot_qualify"))
      .map((e) =>
        at({
          ...e,
          message: e.message.replace(/ \(profiles.*$/, "").replace(/;.*$/, ""),
        }),
      );

  it("is refused when no variable uses the type", () => {
    const src = `${TYPES}PROGRAM P
VAR n : INT; END_VAR
n := 1;
END_PROGRAM
`;
    expect(refusals(src)).toEqual(expected);
  });

  it("is refused once when a variable uses the type", () => {
    const src = `${TYPES}PROGRAM P
VAR a : TA; s : TS; END_VAR
a[0] := E#A;
END_PROGRAM
`;
    expect(refusals(src)).toEqual(expected);
  });

  it("is accepted with no dialect", () => {
    expect(
      compile(`${TYPES}PROGRAM P
VAR a : TA; END_VAR
a[0] := E#A;
END_PROGRAM
`).errors,
    ).toEqual([]);
  });
});

describe("E.M in a body after a type error", () => {
  it("reports both", () => {
    const src = `TYPE E : (A, B); END_TYPE
PROGRAM P
VAR e1 : E; n : INT; END_VAR
e1 := E.A;
n := TRUE + 'x';
END_PROGRAM
`;
    const errors = compile(src, IEC3).errors.map(
      (e) => `${e.line}:${e.column}`,
    );
    expect(errors.sort()).toEqual(["4:7", "5:6"]);
    expect(
      compile(src, IEC3).errors.some((e) =>
        e.message.startsWith(enumDot("E", "A")),
      ),
    ).toBe(true);
  });

  it("reports no other pass-3 error then", () => {
    const src = `PROGRAM P
VAR n : INT; END_VAR
n := TRUE + 'x';
undeclared := 1;
END_PROGRAM
`;
    // The undeclared name is pass 3's: still hidden behind the type error
    expect(
      compile(src, IEC3).errors.map((e) => `${e.line}:${e.column}`),
    ).toEqual(["3:6"]);
  });
});

describe("= of two STRUCTs or UNIONs", () => {
  const SOURCE = `TYPE S : STRUCT a : INT; END_STRUCT; END_TYPE
TYPE U : UNION a : INT; b : WORD; END_UNION; END_TYPE
PROGRAM P
VAR n : INT; END_VAR
n := 1;
END_PROGRAM
`;
  const opts = { dialect: "iec-3", features: ["+union"] };

  it("names UNION in a source", () => {
    const src = SOURCE.replace(
      "VAR n : INT; END_VAR\nn := 1;",
      "VAR u1, u2 : U; ok : BOOL; END_VAR\nok := u1 = u2;",
    );
    expect(compile(src, opts).errors.map((e) => e.message)).toEqual([
      expect.stringMatching(
        /^= of two UNION values needs the feature struct_compare/,
      ),
    ]);
  });

  it("is refused in a test file, parenthesised or not, naming UNION for UNIONs", () => {
    const src = compile(SOURCE, opts);
    expect(src.errors).toEqual([]);
    const parsed = parseTestFile(
      `TEST 'cmp'
VAR p1, p2 : S; u1, u2 : U; END_VAR
ASSERT_TRUE(((p1)) = p2);
ASSERT_TRUE(p1 = p2);
ASSERT_TRUE(u1 = u2);
END_TEST
`,
      "t.st",
      opts,
    );
    expect(parsed.errors).toEqual([]);
    const result = analyzeTestFile(
      parsed.testFile!,
      src.symbolTables!,
      src.ast,
      resolveDialect(opts),
    );
    expect(
      result.errors.map(
        (e) => `${e.line}:${e.column}: ${e.message.replace(/ needs.*$/, "")}`,
      ),
    ).toEqual([
      "3:13: = of two STRUCT values",
      "4:13: = of two STRUCT values",
      "5:13: = of two UNION values",
    ]);
  });
});
