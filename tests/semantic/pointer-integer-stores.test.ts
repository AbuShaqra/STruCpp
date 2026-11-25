// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Stores between pointers and integers by assignment:
 * - a POINTER TO or REF_TO assigned to an integer narrower than an address
 *   (`n := p`) warns by default and is refused under iec-3 and --strict; into
 *   LWORD, ULINT or LINT it is accepted (a REF_TO there builds as its address);
 * - an integer narrower than an address, or a difference of two addresses,
 *   assigned to a POINTER TO warns by default and is refused under iec-3 and
 *   --strict; a 64-bit integer there is accepted without a narrowing warning;
 * - a misaligning move of a POINTER TO is refused also in a global's initial
 *   value and for a POINTER TO ARRAY or STRUCT;
 * - `pb := pb + 1` on a POINTER TO BYTE is no BYTE arithmetic under --strict.
 * Pinned: REF of an INT member of a library STRUCT into REF_TO DINT is
 * refused, REF of a STRING(20) into a library REF_TO STRING(20) input is
 * accepted, and a namespace-qualified library call is refused.
 */
import { describe, it, expect } from "vitest";
import { compile, compileStlib } from "../../src/index.js";
import { loadStlibArchive } from "../../src/library/library-loader.js";
import type { StlibArchive } from "../../src/library/library-manifest.js";

type Options = Parameters<typeof compile>[1];

const run = (
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

const holds = (what: string, into: string): string =>
  `${what} gives a 64-bit address, which ${into} cannot hold; use a POINTER TO or PVOID, or __XWORD, LWORD or ULINT`;

describe("a POINTER TO or REF_TO assigned to an integer", () => {
  const decls = "TYPE S_A : STRUCT a : DWORD; b : LWORD; END_STRUCT END_TYPE\n";
  const vars =
    "p : POINTER TO INT; r : REF_TO INT; x : INT; dw : DWORD; i : INT; ud : UDINT; lw : LWORD; ul : ULINT; li : LINT; f : S_A;";
  const narrow = "dw := p;\ni := p;\nud := r;\nf.a := p;\ndw := r;";
  const expected = [
    `1: ${holds("A POINTER TO value", "DWORD")}`,
    `2: ${holds("A POINTER TO value", "INT")}`,
    `3: ${holds("A REF_TO value", "UDINT")}`,
    `4: ${holds("A POINTER TO value", "DWORD")}`,
    `5: ${holds("A REF_TO value", "DWORD")}`,
  ];

  it("warns when it is narrower than an address (no dialect)", () => {
    expect(run(decls, vars, narrow, {})).toEqual({
      errors: [],
      warnings: expected,
    });
  });

  it("refuses it under --strict", () => {
    expect(run(decls, vars, narrow, { strict: true }).errors).toEqual(expected);
  });

  it("refuses a REF_TO under iec-3", () => {
    expect(
      run("", "r : REF_TO INT; dw : DWORD; ud : UDINT;", "dw := r;\nud := r;", {
        dialect: "iec-3",
      }).errors,
    ).toEqual([
      `1: ${holds("A REF_TO value", "DWORD")}`,
      `2: ${holds("A REF_TO value", "UDINT")}`,
    ]);
  });

  for (const options of [{}, { strict: true }] as Options[]) {
    it(`accepts LWORD, ULINT and LINT (${JSON.stringify(options)})`, () => {
      expect(
        run(
          decls,
          vars,
          "lw := p;\nul := r;\nli := p;\nf.b := p;\nlw := r;",
          options,
        ),
      ).toEqual({ errors: [], warnings: [] });
    });
  }

  it("keeps an ADR into a narrow integer an error in every mode", () => {
    expect(run(decls, vars, "dw := ADR(x);", {}).errors).toEqual([
      `1: ${holds("ADR", "DWORD")}`,
    ]);
  });
});

describe("an integer assigned to a POINTER TO", () => {
  const vars =
    "d : DINT; d2 : DINT; p : POINTER TO DINT; p2 : POINTER TO DINT; i : INT; di : DINT; lw : LWORD; ul : ULINT;";
  const body =
    "p := ADR(d) - ADR(d2);\np := p - p2;\np := di;\np := i + 4;\np := 4;";
  const difference =
    "A difference of two addresses is a byte count, not an address; a POINTER TO takes ADR(...), another pointer or 0";
  const integer =
    "An integer is not an address; a POINTER TO takes ADR(...), another pointer or 0";
  const expected = [
    `1: ${difference}`,
    `2: ${difference}`,
    `3: ${integer}`,
    `4: ${integer}`,
    `5: ${integer}`,
  ];

  it("warns by default", () => {
    expect(run("", vars, body, {})).toEqual({ errors: [], warnings: expected });
  });

  it("refuses it under --strict", () => {
    expect(run("", vars, body, { strict: true }).errors).toEqual(expected);
  });

  for (const options of [{}, { strict: true }] as Options[]) {
    it(`accepts 0, an address, a pointer and a 64-bit integer (${JSON.stringify(options)})`, () => {
      expect(
        run(
          "",
          vars,
          "p := 0;\np := ADR(d) + 4;\np := p2 + 4;\np := lw;\np := ul + 8;",
          options,
        ),
      ).toEqual({ errors: [], warnings: [] });
    });
  }
});

describe("misaligned pointer moves", () => {
  const misaligned = (target: string, by: number, multiple: number): string =>
    `Moving a POINTER TO ${target} by ${by} byte(s) would make its dereference misaligned; move it by a multiple of ${multiple} bytes`;

  for (const options of [{}, { strict: true }] as Options[]) {
    it(`are refused in a global's initial value (${JSON.stringify(options)})`, () => {
      const r = compile(
        "VAR_GLOBAL gd : DINT; gp : POINTER TO DINT := ADR(gd) + 1; gq : POINTER TO DINT := ADR(gd) + 4; END_VAR\nPROGRAM Main\nVAR d : DINT; END_VAR\nd := gq^;\nEND_PROGRAM\n",
        options,
      );
      expect(r.errors.map((e) => `${e.line}: ${e.message}`)).toEqual([
        `1: ${misaligned("DINT", 1, 4)}`,
      ]);
    });

    it(`are refused for a POINTER TO ARRAY or STRUCT (${JSON.stringify(options)})`, () => {
      const r = run(
        "TYPE ST2 : STRUCT a : DINT; b : DINT; END_STRUCT END_TYPE\nTYPE AR : ARRAY[0..3] OF LINT; END_TYPE\n",
        "arr : ARRAY[0..3] OF DINT; s : ST2; ar : AR; b : ARRAY[0..7] OF BYTE; pa : POINTER TO ARRAY[0..3] OF DINT; ps : POINTER TO ST2; pr : POINTER TO AR;",
        "pa := ADR(arr) + 1;\npa := ADR(arr) + 4;\nps := ADR(s) + 2;\nps := ADR(s) + 8;\npr := ADR(ar) + 4;\npa := ADR(b) + 1;",
        options,
      );
      expect(r.errors).toEqual([
        `1: ${misaligned("ARRAY OF DINT", 1, 4)}`,
        `3: ${misaligned("ST2", 2, 4)}`,
        `5: ${misaligned("AR", 4, 8)}`,
      ]);
    });
  }
});

describe("POINTER TO BYTE arithmetic under --strict", () => {
  it("moves the address, with no BYTE arithmetic refused", () => {
    const r = run(
      "",
      "pb : POINTER TO BYTE; pw : POINTER TO WORD; b : BYTE; i : INT; di : DINT;",
      "pb := pb + 1;\npb := pb + i;\npw := pw + 2;\npb := ADR(b) + di;",
      { strict: true },
    );
    expect(r.errors).toEqual([]);
  });

  it("still refuses arithmetic on a BYTE value", () => {
    const r = run(
      "",
      "pb : POINTER TO BYTE; b : BYTE;",
      "pb := pb + 1;\nb := b + b;",
      { strict: true },
    );
    expect(r.errors).toEqual([
      "2: Arithmetic on BYTE is not allowed; convert it to an integer type first",
    ]);
  });
});

describe("library references (pinned)", () => {
  const LIB = `TYPE LS : STRUCT i : INT; d : DINT; END_STRUCT END_TYPE
FUNCTION F_R : INT
VAR_INPUT r : REF_TO DINT; END_VAR
F_R := 1;
END_FUNCTION
FUNCTION F_RS : INT
VAR_INPUT r : REF_TO STRING(20); END_VAR
F_RS := LEN(r^);
END_FUNCTION
FUNCTION_BLOCK FB_RS
VAR_INPUT r : REF_TO STRING(20); END_VAR
VAR_OUTPUT n : INT; END_VAR
n := LEN(r^);
END_FUNCTION_BLOCK
`;
  const library = (): StlibArchive => {
    const lib = compileStlib([{ source: LIB, fileName: "lib.st" }], {
      name: "plib",
      version: "1.0.0",
      namespace: "plib",
    });
    expect(lib.errors).toEqual([]);
    return JSON.parse(JSON.stringify(lib.archive)) as StlibArchive;
  };
  const errors = (vars: string, body: string): string[] =>
    compile(
      `PROGRAM Main\nVAR x : INT; n : INT; ${vars} END_VAR\n${body}\nEND_PROGRAM\n`,
      { libraries: [loadStlibArchive(library())] },
    ).errors.map((e) => e.message);

  it("refuses REF of an INT member of a library STRUCT into REF_TO DINT", () => {
    expect(errors("ls : LS;", "n := F_R(REF(ls.i));")).toEqual([
      "Cannot assign REF_TO INT to REF_TO DINT: a REF_TO can only hold a reference to its declared type",
    ]);
    expect(errors("ls : LS;", "n := F_R(REF(ls.d));")).toEqual([]);
  });

  it("accepts REF of a STRING(20) into a library REF_TO STRING(20) input", () => {
    expect(
      errors(
        "s20 : STRING(20); fb : FB_RS;",
        "fb(r := REF(s20));\nn := F_RS(REF(s20));",
      ),
    ).toEqual([]);
  });

  it("refuses a namespace-qualified library call without the feature library_namespaces", () => {
    expect(errors("", "n := plib.F_R(REF(x));")).toEqual([
      "Qualifying 'F_R' by the namespace of library plib needs the feature library_namespaces",
    ]);
  });
});

describe("an integer into a POINTER TO reached through a STRUCT, an alias or a result", () => {
  const decls = `TYPE ST_Q : STRUCT p : POINTER TO DINT; a : ARRAY[0..1] OF POINTER TO DINT; END_STRUCT END_TYPE
TYPE PDI : POINTER TO DINT; END_TYPE
FUNCTION F_DW : DWORD
F_DW := 0;
END_FUNCTION
`;
  const vars =
    "d : DINT; q : ST_Q; qa : ARRAY[0..1] OF ST_Q; pst : POINTER TO ST_Q; lw : LWORD; udi : UDINT; dw : DWORD; ppd : PDI; pd : POINTER TO DINT;";
  const member =
    "A POINTER TO member of a STRUCT cannot take an integer; assign ADR(...), another pointer or 0";
  const integer =
    "An integer is not an address; a POINTER TO takes ADR(...), another pointer or 0";

  for (const options of [{}, { strict: true }] as Options[]) {
    it(`refuses any integer into a STRUCT member, no C++ conversion exists (${JSON.stringify(options)})`, () => {
      expect(
        run(
          decls,
          vars,
          "pst := ADR(q);\nq.p := lw;\nq.p := udi;\npst^.p := dw;\npst^.p := lw;\nqa[1].p := lw;",
          options,
        ).errors,
      ).toEqual([2, 3, 4, 5, 6].map((l) => `${l}: ${member}`));
    });
  }

  it("warns about a narrow integer into a pointer alias or from a function result", () => {
    expect(run(decls, vars, "ppd := udi;\npd := F_DW();", {})).toEqual({
      errors: [],
      warnings: [`1: ${integer}`, `2: ${integer}`],
    });
    expect(
      run(decls, vars, "ppd := udi;\npd := F_DW();", { strict: true }).errors,
    ).toEqual([`1: ${integer}`, `2: ${integer}`]);
  });

  it("accepts 0 and an address into a STRUCT member, and a 64-bit integer into an element", () => {
    expect(
      run(decls, vars, "q.p := 0;\nq.p := ADR(d);\nq.a[0] := lw;\nppd := lw;", {
        strict: true,
      }),
    ).toEqual({ errors: [], warnings: [] });
  });
});

describe("STRUCT members: a POINTER TO alias, and a STRUCT through a REFERENCE TO", () => {
  const decls = `TYPE PINT : POINTER TO INT; END_TYPE
TYPE ST_Q : STRUCT p : POINTER TO DINT; pa : PINT; END_STRUCT END_TYPE
`;
  const vars =
    "q : ST_Q; qa : ARRAY[0..1] OF ST_Q; rq : REFERENCE TO ST_Q; lw : LWORD; udi : UDINT;";
  const integer =
    "An integer is not an address; a POINTER TO takes ADR(...), another pointer or 0";
  const member =
    "A POINTER TO member of a STRUCT cannot take an integer; assign ADR(...), another pointer or 0";

  it("follows the alias rule for a member of a POINTER TO alias type (it converts)", () => {
    expect(
      run(decls, vars, "q.pa := lw;\nqa[1].pa := lw;\nq.pa := udi;", {}),
    ).toEqual({ errors: [], warnings: [`3: ${integer}`] });
    expect(
      run(decls, vars, "q.pa := lw;\nq.pa := udi;", { strict: true }).errors,
    ).toEqual([`2: ${integer}`]);
  });

  for (const options of [{}, { strict: true }] as Options[]) {
    it(`refuses an integer into a member reached through a REFERENCE TO (${JSON.stringify(options)})`, () => {
      expect(
        run(decls, vars, "rq REF= q;\nrq.p := lw;\nrq.p := 7;", options).errors,
      ).toEqual([`2: ${member}`, `3: ${member}`]);
    });
  }
});
