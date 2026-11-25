// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Checks that were missing: an unknown named input of a library block, the
 * argument of a typed conversion, values of an alias type, scalar in/outs of
 * a library FUNCTION, ARRAY values of other bounds or element type, --strict
 * BYTE arithmetic through a dereference, Tables 30/31 in STRUCT defaults and
 * initializers, a POINTER TO result stored in a pointer, `0` into a METHOD's
 * interface result and an LTIME element of an initializer stored in a TIME.
 */
import * as path from "path";
import { describe, it, expect } from "vitest";
import { compile, compileStlib } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";
import { loadStlibArchive } from "../../src/library/library-loader.js";
import type { StlibArchive } from "../../src/library/library-manifest.js";

const LIBS = discoverStlibs(path.resolve(__dirname, "../../libs"));

type Options = Parameters<typeof compile>[1];

const diagnostics = (
  src: string,
  options: Options = {},
  libraries: StlibArchive[] = LIBS,
): { errors: string[]; warnings: string[] } => {
  const r = compile(src, { headerFileName: "g.hpp", libraries, ...options });
  return {
    errors: r.errors.map((e) => `${e.line}: ${e.message}`),
    warnings: r.warnings.map((e) => `${e.line}: ${e.message}`),
  };
};

const IEC: Options = { dialect: "iec-3" };
const STRICT: Options = { strict: true };

describe("unknown named input of a library block", () => {
  it("is an error in every mode (the C++ has no such member)", () => {
    const src = `PROGRAM Main
VAR c : CTU; s : SR; b : BOOL; END_VAR
c(CU := b, RESET := b, PV := 3);
s(S1 := b, RESET := b);
END_PROGRAM
`;
    for (const options of [{}, IEC, STRICT]) {
      expect(diagnostics(src, options).errors).toEqual([
        "3: CTU has no input or output named RESET",
        "4: SR has no input or output named RESET",
      ]);
    }
  });

  it("accepts the inputs a block inherits from a library base", () => {
    expect(
      diagnostics(`FUNCTION_BLOCK FB_T EXTENDS TON
END_FUNCTION_BLOCK
PROGRAM Main
VAR t : FB_T; q : BOOL; e : TIME; END_VAR
t(IN := TRUE, PT := T#5ms, Q => q, ET => e);
q := t.Q;
e := t.ET;
END_PROGRAM
`).errors,
    ).toEqual([]);
  });
});

describe("the argument of a typed conversion X_TO_Y is an X", () => {
  const conv = (body: string, options: Options = {}) =>
    diagnostics(
      `PROGRAM Main
VAR vd : DATE; t : TOD; r : REAL; s : STRING := '12'; d : DINT; tm : TIME;
  lt : LTIME; dt1 : DT; c : CHAR; END_VAR
${body}
END_PROGRAM
`,
      options,
    );

  it("refuses in every mode a 32-bit date or time of another kind (no C++ conversion)", () => {
    for (const options of [{}, IEC]) {
      expect(conv("t := DT_TO_TOD(vd);", options).errors).toEqual([
        "4: Argument 'IN' of 'DT_TO_TOD' expects DT, got DATE",
      ]);
      expect(conv("d := WORD_TO_DINT(tm);", options).errors).toEqual([
        "4: Argument 'IN' of 'WORD_TO_DINT' expects WORD, got TIME",
      ]);
      expect(conv("d := TIME_TO_DINT(d);", options).errors).toEqual([
        "4: Argument 'IN' of 'TIME_TO_DINT' expects TIME, got DINT",
      ]);
      expect(conv("d := CHAR_TO_DINT(s);", options).errors).toEqual([
        "4: Argument 'IN' of 'CHAR_TO_DINT' expects CHAR, got STRING",
      ]);
    }
    expect(conv("t := DT_TO_TOD(vd);", STRICT).errors).toEqual([
      "4: Implicit conversion from DATE to DT is not allowed; use DATE_TO_DT",
    ]);
  });

  it("warns by default where the C++ converts the value as its own type", () => {
    // iec-3 refuses it, unless it narrows a number (a warning, as into an input)
    for (const [body, iecError] of [
      ["d := INT_TO_DINT(r);", false],
      ["d := INT_TO_DINT(s);", true],
      ["d := TIME_TO_DINT(lt);", true],
    ] as const) {
      const by = conv(body);
      expect(by.errors).toEqual([]);
      expect(by.warnings).toHaveLength(1);
      expect(by.warnings[0]).toMatch(/^4: Argument 'IN' of '\w+' expects/);
      const iec = conv(body, IEC);
      expect(iecError ? iec.errors : iec.warnings).toEqual(by.warnings);
      expect(conv(body, STRICT).errors).toHaveLength(1);
    }
  });

  it("accepts an X, an implicit widening into X and the long form of a TIME", () => {
    for (const options of [{}, IEC, STRICT]) {
      const r = conv(
        `d := DT_TO_DINT(dt1);
d := LTIME_TO_DINT(tm);
d := TO_DINT(s);
d := REAL_TO_DINT(5);`,
        options,
      );
      expect(r.errors).toEqual([]);
      expect(r.warnings).toEqual([]);
    }
  });
});

describe("values of an alias type are checked as its base", () => {
  const src = `TYPE MyA : STRING(10); END_TYPE
TYPE MyB : REAL; END_TYPE
TYPE MyT : TIME; END_TYPE
FUNCTION F : INT VAR_INPUT x : INT; END_VAR F := x; END_FUNCTION
FUNCTION_BLOCK FB VAR_INPUT x : INT; END_VAR END_FUNCTION_BLOCK
PROGRAM Main
VAR a : MyA; b : MyB; t : MyT; i : INT; fb : FB; END_VAR
i := F(a);
i := F(b);
i := F(t);
fb(x := a);
i := a;
END_PROGRAM
`;
  it("refuses a STRING or TIME alias into an INT input or variable (g++ fails)", () => {
    for (const options of [{}, IEC]) {
      const r = diagnostics(src, options);
      expect(r.errors).toEqual([
        "8: Cannot assign STRING to INT",
        "10: Cannot assign TIME to INT",
        "11: Cannot assign STRING to INT",
        "12: Cannot assign MYA to INT",
      ]);
      expect(r.warnings).toEqual([
        "9: Implicit narrowing conversion from REAL to INT",
      ]);
    }
  });

  it("applies the --strict conversion rules to an alias", () => {
    expect(
      diagnostics(
        `TYPE MyB : REAL; END_TYPE
FUNCTION F : INT VAR_INPUT x : INT; END_VAR F := x; END_FUNCTION
PROGRAM Main
VAR b : MyB; i : INT; END_VAR
i := F(b);
i := b;
END_PROGRAM
`,
        STRICT,
      ).errors,
    ).toEqual([
      "5: Implicit conversion from REAL to INT is not allowed; use REAL_TO_INT",
      "6: Implicit conversion from REAL to INT is not allowed; use REAL_TO_INT",
    ]);
  });
});

describe("scalar in/outs of a library FUNCTION", () => {
  const lib = compileStlib(
    [
      {
        source: `FUNCTION F_IO : INT VAR_IN_OUT x : INT; END_VAR x := x + 1; F_IO := x; END_FUNCTION`,
        fileName: "lib.st",
      },
    ],
    { name: "lio", version: "1.0.0", namespace: "lio" },
  );
  const libs = [
    ...LIBS,
    loadStlibArchive(JSON.parse(JSON.stringify(lib.archive))),
  ];
  const src = `PROGRAM Main
VAR w : WORD; ui : UINT; i : INT; r : INT; END_VAR
r := F_IO(ui);
r := F_IO(w);
r := F_IO(i);
END_PROGRAM
`;
  it("warns and copies by default, refuses under iec-3 and --strict", () => {
    expect(lib.errors).toEqual([]);
    const by = diagnostics(src, {}, libs);
    expect(by.errors).toEqual([]);
    expect(by.warnings).toEqual([
      "3: VAR_IN_OUT 'X' of type INT is bound to a variable of type UINT; it is passed by copy-in / copy-out, not by reference",
      "4: VAR_IN_OUT 'X' of type INT is bound to a variable of type WORD; it is passed by copy-in / copy-out, not by reference",
    ]);
    expect(diagnostics(src, IEC, libs).errors).toEqual([
      "3: VAR_IN_OUT 'X' of type INT is bound to a variable of type UINT",
      "4: VAR_IN_OUT 'X' of type INT is bound to a variable of type WORD",
    ]);
    expect(diagnostics(src, STRICT, libs).errors).toEqual([
      "3: Implicit conversion from UINT to INT is not allowed; use UINT_TO_INT",
      "4: Implicit conversion from WORD to INT is not allowed; use WORD_TO_INT",
    ]);
  });
});

describe("an ARRAY stored in a fixed-size ARRAY", () => {
  const src = `FUNCTION F3 : INT VAR_INPUT a : ARRAY[1..3] OF INT; END_VAR F3 := a[1]; END_FUNCTION
PROGRAM Main
VAR a : ARRAY[1..3] OF INT; d : ARRAY[1..3] OF DINT; a4 : ARRAY[1..4] OF INT;
  w : ARRAY[1..3] OF WORD; t : ARRAY[1..3] OF TIME; z : ARRAY[0..2] OF INT; r : INT; END_VAR
r := F3(a);
r := F3(a4);
r := F3(d);
r := F3(w);
r := F3(t);
r := F3(z);
a := a4;
a := d;
d := a;
END_PROGRAM
`;
  it("refuses other bounds and element types without a conversion, warns on narrowing", () => {
    const r = diagnostics(src);
    expect(r.errors).toEqual([
      "6: Cannot store ARRAY[1..4] OF INT in input 'A' of type ARRAY[1..3] OF INT; the bounds differ",
      "9: Cannot store ARRAY[1..3] OF TIME in input 'A' of type ARRAY[1..3] OF INT",
      "10: Cannot store ARRAY[0..2] OF INT in input 'A' of type ARRAY[1..3] OF INT; the bounds differ",
      "11: Cannot store ARRAY[1..4] OF INT in a variable of type ARRAY[1..3] OF INT; the bounds differ",
    ]);
    expect(r.warnings).toEqual([
      "7: Cannot store ARRAY[1..3] OF DINT in input 'A' of type ARRAY[1..3] OF INT",
      "12: Cannot store ARRAY[1..3] OF DINT in a variable of type ARRAY[1..3] OF INT",
    ]);
  });

  it("refuses every other element type under --strict; iec-3 checks each element as a scalar", () => {
    const r = diagnostics(src, STRICT);
    expect(r.errors).toHaveLength(8);
    expect(r.errors).toContain(
      "8: Cannot store ARRAY[1..3] OF WORD in input 'A' of type ARRAY[1..3] OF INT",
    );
    expect(r.errors).toContain(
      "13: Cannot store ARRAY[1..3] OF INT in a variable of type ARRAY[1..3] OF DINT",
    );
    // A narrowing into an input warns under iec-3, as a scalar's does
    expect(diagnostics(src, IEC)).toEqual(diagnostics(src));
  });

  it("takes an ARRAY OF a subrange as an ARRAY OF its base", () => {
    const sub = `TYPE R : INT(0..10); END_TYPE
FUNCTION F3 : INT VAR_INPUT a : ARRAY[1..3] OF INT; END_VAR F3 := a[1]; END_FUNCTION
FUNCTION F4 : INT VAR_INPUT a : ARRAY[1..3] OF R; END_VAR F4 := a[1]; END_FUNCTION
PROGRAM Main
VAR a : ARRAY[1..3] OF INT; b : ARRAY[1..3] OF R; n : INT; END_VAR
n := F3(b);
n := F4(a);
a := b;
END_PROGRAM
`;
    for (const options of [{}, IEC, STRICT]) {
      expect(diagnostics(sub, options)).toEqual({ errors: [], warnings: [] });
    }
  });
});

describe("--strict arithmetic on a BYTE through a dereference", () => {
  it("is refused as on a BYTE variable", () => {
    const src = `PROGRAM Main
VAR b : BYTE; i : INT; pb : POINTER TO BYTE; pi : POINTER TO INT; END_VAR
pb := ADR(b);
pi := ADR(i);
b := pb^ + b;
i := pi^ + i;
pb := pb + 1;
END_PROGRAM
`;
    expect(diagnostics(src, STRICT).errors).toEqual([
      "5: Arithmetic on BYTE is not allowed; convert it to an integer type first",
    ]);
    expect(diagnostics(src).errors).toEqual([]);
  });
});

describe("Tables 30 and 31 in STRUCT field defaults and initializers", () => {
  it("refuses an operator a date or time does not take, in every mode", () => {
    const src = `TYPE S_D : STRUCT
  d : DINT := 5 + T#1s;
  t : TIME := T#1s + 5;
  ok : TIME := T#1s + T#2s;
  tt : TIME := T#1s * T#1s;
  n : TIME := T#1s * 2;
END_STRUCT END_TYPE
PROGRAM Main
VAR s : S_D;
  s2 : S_D := (n := T#1s * T#1s);
  a : ARRAY[1..2] OF TIME := [T#1s + 5, T#2s - T#1s];
END_VAR
END_PROGRAM
`;
    for (const options of [{}, IEC, STRICT]) {
      expect(
        diagnostics(src, options).errors.map((e) => e.split(";")[0]),
      ).toEqual([
        "10: Operator '*' does not apply to TIME and TIME",
        "11: Operator '+' does not apply to TIME and INT",
        "2: Operator '+' does not apply to INT and TIME",
        "3: Operator '+' does not apply to TIME and INT",
        "5: Operator '*' does not apply to TIME and TIME",
      ]);
    }
  });
});

describe("a POINTER TO result stored in a pointer", () => {
  it("is an address, not an integer", () => {
    const src = `FUNCTION F10 : POINTER TO INT VAR_INPUT x : INT; END_VAR F10 := 0; END_FUNCTION
PROGRAM Main
VAR p : POINTER TO INT; END_VAR
p := F10(1);
END_PROGRAM
`;
    for (const options of [{}, STRICT]) {
      const r = diagnostics(src, options);
      expect(r.errors).toEqual([]);
      expect(r.warnings).toEqual([]);
    }
  });
});

describe("0 stored in an interface result", () => {
  it("warns by default for a METHOD as for a FUNCTION, an error under iec-3 and --strict", () => {
    const src = `INTERFACE I_A END_INTERFACE
FUNCTION_BLOCK FB_A
METHOD MM : I_A MM := 0; END_METHOD
END_FUNCTION_BLOCK
FUNCTION F : I_A F := 0; END_FUNCTION
PROGRAM Main VAR fb : FB_A; END_VAR
END_PROGRAM
`;
    const by = diagnostics(src);
    expect(by.errors).toEqual([]);
    expect(by.warnings.sort()).toEqual([
      "3: Assigning 0 to interface I_A needs the feature interface_zero",
      "5: Assigning 0 to interface I_A needs the feature interface_zero",
    ]);
    for (const options of [IEC, STRICT]) {
      expect(diagnostics(src, options).errors.sort()).toEqual(by.warnings);
    }
  });
});

describe("an LTIME element of an initializer stored in a TIME", () => {
  const src = `TYPE S_T : STRUCT t : TIME; END_STRUCT END_TYPE
PROGRAM Main
VAR s : S_T := (t := LTIME#1s);
  a : ARRAY[1..2] OF TIME := [LTIME#2s, T#3s];
  sa : ARRAY[1..1] OF S_T := [(t := LTIME#4s)];
  v : TIME := LTIME#1s;
END_VAR
END_PROGRAM
`;
  const message =
    "Cannot assign LTIME to TIME without a conversion; use LTIME_TO_TIME";
  it("warns by default, a variable's own initial value included", () => {
    const r = diagnostics(src);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([
      `3: ${message}`,
      `4: ${message}`,
      `5: ${message}`,
      `6: ${message}`,
    ]);
  });

  it("is an error under iec-3 and --strict", () => {
    for (const options of [IEC, STRICT]) {
      expect(diagnostics(src, options).errors).toEqual([
        `3: ${message}`,
        `4: ${message}`,
        `5: ${message}`,
        `6: ${message}`,
      ]);
    }
  });

  it("warns on a STRUCT field default, a global and an assignment too", () => {
    const more = `TYPE MyT : TIME; END_TYPE
TYPE S_T2 : STRUCT t : TIME := LTIME#3s; m : MyT := LTIME#4s; END_STRUCT END_TYPE
VAR_GLOBAL g : TIME := LTIME#5s; END_VAR
PROGRAM Main
VAR lt : LTIME; t : TIME; END_VAR
t := lt;
END_PROGRAM
`;
    const r = diagnostics(more);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toHaveLength(4);
    expect(diagnostics(more, IEC).errors).toHaveLength(4);
  });
});

describe("a named argument of a library FUNCTION that replaces a standard one", () => {
  it("names the library and its parameters (OSCAT's DAY_OF_WEEK takes IDATE)", () => {
    const src = `PROGRAM Main
VAR r : INT; d : DATE := D#2026-11-25; END_VAR
r := DAY_OF_WEEK(IN := d);
r := DAY_OF_WEEK(IDATE := d);
END_PROGRAM
`;
    expect(diagnostics(src).errors).toEqual([
      "3: Function 'DAY_OF_WEEK' has no parameter named 'IN' (the FUNCTION of library oscat-basic; its parameters: IDATE)",
    ]);
  });
});

describe("a STRING into a CHAR or WCHAR conversion", () => {
  const conv = (body: string, options: Options = {}) =>
    diagnostics(
      `PROGRAM Main
VAR ws : WSTRING := "AB"; s : STRING := 'AB'; c : CHAR; i : INT; END_VAR
${body}
END_PROGRAM
`,
      options,
    );
  it("warns by default into a character (its first one), an error under iec-3 and --strict", () => {
    const by = conv("c := WCHAR_TO_CHAR(ws);");
    expect(by.errors).toEqual([]);
    expect(by.warnings).toEqual([
      "3: Argument 'IN' of 'WCHAR_TO_CHAR' expects WCHAR, got WSTRING",
    ]);
    expect(conv("c := WCHAR_TO_CHAR(ws);", IEC).errors).toEqual(by.warnings);
    expect(conv("c := WCHAR_TO_CHAR(ws);", STRICT).errors).toHaveLength(1);
  });
  it("refuses it in every mode into a number (no C++ conversion, or a wrong value)", () => {
    for (const body of ["i := WCHAR_TO_INT(ws);", "i := CHAR_TO_INT(s);"]) {
      expect(conv(body).errors).toHaveLength(1);
    }
  });
});

describe("a type or function block name used as a value", () => {
  it("is refused (no C++ value)", () => {
    const src = `TYPE MyS : STRUCT x : INT; END_STRUCT END_TYPE
PROGRAM Main
VAR r : INT; c : COMPLEX; END_VAR
r := MyS;
c := COMPLEX;
r := TON + 1;
END_PROGRAM
`;
    for (const options of [{}, IEC]) {
      expect(diagnostics(src, options).errors).toEqual([
        "4: 'MYS' names a type, not a value",
        "5: 'COMPLEX' names a type, not a value",
        "6: 'TON' names a function block, not a value",
      ]);
    }
  });
});

describe("Table 30 MOD in STRUCT defaults and initial values", () => {
  it("accepts TOD, DT and TIME MOD a TIME", () => {
    const src = `TYPE S_M : STRUCT a : TOD := TOD#01:30:00 MOD T#1h; b : TIME := T#90m MOD T#1h;
  c : DT := DT#2020-01-01-01:30:00 MOD T#1h; END_STRUCT END_TYPE
PROGRAM Main VAR s : S_M; u : S_M := (a := TOD#02:10:00 MOD T#1h); END_VAR
END_PROGRAM
`;
    for (const options of [{}, IEC, STRICT]) {
      expect(diagnostics(src, options).errors).toEqual([]);
    }
  });
});
