// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Each input argument is checked as the assignment `input := argument` is, on
 * every call form (FUNCTION, FB, METHOD through any receiver, an interface,
 * `SUPER^`, `p^(...)`, `s.f(...)`, `arr[0](...)`, EN, a library FUNCTION):
 * a type the C++ build cannot convert (a STRING, a 32-bit TIME, DATE, TOD or
 * DT) is refused in every mode; another type the assignment refuses (an L
 * form, a signed integer into an unsigned one) warns by default and is
 * refused under iec-3 and --strict; narrowing warns only into a BOOL input
 * outside --strict. An address or scalar into an ARRAY or STRUCT input is
 * refused.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { compile, compileStlib } from "../../src/index.js";
import { loadStlibArchive } from "../../src/library/library-loader.js";
import { discoverStlibs } from "../../src/node/library-loader.js";
import type { StlibArchive } from "../../src/library/library-manifest.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];

const DECLS = `FUNCTION F_DW : INT
VAR_INPUT x : DWORD; END_VAR
F_DW := 0;
END_FUNCTION
FUNCTION F_B : INT
VAR_INPUT b : BOOL; END_VAR
F_B := 0;
END_FUNCTION
FUNCTION F_I : INT
VAR_INPUT x : INT; END_VAR
F_I := x;
END_FUNCTION
FUNCTION F_UI : INT
VAR_INPUT x : UINT; END_VAR
F_UI := 0;
END_FUNCTION
FUNCTION F_T : INT
VAR_INPUT t : TIME; END_VAR
F_T := 0;
END_FUNCTION
`;

/** Errors and warnings of `body` in a program after `decls`, as `line: message`. */
const diagnostics = (
  decls: string,
  vars: string,
  body: string,
  options: Options,
): { errors: string[]; warnings: string[] } => {
  const header = `${decls}PROGRAM Main\nVAR ${vars} END_VAR\n`;
  const first = header.split("\n").length;
  const r = compile(`${header}${body}\nEND_PROGRAM\n`, options);
  const show = (e: { line: number; message: string }): string =>
    `${e.line - first + 1}: ${e.message}`;
  return { errors: r.errors.map(show), warnings: r.warnings.map(show) };
};

describe("argument types follow the assignment rule", () => {
  const vars =
    "s : STRING; ws : WSTRING; t : TIME; d : DATE; tod1 : TOD; dt1 : DT; n : INT; w : DWORD;";
  for (const [label, options] of MODES) {
    it(`refuses a type no C++ conversion takes (${label})`, () => {
      const r = diagnostics(
        DECLS,
        vars,
        [
          "n := F_DW(s);",
          "n := F_DW(x := ws);",
          "n := F_B(t);",
          "n := F_B(d);",
          "n := F_DW(tod1);",
          "n := F_T(dt1);",
          "n := F_I('7');",
        ].join("\n"),
        options,
      );
      expect(r.errors).toEqual([
        "1: Cannot assign STRING to DWORD",
        "2: Cannot assign WSTRING to DWORD",
        "3: Cannot assign TIME to BOOL",
        "4: Cannot assign DATE to BOOL",
        "5: Cannot assign TOD to DWORD",
        "6: Cannot assign DT to TIME",
        "7: Cannot assign STRING to INT",
      ]);
    });
  }

  it("warns about a refused type C++ converts, by default only", () => {
    const vars2 = "si : SINT; lt : LTIME; ld : LDATE; n : INT;";
    const body = "n := F_UI(si);\nn := F_I(lt);\nn := F_DW(ld);";
    const def = diagnostics(DECLS, vars2, body, {});
    expect(def.errors).toEqual([]);
    expect(def.warnings).toEqual([
      "1: Cannot pass SINT to an input of type UINT without a conversion; use SINT_TO_UINT",
      "2: Cannot pass LTIME to an input of type INT without a conversion; use LTIME_TO_INT",
      "3: Cannot pass LDATE to an input of type DWORD without a conversion; use LDATE_TO_DWORD",
    ]);
    expect(
      diagnostics(DECLS, vars2, body, { dialect: "iec-3" }).errors,
    ).toEqual([
      "1: Cannot assign SINT to UINT",
      "2: Cannot assign LTIME to INT",
      "3: Cannot assign LDATE to DWORD",
    ]);
    expect(diagnostics(DECLS, vars2, body, { strict: true }).errors).toEqual([
      "1: Implicit conversion from SINT to UINT is not allowed; use SINT_TO_UINT",
      "2: Cannot assign LTIME to INT",
      "3: Cannot assign LDATE to DWORD",
    ]);
  });

  it("keeps non-BOOL narrowing silent outside --strict, as before", () => {
    const body = "n := F_I(di);\nn := F_I(r);";
    for (const options of [{}, { dialect: "iec-3" }] as Options[]) {
      const r = diagnostics(
        DECLS,
        "di : DINT; r : REAL; n : INT;",
        body,
        options,
      );
      expect(r).toEqual({ errors: [], warnings: [] });
    }
    expect(
      diagnostics(DECLS, "di : DINT; r : REAL; n : INT;", body, {
        strict: true,
      }).errors,
    ).toEqual([
      "1: Implicit conversion from DINT to INT is not allowed; use DINT_TO_INT",
      "2: Implicit conversion from REAL to INT is not allowed; use REAL_TO_INT",
    ]);
  });

  it("accepts matching, widening and untyped constant arguments", () => {
    for (const [, options] of MODES) {
      const r = diagnostics(
        DECLS,
        "w : DWORD; i : INT; b : BOOL; t : TIME; n : INT; si : SINT;",
        "n := F_DW(w);\nn := F_I(si);\nn := F_B(b);\nn := F_T(t);\nn := F_I(5);\nn := F_DW(16#FF);\nn := F_B(TRUE);",
        options,
      );
      expect(r.errors).toEqual([]);
      expect(r.warnings).toEqual([]);
    }
  });

  it("refuses an untyped integer into a TIME input, as its assignment", () => {
    const body = "n := F_T(100);";
    for (const options of [{}, { dialect: "iec-3" }] as Options[]) {
      expect(diagnostics(DECLS, "n : INT;", body, options).errors).toEqual([
        "1: Cannot assign INT to TIME",
      ]);
    }
    expect(
      diagnostics(DECLS, "n : INT;", body, { strict: true }).errors,
    ).toEqual([
      "1: An integer cannot be used as TIME; write a TIME literal such as T#100ms",
    ]);
  });
});

describe("the BOOL input warning on every call form", () => {
  const SOURCE = `INTERFACE I_X
METHOD M : BOOL
VAR_INPUT b : BOOL; END_VAR
END_METHOD
END_INTERFACE
FUNCTION_BLOCK FBase IMPLEMENTS I_X
VAR_INPUT b : BOOL; END_VAR
METHOD M : BOOL
VAR_INPUT b : BOOL; END_VAR
M := b;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FChild EXTENDS FBase
VAR i : INT; END_VAR
METHOD M : BOOL
VAR_INPUT b : BOOL; END_VAR
M := SUPER^.M(b := i);
END_METHOD
END_FUNCTION_BLOCK
TYPE S_W : STRUCT f : FBase; END_STRUCT END_TYPE
TYPE TB : BOOL; END_TYPE
FUNCTION FA : BOOL
VAR_INPUT x : TB; END_VAR
FA := x;
END_FUNCTION
FUNCTION FT : BOOL
VAR_INPUT x : BOOL; END_VAR
FT := x;
END_FUNCTION
PROGRAM Main
VAR it : I_X; fb : FBase; p : POINTER TO FBase; s : S_W; arr : ARRAY[0..1] OF FBase;
 i : INT; t : TIME; d : DATE; bb : BOOL; tb : TB; ton1 : TON; END_VAR
it := fb;
p := ADR(fb);
bb := it.M(i);
p^(b := i);
s.f(b := i);
arr[0](b := i);
ton1(EN := i, IN := bb, PT := t);
bb := FA(i);
tb := i;
END_PROGRAM
`;
  const lines = [17, 35, 36, 37, 38, 39, 40, 41];
  const libsDir = path.resolve(__dirname, "../../libs");
  const libraries = fs.existsSync(path.join(libsDir, "iec-standard-fb.stlib"))
    ? discoverStlibs(libsDir)
    : [];

  it("warns by default, as `b := i` does", () => {
    const r = compile(SOURCE, { libraries });
    expect(r.errors).toEqual([]);
    // The method body (line 17) is checked after the program.
    expect(r.warnings.map((w) => `${w.line}: ${w.message}`).sort()).toEqual(
      lines.map((l) => `${l}: Implicit narrowing conversion from INT to BOOL`),
    );
  });

  it("refuses it under --strict, an alias of BOOL included", () => {
    const r = compile(SOURCE, { strict: true, libraries });
    expect(r.errors.map((e) => `${e.line}: ${e.message}`).sort()).toEqual(
      lines.map(
        (l) =>
          `${l}: Implicit conversion from INT to BOOL is not allowed; use INT_TO_BOOL`,
      ),
    );
  });

  it("refuses a TIME or DATE into a BOOL input, as `b := t` is", () => {
    const r = compile(
      SOURCE.replace("tb := i;", "bb := FT(t);\nbb := FT(d);\nfb(b := t);"),
      { libraries },
    );
    expect(r.errors.map((e) => `${e.line}: ${e.message}`)).toEqual([
      "41: Cannot assign TIME to BOOL",
      "42: Cannot assign DATE to BOOL",
      "43: Cannot assign TIME to BOOL",
    ]);
  });

  it("keeps a TP, TON or TOF preset taking an LTIME (Table 46)", () => {
    for (const [, options] of MODES) {
      const r = compile(
        "PROGRAM Main\nVAR t : TON; p : LTIME := LT#1s; END_VAR\nt(IN := TRUE, PT := p);\nt(IN := TRUE, PT := LT#2s);\nEND_PROGRAM\n",
        { ...options, libraries },
      );
      expect(r.errors).toEqual([]);
    }
  });
});

describe("a library FUNCTION's arguments", () => {
  const LIB = `TYPE TDw2 : DWORD; END_TYPE
FUNCTION F_LB : BOOL
VAR_INPUT x : DWORD; b : BOOL; END_VAR
F_LB := b;
END_FUNCTION
FUNCTION F_LA : INT
VAR_INPUT x : TDw2; END_VAR
F_LA := 1;
END_FUNCTION
`;
  const library = (): StlibArchive => {
    const lib = compileStlib([{ source: LIB, fileName: "lib.st" }], {
      name: "argtypes",
      version: "1.0.0",
      namespace: "argtypes",
    });
    expect(lib.errors).toEqual([]);
    return JSON.parse(JSON.stringify(lib.archive)) as StlibArchive;
  };

  it("are checked as a FUNCTION of the project's are", () => {
    const libraries = [loadStlibArchive(library())];
    const run = (body: string, options: Options = {}) =>
      compile(
        `PROGRAM Main\nVAR w : DWORD; x : INT; s : STRING; b : BOOL; n : INT; END_VAR\n${body}\nEND_PROGRAM\n`,
        { ...options, libraries },
      );
    expect(run("b := F_LB(w, x);").warnings.map((w) => w.message)).toEqual([
      "Implicit narrowing conversion from INT to BOOL",
    ]);
    expect(run("b := F_LB(w, 'abc');").errors.map((e) => e.message)).toEqual([
      "Cannot assign STRING to BOOL",
    ]);
    expect(run("b := F_LB(s, b);").errors.map((e) => e.message)).toEqual([
      "Cannot assign STRING to DWORD",
    ]);
    expect(
      run("b := F_LB(w, x);", { strict: true }).errors.map((e) => e.message),
    ).toEqual([
      "Implicit conversion from INT to BOOL is not allowed; use INT_TO_BOOL",
    ]);
    expect(run("b := F_LB(w, b);\nn := F_LA(w);").errors).toEqual([]);
  });

  it("refuses an ADR into an input of a library alias of DWORD", () => {
    const r = compile(
      "PROGRAM Main\nVAR x : INT; n : INT; END_VAR\nn := F_LA(ADR(x));\nEND_PROGRAM\n",
      { libraries: [loadStlibArchive(library())] },
    );
    expect(r.errors.map((e) => e.message)).toEqual([
      "ADR gives a 64-bit address, which DWORD cannot hold; use a POINTER TO or PVOID, or __XWORD, LWORD or ULINT",
    ]);
  });
});

describe("an ARRAY or STRUCT input", () => {
  const SOURCE = (
    body: string,
  ): string => `TYPE ST : STRUCT a : INT; END_STRUCT END_TYPE
FUNCTION FA : INT
VAR_INPUT a : ARRAY[0..1] OF INT; END_VAR
FA := a[0];
END_FUNCTION
FUNCTION FS : INT
VAR_INPUT s : ST; END_VAR
FS := s.a;
END_FUNCTION
PROGRAM Main
VAR x : INT; n : INT; arr : ARRAY[0..1] OF INT; s : ST; p : POINTER TO INT; END_VAR
${body}
END_PROGRAM
`;

  for (const [label, options] of [MODES[0]!, MODES[2]!]) {
    it(`refuses an address or a scalar (${label})`, () => {
      const r = compile(
        SOURCE(
          "n := FA(ADR(arr));\nn := FS(ADR(s));\nn := FA(p);\nn := FS(x);\nn := FA(a := x);",
        ),
        options,
      );
      expect(r.errors.map((e) => `${e.line}: ${e.message}`)).toEqual([
        "12: Cannot pass an address to input 'A', which takes an ARRAY",
        "13: Cannot pass an address to input 'S', which takes a STRUCT",
        "14: Cannot pass an address to input 'A', which takes an ARRAY",
        "15: Cannot pass a value of type INT to input 'S', which takes a STRUCT",
        "16: Cannot pass a value of type INT to input 'A', which takes an ARRAY",
      ]);
    });

    it(`accepts the array or STRUCT itself (${label})`, () => {
      expect(
        compile(SOURCE("n := FA(arr);\nn := FS(s);"), options).errors,
      ).toEqual([]);
    });
  }
});
