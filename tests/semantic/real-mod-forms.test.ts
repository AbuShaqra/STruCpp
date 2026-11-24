// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * MOD takes integers (Table 29) on every route: a REAL or LREAL operand
 * reached through a named pointer type, a computed dereference, a PROPERTY
 * through a pointer, a STRUCT default, a global initial value, the function
 * form MOD(a, b) and a test file's statements are refused in every mode.
 * Also `__DELETE` of what is no POINTER TO, and the argument count of a
 * standard function in a STRUCT field default.
 */
import { describe, it, expect } from "vitest";
import { analyzeTestFile, compile, parseTestFile } from "../../src/index.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3", features: ["pointer_to", "fb_property"] }],
  ["strict", { strict: true }],
];

const mod = (t: string): string =>
  `MOD takes integers (ANY_INT, IEC 61131-3 Table 29), not ${t}`;

const errors = (src: string, options: Options): string[] =>
  compile(src, options).errors.map((e) => e.message);

const HEADER = `TYPE PR : POINTER TO REAL; END_TYPE
TYPE PI : POINTER TO INT; END_TYPE
TYPE MyR : REAL; END_TYPE
TYPE S : STRUCT f : REAL; pr : PR; END_STRUCT; END_TYPE
FUNCTION_BLOCK FB
VAR v : REAL := 2.5; END_VAR
PROPERTY P : REAL
GET
P := v;
END_GET
END_PROPERTY
END_FUNCTION_BLOCK
`;

const body = (line: string): string =>
  `${HEADER}PROGRAM Main
VAR x : REAL; l : LREAL; i : INT; p : PR; q : PI; pl : POINTER TO LREAL; ps : POINTER TO S; s : S; pm : POINTER TO MyR; f : FB; pf : POINTER TO FB; END_VAR
${line}
END_PROGRAM
`;

describe("REAL MOD refused on every route", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      it("refuses a REAL reached through a named pointer type", () => {
        expect(errors(body("x := p^ MOD 2;"), options)).toEqual([mod("REAL")]);
        expect(errors(body("x := s.pr^ MOD 2;"), options)).toEqual([
          mod("REAL"),
        ]);
        expect(errors(body("x := pm^ MOD 2;"), options)).toEqual([mod("REAL")]);
      });

      it("refuses a dereference inside a larger operand", () => {
        for (const line of [
          "x := (p^ + 1.0) MOD 2;",
          "x := -p^ MOD 2;",
          "x := (ps^.f * 2) MOD 2;",
          "x := i MOD (p^ - 1);",
        ]) {
          expect(errors(body(line), options)).toEqual([mod("REAL")]);
        }
        expect(errors(body("l := (pl^ + x) MOD 2;"), options)).toEqual([
          mod("LREAL"),
        ]);
      });

      it("refuses a REAL PROPERTY read through a pointer", () => {
        expect(errors(body("x := pf^.P MOD 2;"), options)).toEqual([
          mod("REAL"),
        ]);
      });

      it("refuses the function form MOD(a, b) on a REAL or LREAL", () => {
        expect(errors(body("x := MOD(x, 2);"), options)).toEqual([mod("REAL")]);
        expect(errors(body("l := MOD(IN1 := 5, IN2 := l);"), options)).toEqual([
          mod("LREAL"),
        ]);
        expect(errors(body("x := MOD(p^, 2);"), options)).toEqual([
          mod("REAL"),
        ]);
      });

      it("refuses it in STRUCT defaults and global initial values", () => {
        const src = `TYPE ST : STRUCT a : REAL := 5.5 MOD 2; b : REAL := MOD(5.5, 2); END_STRUCT; END_TYPE
VAR_GLOBAL CONSTANT C : REAL := 5.5 MOD 2; END_VAR
VAR_GLOBAL g : LREAL := LREAL#5.5 MOD 2; END_VAR
PROGRAM Main
VAR s : ST; r : REAL := 7.5 MOD 2; END_VAR
r := C + LREAL_TO_REAL(g);
END_PROGRAM
`;
        const found = compile(src, options)
          .errors.map((e) => `${e.line}:${e.column} ${e.message}`)
          .sort();
        expect(found).toEqual([
          `1:30 ${mod("REAL")}`,
          `1:57 ${mod("REAL")}`,
          `2:33 ${mod("REAL")}`,
          `3:25 ${mod("LREAL")}`,
          `5:25 ${mod("REAL")}`,
        ]);
      });

      it("keeps integer MOD on the same routes", () => {
        const src = `TYPE PI : POINTER TO INT; END_TYPE
TYPE ST : STRUCT a : INT := 7 MOD 3; b : INT := MOD(7, 3); END_STRUCT; END_TYPE
VAR_GLOBAL CONSTANT C : INT := 7 MOD 3; END_VAR
PROGRAM Main
VAR i : INT := 7; q : PI; pi : POINTER TO INT; s : ST; END_VAR
q := ADR(i); pi := ADR(i);
i := q^ MOD 3 + (pi^ + 1) MOD 3 + MOD(q^, 2) + C + s.a;
END_PROGRAM
`;
        expect(errors(src, options)).toEqual([]);
      });
    });
  }
});

describe("REAL MOD and __DELETE in a test file", () => {
  const source = compile(`PROGRAM Main\nEND_PROGRAM\n`);
  const testErrors = (text: string): string[] => {
    const parsed = parseTestFile(text, "t.st");
    expect(parsed.errors).toEqual([]);
    return analyzeTestFile(
      parsed.testFile!,
      source.symbolTables!,
      source.ast,
    ).errors.map((e) => e.message);
  };

  it("refuses the operator and the function on a REAL, as in a source", () => {
    expect(
      testErrors(
        "TEST 't'\nVAR r : REAL := 5.5; l : LREAL; x : REAL; END_VAR\nx := r MOD 2;\nx := MOD(l, 2);\nEND_TEST\n",
      ),
    ).toEqual([mod("REAL"), mod("LREAL")]);
    expect(
      testErrors(
        "SETUP\nVAR g : REAL; END_VAR\nEND_SETUP\nTEARDOWN\ng := g MOD 2;\nEND_TEARDOWN\nTEST 't'\nVAR i : INT; END_VAR\ni := i MOD 2;\nEND_TEST\n",
      ),
    ).toEqual([mod("REAL")]);
  });

  it("refuses __DELETE of a REF_TO and __NEW into a REF_TO, as in a source", () => {
    expect(
      testErrors(
        "TEST 't'\nVAR r : REF_TO INT; p : POINTER TO INT; x : INT; END_VAR\nr := __NEW(INT);\n__DELETE(r);\n__DELETE(x);\np := __NEW(INT);\n__DELETE(p);\nEND_TEST\n",
      ),
    ).toEqual([
      "Cannot assign POINTER TO INT to REF_TO INT: a REF_TO can only hold a reference to its declared type",
      "__DELETE takes a POINTER TO variable (what __NEW returns), not REF_TO INT",
      "__DELETE takes a POINTER TO variable (what __NEW returns), not INT",
    ]);
  });

  it("reports a VAR's initial value once", () => {
    expect(
      testErrors("TEST 't'\nVAR x : REAL := 5.5 MOD 2; END_VAR\nEND_TEST\n"),
    ).toEqual([mod("REAL")]);
  });
});

describe("__DELETE takes a POINTER TO variable", () => {
  const del = (what: string): string =>
    `__DELETE takes a POINTER TO variable (what __NEW returns), not ${what}`;
  const src = (decl: string, line: string): string =>
    `TYPE PI : POINTER TO INT; END_TYPE
TYPE S : STRUCT p : PI; END_STRUCT; END_TYPE
PROGRAM Main
VAR ${decl} END_VAR
${line}
END_PROGRAM
`;

  for (const [label, options] of [
    ["no dialect", {}],
    ["strict", { strict: true }],
  ] as const) {
    it(`refuses a REF_TO, another type and a computed value (${label})`, () => {
      expect(
        errors(
          src("r : REF_TO INT; x : INT;", "r := REF(x);\n__DELETE(r);"),
          options,
        ),
      ).toEqual([del("REF_TO INT")]);
      expect(errors(src("x : INT;", "__DELETE(x);"), options)).toEqual([
        del("INT"),
      ]);
      expect(errors(src("x : INT;", "__DELETE(x + 1);"), options)).toEqual([
        del("a computed value"),
      ]);
      expect(
        errors(src("a : ARRAY[0..1] OF PI;", "__DELETE(a);"), options),
      ).toEqual([del("an ARRAY")]);
    });

    it(`refuses __NEW stored into a REF_TO (${label})`, () => {
      expect(
        errors(src("r : REF_TO INT;", "r := __NEW(INT);"), options),
      ).toEqual([
        "Cannot assign POINTER TO INT to REF_TO INT: a REF_TO can only hold a reference to its declared type",
      ]);
    });

    it(`accepts a POINTER TO, also by alias, member, element or reference (${label})`, () => {
      expect(
        errors(
          src(
            "p : POINTER TO INT; q : PI; s : S; a : ARRAY[0..1] OF PI; rp : REFERENCE TO PI;",
            "p := __NEW(INT); q := __NEW(INT); s.p := __NEW(INT); a[1] := __NEW(INT);\n__DELETE(p); __DELETE(q); __DELETE(s.p); __DELETE(a[1]); __DELETE((q));",
          ),
          options,
        ),
      ).toEqual([]);
    });
  }
});

describe("standard function argument counts in STRUCT field defaults", () => {
  for (const [label, options] of MODES) {
    it(`counts them as in a variable's initial value (${label})`, () => {
      const src = `TYPE S : STRUCT a : INT := LIMIT(1, 2); b : INT := MAX(1); c : INT := LIMIT(0, 5, 9); END_STRUCT; END_TYPE
PROGRAM Main
VAR s : S; END_VAR
s.a := 1;
END_PROGRAM
`;
      expect(errors(src, options)).toEqual([
        "'LIMIT' requires 3 argument(s), got 2",
        "'MAX' requires at least 2 argument(s), got 1",
      ]);
    });
  }
});
