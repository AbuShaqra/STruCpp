/**
 * Arguments bound to VAR_IN_OUT parameters (IEC 61131-3 Ed. 3 6.6.1.4.1 rule
 * 2, 6.6.1.6, 6.6.3.4.2 / Figure 13). An in-out refers to a variable, so a
 * literal, an expression, a bit of a variable or a constant is an error in
 * every dialect. The forms that compile by copy or with the previous binding
 * (another type, an omitted in-out, an outside write, a caller's VAR_INPUT)
 * are warnings without a dialect and under a vendor profile, errors under
 * `iec-3`.
 */
import { describe, it, expect } from "vitest";
import { analyze } from "../../src/index.js";
import type { DialectProfile } from "../../src/dialect.js";

type Options = Parameters<typeof analyze>[1];

const VENDOR: DialectProfile = {
  id: "vendor",
  name: "vendor",
  extends: "iec-3",
  features: ["reference_to"],
  semantics: {},
};

const LENIENT: { name: string; options: Options }[] = [
  { name: "no dialect", options: {} },
  { name: "a vendor profile", options: { dialect: VENDOR } },
];
const IEC: Options = { dialect: "iec-3" };

const DECLS = `TYPE T_AL : INT; END_TYPE
FUNCTION_BLOCK FB_I
VAR_IN_OUT x : INT; END_VAR
  x := x + 1;
END_FUNCTION_BLOCK
FUNCTION FN : INT
VAR_IN_OUT x : INT; END_VAR
  x := x + 1;
  FN := x;
END_FUNCTION
FUNCTION_BLOCK FB_S
VAR_IN_OUT s : STRING; END_VAR
  s := 'a';
END_FUNCTION_BLOCK
`;

function program(vars: string, body: string): string {
  return `${DECLS}PROGRAM MAIN
VAR f : FB_I; fs : FB_S; r : INT; ${vars} END_VAR
${body}
END_PROGRAM
`;
}

const FIRST_BODY_LINE = DECLS.split("\n").length + 2;

function diagnostics(
  source: string,
  options: Options,
): { errors: string[]; warnings: string[] } {
  const result = analyze(source, options);
  const show = (d: { line: number; message: string }): string =>
    `${d.line - FIRST_BODY_LINE + 1}: ${d.message}`;
  return {
    errors: result.errors.map(show),
    warnings: result.warnings
      .filter((w) => w.message.includes("VAR_IN_OUT"))
      .map(show),
  };
}

describe("arguments of VAR_IN_OUT parameters", () => {
  describe("not a variable: an error in every dialect", () => {
    const cases: Array<[string, string, string, string]> = [
      ["a literal", "", "f(x := 5);", "not a literal"],
      ["an expression", "a : INT;", "f(x := a + 1);", "not an expression"],
      [
        "a bit of a variable",
        "w : WORD;",
        "f(x := w.3);",
        "not a bit of a variable",
      ],
      [
        "a constant",
        "END_VAR VAR CONSTANT c : INT := 1;",
        "f(x := c);",
        "not the constant 'C'",
      ],
      ["a literal (function)", "", "r := FN(x := 5);", "not a literal"],
    ];
    for (const options of [...LENIENT.map((m) => m.options), IEC]) {
      for (const [what, vars, body, text] of cases) {
        it(`${what} (${JSON.stringify(options)})`, () => {
          const d = diagnostics(program(vars, body), options);
          expect(d.errors).toEqual([
            `1: VAR_IN_OUT 'X' must be bound to a variable, ${text}`,
          ]);
        });
      }
    }
  });

  const softCases: Array<{
    what: string;
    vars: string;
    body: string;
    error: string;
    fallback: string;
  }> = [
    {
      what: "another elementary type",
      vars: "b : SINT;",
      body: "f(x := b);",
      error: "VAR_IN_OUT 'X' of type INT is bound to a variable of type SINT",
      fallback: "it is passed by copy-in / copy-out, not by reference",
    },
    {
      what: "an alias of the parameter's type",
      vars: "b : T_AL;",
      body: "f(x := b);",
      error: "VAR_IN_OUT 'X' of type INT is bound to a variable of type T_AL",
      fallback: "it is passed by copy-in / copy-out, not by reference",
    },
    {
      what: "a STRING of another length",
      vars: "s : STRING(10);",
      body: "fs(s := s);",
      error:
        "VAR_IN_OUT 'S' of type STRING is bound to a variable of type STRING(10)",
      fallback: "it is passed by copy-in / copy-out, not by reference",
    },
    {
      what: "another type (function)",
      vars: "b : DINT;",
      body: "r := FN(x := b);",
      error: "VAR_IN_OUT 'X' of type INT is bound to a variable of type DINT",
      fallback: "it is passed by copy-in / copy-out, not by reference",
    },
    {
      what: "an omitted in-out of a function block",
      vars: "",
      body: "f();",
      error: "VAR_IN_OUT 'X' is not assigned in this call",
      fallback: "the call keeps the binding of the previous call",
    },
    {
      what: "an omitted in-out of a function",
      vars: "",
      body: "r := FN();",
      error: "VAR_IN_OUT 'X' is not assigned in this call",
      fallback: "a temporary is passed in its place",
    },
  ];

  describe("forms that compile: warnings outside iec-3", () => {
    for (const mode of LENIENT) {
      for (const c of softCases) {
        it(`${c.what} (${mode.name})`, () => {
          const d = diagnostics(program(c.vars, c.body), mode.options);
          expect(d.errors).toEqual([]);
          expect(d.warnings).toEqual([`1: ${c.error}; ${c.fallback}`]);
        });
      }
    }
  });

  describe("forms that compile: errors under iec-3", () => {
    for (const c of softCases) {
      it(c.what, () => {
        const d = diagnostics(program(c.vars, c.body), IEC);
        expect(d.errors).toEqual([`1: ${c.error}`]);
      });
    }
  });

  it("refuses reading or writing an instance's in-out from outside, in every dialect", () => {
    const message =
      "'X' is a VAR_IN_OUT of FUNCTION_BLOCK 'FB_I'; from outside it is bound in the call, not accessed through the instance";
    for (const options of [...LENIENT.map((m) => m.options), IEC]) {
      for (const body of ["f(x := a); f.x := 3;", "f(x := a); a := f.x;"]) {
        const d = diagnostics(program("a : INT;", body), options);
        expect(d.errors).toEqual([`1: ${message}`]);
      }
    }
  });

  it("a caller's VAR_INPUT bound to an in-out", () => {
    const source = `${DECLS}FUNCTION_BLOCK FB_C
VAR_INPUT i : INT; END_VAR
VAR f : FB_I; END_VAR
  f(x := i);
END_FUNCTION_BLOCK
`;
    const message =
      "VAR_IN_OUT 'X' is bound to the input 'I', which this POU may not modify";
    for (const mode of LENIENT) {
      expect(
        analyze(source, mode.options).warnings.map((w) => w.message),
      ).toEqual([`${message}; the callee writes the input`]);
    }
    expect(analyze(source, IEC).errors.map((e) => e.message)).toEqual([
      message,
    ]);
  });

  it("accepts the properly mapped forms in every dialect", () => {
    const source = `${DECLS}TYPE ST_P : STRUCT a : INT; END_STRUCT; END_TYPE
FUNCTION_BLOCK FB_P
VAR_IN_OUT p : ST_P; x : INT; END_VAR
VAR inner : FB_I; END_VAR
  inner(x := x);
  inner(x := p.a);
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR fp : FB_P; st : ST_P; arr : ARRAY[1..2] OF INT; a : INT; r : INT; END_VAR
VAR_TEMP t : INT; END_VAR
  fp(p := st, x := arr[1]);
  fp(st, a);
  fp(p := st, x := t);
  r := FN(x := st.a);
END_PROGRAM
`;
    for (const options of [...LENIENT.map((m) => m.options), IEC]) {
      const result = analyze(source, options);
      expect(result.errors).toEqual([]);
      expect(
        result.warnings.filter((w) => w.message.includes("VAR_IN_OUT")),
      ).toEqual([]);
    }
  });

  it("an inherited in-out is checked through EXTENDS", () => {
    const source = `${DECLS}FUNCTION_BLOCK FB_D EXTENDS FB_I
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR d : FB_D; END_VAR
  d();
END_PROGRAM
`;
    expect(analyze(source, IEC).errors.map((e) => e.message)).toEqual([
      "VAR_IN_OUT 'X' is not assigned in this call",
    ]);
  });
});
