// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Pointer, reference and alias forms that passed the check and failed g++ or
 * ran wrong, now refused or accepted as they build:
 * - `__NEW` stored into what is no 64-bit integer or pointer is refused;
 * - `ADR(i)` of a value that is no pointer into a POINTER TO POINTER TO;
 * - `ADR(d)` of another type into a REF_TO (assignment and input);
 * - an integer function result or conversion into a POINTER TO input;
 * - `ps^ + b`, `ps^ = 1` through a POINTER TO STRING;
 * - `p^ := 65` into a dereferenced CHAR warns (an error under --strict);
 * - REFERENCE TO an ARRAY (inline or alias) bound to an array of other bounds;
 * - REFERENCE TO POINTER TO T accepted, its bindings checked;
 * - a library STRING(n) alias REFERENCE TO bound to another length;
 * - a FOR loop over a POINTER TO with a pointer-alias end gets no warning.
 * Pinned: `p := 5` warns by default and is an error under --strict.
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
  options: Options = {},
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

const clean = { errors: [], warnings: [] };

describe("__NEW stored into a value", () => {
  it("refuses it into an integer narrower than an address or no integer", () => {
    expect(
      run(
        "",
        "i : INT; r : REAL; s : STRING;",
        "i := __NEW(INT);\nr := __NEW(INT);\ns := __NEW(INT);",
      ).errors,
    ).toEqual([
      `1: ${holds("__NEW", "INT")}`,
      `2: ${holds("__NEW", "REAL")}`,
      `3: ${holds("__NEW", "STRING")}`,
    ]);
  });

  it("accepts it into a POINTER TO, a STRUCT member and an LWORD", () => {
    expect(
      run(
        "TYPE S : STRUCT p : POINTER TO INT; END_STRUCT END_TYPE\nTYPE PA : POINTER TO ARRAY[0..3] OF INT; END_TYPE\n",
        "p : POINTER TO INT; s : S; pa : PA; lw : LWORD;",
        "p := __NEW(INT);\ns.p := __NEW(INT);\npa := __NEW(INT, 4);\nlw := __NEW(INT);",
      ),
    ).toEqual(clean);
  });
});

describe("ADR into a POINTER TO POINTER TO", () => {
  const decls =
    "FUNCTION F : INT\nVAR_INPUT pp : POINTER TO POINTER TO INT; END_VAR\nF := pp^^;\nEND_FUNCTION\n";
  const message =
    "POINTER TO POINTER TO INT holds the address of a POINTER TO INT, not of a INT";

  it("refuses the address of a value that is no pointer", () => {
    expect(
      run(
        decls,
        "i : INT; r : INT; pp : POINTER TO POINTER TO INT;",
        "r := F(ADR(i));\npp := ADR(i);",
      ).errors,
    ).toEqual([`1: ${message}`, `2: ${message}`]);
  });

  it("accepts the address of a pointer", () => {
    expect(
      run(
        decls,
        "i : INT; p : POINTER TO INT; r : INT;",
        "p := ADR(i);\nr := F(ADR(p));",
      ),
    ).toEqual(clean);
  });
});

describe("ADR into a REF_TO", () => {
  const decls =
    "FUNCTION F : INT\nVAR_INPUT r : REF_TO INT; END_VAR\nF := r^;\nEND_FUNCTION\n";
  const message =
    "Cannot assign REF_TO DINT to REF_TO INT: a REF_TO can only hold a reference to its declared type";

  it("refuses the address of another type, as an input and in an assignment", () => {
    expect(
      run(
        decls,
        "d : DINT; rr : REF_TO INT; x : INT;",
        "x := F(ADR(d));\nrr := ADR(d);",
      ).errors,
    ).toEqual([`1: ${message}`, `2: ${message}`]);
  });

  it("accepts the address of its target type", () => {
    expect(run(decls, "i : INT; x : INT;", "x := F(ADR(i));")).toEqual(clean);
  });
});

describe("an integer into a POINTER TO input", () => {
  const decls = `FUNCTION F : INT
VAR_INPUT p : POINTER TO INT; END_VAR
F := 0;
END_FUNCTION
FUNCTION G : INT
G := 5;
END_FUNCTION
FUNCTION GP : POINTER TO INT
GP := 0;
END_FUNCTION
`;
  const message =
    "An integer cannot be passed to the POINTER TO input 'P'; pass an address (ADR) or 0";

  it("refuses a function result and a conversion", () => {
    expect(
      run(decls, "r : INT; d : DINT;", "r := F(G());\nr := F(DINT_TO_INT(d));")
        .errors,
    ).toEqual([`1: ${message}`, `2: ${message}`]);
  });

  it("accepts a POINTER TO result and the dereference of a POINTER TO POINTER TO", () => {
    expect(
      run(
        decls,
        "r : INT; i : INT; q : POINTER TO INT; pp : POINTER TO POINTER TO INT;",
        "q := ADR(i);\npp := ADR(q);\nr := F(GP());\nr := F(pp^);",
      ),
    ).toEqual(clean);
  });
});

describe("a POINTER TO ARRAY into an integer input", () => {
  it("is refused once, as the address it is", () => {
    expect(
      run(
        "",
        "s : STRING; pa : POINTER TO ARRAY[0..1] OF INT; r : STRING;",
        "r := LEFT(s, pa);",
      ).errors,
    ).toEqual([`1: ${holds("A POINTER TO value", "INT")}`]);
  });
});

describe("a dereferenced POINTER TO STRING", () => {
  const vars =
    "s : STRING; ps : POINTER TO STRING; b : INT; x : INT; t : BOOL;";

  it("refuses arithmetic and a comparison with a number", () => {
    expect(run("", vars, "x := ps^ + b;\nt := ps^ = 1;").errors).toEqual([
      "1: Operator '+' does not apply to STRING; join strings with CONCAT",
      "2: Cannot compare STRING with INT",
    ]);
  });

  it("accepts a comparison with a string and of the pointer with 0", () => {
    expect(
      run("", vars, "t := ps^ = 'ab';\nt := ps^ < s;\nt := ps > 0;"),
    ).toEqual(clean);
  });
});

describe("a number stored into a dereferenced CHAR", () => {
  const vars = "c : CHAR; p : POINTER TO CHAR; b : BYTE;";

  it("warns by default and is an error under --strict", () => {
    expect(run("", vars, "p^ := 65;\np^ := b;")).toEqual({
      errors: [],
      warnings: [
        "1: Cannot assign INT to CHAR",
        "2: Cannot assign BYTE to CHAR",
      ],
    });
    expect(run("", vars, "p^ := 65;", { strict: true }).errors).toEqual([
      "1: Cannot assign INT to CHAR",
    ]);
  });

  it("accepts a character", () => {
    expect(run("", vars, "p^ := 'A';\np^ := c;")).toEqual(clean);
  });
});

describe("REFERENCE TO an ARRAY", () => {
  const decls = `TYPE TA : ARRAY[0..2] OF INT; END_TYPE
FUNCTION F : INT
VAR_INPUT ra : REFERENCE TO ARRAY[0..2] OF INT; END_VAR
F := ra[1];
END_FUNCTION
`;
  const vars =
    "a3 : ARRAY[0..3] OF INT; a : ARRAY[0..2] OF INT; ta : TA; d : ARRAY[0..2] OF DINT; i : INT; p : POINTER TO INT; ra : REFERENCE TO ARRAY[0..2] OF INT; rt : REFERENCE TO TA; r : INT;";

  it("refuses an array of other bounds or element type, or no array", () => {
    expect(
      run(
        decls,
        vars,
        "ra REF= a3;\nra REF= d;\nra REF= i;\nra REF= p;\nrt REF= a3;\nr := F(d);",
      ).errors,
    ).toEqual([
      "1: REFERENCE TO ARRAY[0..2] OF INT cannot refer to a ARRAY[0..3] OF INT variable",
      "2: REFERENCE TO ARRAY[0..2] OF INT cannot refer to a ARRAY[0..2] OF DINT variable",
      "3: REFERENCE TO ARRAY[0..2] OF INT cannot refer to a INT variable",
      "4: REFERENCE TO ARRAY[0..2] OF INT cannot refer to a POINTER TO INT variable",
      "5: REFERENCE TO TA cannot refer to a ARRAY[0..3] OF INT variable",
      "6: REFERENCE TO ARRAY[0..2] OF INT cannot refer to a ARRAY[0..2] OF DINT variable",
    ]);
  });

  it("accepts an array of the same shape, inline or by alias, and its initial value", () => {
    expect(
      run(
        decls,
        `${vars} ri : REFERENCE TO ARRAY[0..2] OF INT := REF(a);`,
        "ra REF= a;\nra REF= ta;\nrt REF= a;\nrt REF= ra;\nr := F(a);\nr := F(ta);\nr := ra[1] + rt[2];",
      ),
    ).toEqual(clean);
  });

  it("parses one in a STRUCT, a FUNCTION_BLOCK input and a VAR", () => {
    const r =
      compile(`TYPE S : STRUCT ra : REFERENCE TO ARRAY[0..2] OF INT; END_STRUCT END_TYPE
FUNCTION_BLOCK FB
VAR_INPUT ra : REFERENCE TO ARRAY[1..2, 0..1] OF REAL; END_VAR
END_FUNCTION_BLOCK
PROGRAM Main
VAR s : S; a : ARRAY[0..2] OF INT; END_VAR
s.ra REF= a;
END_PROGRAM
`);
    expect(r.errors).toEqual([]);
  });
});

describe("REFERENCE TO POINTER TO", () => {
  const vars =
    "i : INT; q : POINTER TO INT; d : POINTER TO DINT; rp : REFERENCE TO POINTER TO INT; q2 : POINTER TO INT; r : INT;";

  it("binds to a POINTER TO of its target type and reads through it", () => {
    expect(
      run(
        "",
        vars,
        "rp REF= q;\nrp := ADR(i);\nr := rp^;\nrp^ := 3;\nq2 := rp;",
      ),
    ).toEqual(clean);
  });

  it("refuses a value or a pointer of another type", () => {
    expect(run("", vars, "rp REF= i;\nrp REF= d;").errors).toEqual([
      "1: REFERENCE TO POINTER TO INT cannot refer to a INT variable",
      "2: REFERENCE TO POINTER TO INT cannot refer to a POINTER TO DINT variable",
    ]);
  });

  it("still refuses a level stacked on a REFERENCE TO", () => {
    const r = compile(
      "PROGRAM Main\nVAR a : POINTER TO REFERENCE TO INT; b : REFERENCE TO REFERENCE TO INT; END_VAR\nEND_PROGRAM\n",
    );
    expect(r.errors.map((e) => e.message)).toEqual([
      "REFERENCE TO cannot be combined with other reference levels in PROGRAM 'MAIN'",
      "REFERENCE TO cannot be combined with other reference levels in PROGRAM 'MAIN'",
    ]);
  });

  it("dereferences a REFERENCE TO a pointer alias", () => {
    expect(
      run(
        "TYPE PI : POINTER TO INT; END_TYPE\n",
        "i : INT; q : PI; rp : REFERENCE TO PI; r : INT;",
        "rp REF= q;\nrp := ADR(i);\nr := rp^;",
      ),
    ).toEqual(clean);
  });
});

describe("a library STRING alias bound by REFERENCE TO", () => {
  const library = (): StlibArchive => {
    const lib = compileStlib(
      [{ source: "TYPE TS : STRING(20); END_TYPE\n", fileName: "lib.st" }],
      { name: "slib", version: "1.0.0", namespace: "slib" },
    );
    expect(lib.errors).toEqual([]);
    return JSON.parse(JSON.stringify(lib.archive)) as StlibArchive;
  };

  it("refuses a STRING of another length, as a local alias does", () => {
    const r = compile(
      "PROGRAM Main\nVAR s : STRING(20); s80 : STRING; rt : REFERENCE TO TS; END_VAR\nrt REF= s;\nrt REF= s80;\nEND_PROGRAM\n",
      { libraries: [loadStlibArchive(library())] },
    );
    expect(r.errors.map((e) => `${e.line}: ${e.message}`)).toEqual([
      "4: REFERENCE TO STRING(20) cannot refer to a STRING variable",
    ]);
  });
});

describe("FOR over a POINTER TO", () => {
  it("takes a POINTER TO alias end without a type warning", () => {
    expect(
      run(
        "TYPE PINT : POINTER TO INT; END_TYPE\n",
        "x : ARRAY[0..3] OF INT; p : POINTER TO INT; e : PINT;",
        "e := ADR(x[3]);\nFOR p := ADR(x) TO e DO\n  p^ := 1;\nEND_FOR;",
      ),
    ).toEqual(clean);
  });
});

describe("pinned: a non-zero integer into a POINTER TO", () => {
  const message =
    "An integer is not an address; a POINTER TO takes ADR(...), another pointer or 0";

  it("warns by default and is an error under --strict", () => {
    expect(run("", "p : POINTER TO INT;", "p := 5;")).toEqual({
      errors: [],
      warnings: [`1: ${message}`],
    });
    expect(
      run("", "p : POINTER TO INT;", "p := 5;", { strict: true }).errors,
    ).toEqual([`1: ${message}`]);
  });
});
