// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * The narrow-address refusal on the paths the first pass missed: with the
 * bundled libraries, through SEL/MUX/MOVE, library FUNCTION inputs, SUPER^,
 * interface methods, property setters, FOR, test-file output capture, and
 * the address expressions that are no address at all.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { compile, type CompileOptions } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";
import { parseTestFile } from "../../src/testing/test-parser.js";
import { analyzeTestFile } from "../../src/semantic/analyzer.js";

const LIBS_DIR = path.resolve(__dirname, "../../libs");
const libsAvailable = fs.existsSync(
  path.join(LIBS_DIR, "iec-std-functions.stlib"),
);
const libraries = libsAvailable ? discoverStlibs(LIBS_DIR) : [];

const TAIL = "use a POINTER TO or PVOID, or __XWORD, LWORD or ULINT";
const narrow = (at: string, op: string, t: string): string =>
  `${at}: ${op} gives a 64-bit address, which ${t} cannot hold; ${TAIL}`;
const errors = (src: string, opts: Partial<CompileOptions> = {}): string[] =>
  compile(src, opts)
    .errors.map((e) => `${e.line}:${e.column}: ${e.message}`)
    .sort();

describe.skipIf(!libsAvailable)("with the bundled libraries", () => {
  it("refuses ADR into a narrow integer: the library's ADR is the operator", () => {
    expect(
      errors(
        "PROGRAM P\nVAR x : INT; u : UDINT; END_VAR\nu := ADR(x);\nEND_PROGRAM\n",
        { libraries },
      ),
    ).toEqual([narrow("3:6", "ADR", "UDINT")]);
  });

  it("gates ADR in a test file on pointer_to with the libraries loaded", () => {
    const opts: Partial<CompileOptions> = { libraries, dialect: "iec-3" };
    const src = compile("PROGRAM P\nEND_PROGRAM\n", opts);
    expect(src.errors).toEqual([]);
    const parsed = parseTestFile(
      "TEST 'g'\nVAR x : INT; w : LWORD; END_VAR\nw := ADR(x);\nEND_TEST\n",
      "t.st",
      opts,
    );
    const all = [
      ...parsed.errors,
      ...analyzeTestFile(parsed.testFile!, src.symbolTables!, src.ast).errors,
    ].map((e) => `${e.line}:${e.column}: ${e.message}`);
    expect(all).toEqual(["3:6: ADR needs the feature pointer_to"]);
  });
});

const OO = `INTERFACE I
METHOD M : BOOL
VAR_INPUT q : UDINT; END_VAR
END_METHOD
PROPERTY Pr : UDINT
GET
END_GET
SET
END_SET
END_PROPERTY
END_INTERFACE
FUNCTION_BLOCK FB IMPLEMENTS I
VAR px : UDINT; END_VAR
METHOD M : BOOL
VAR_INPUT q : UDINT; END_VAR
M := TRUE;
END_METHOD
PROPERTY Pr : UDINT
GET
Pr := px;
END_GET
SET
px := Pr;
END_SET
END_PROPERTY
END_FUNCTION_BLOCK
`;
const OO_FEATURES: Partial<CompileOptions> = {
  features: ["+pointer_to", "+self_caret", "+property"],
};

describe("address stores the first pass missed", () => {
  it("refuses an ADR passed through SEL, MUX, MOVE, MIN, MAX and LIMIT", () => {
    expect(
      errors(`PROGRAM P
VAR x : INT; y : INT; c : BOOL; u : UDINT; w : LWORD; END_VAR
u := SEL(c, ADR(x), ADR(y));
u := MUX(1, ADR(x), ADR(y));
u := MOVE(ADR(x));
u := MAX(ADR(x), ADR(y));
u := MIN(ADR(x), ADR(y));
u := LIMIT(0, ADR(x), 10);
w := SEL(c, ADR(x), ADR(y));
w := MOVE(ADR(x));
END_PROGRAM
`),
    ).toEqual(
      [
        narrow("3:13", "ADR", "UDINT"),
        narrow("4:13", "ADR", "UDINT"),
        narrow("5:11", "ADR", "UDINT"),
        narrow("6:10", "ADR", "UDINT"),
        narrow("7:10", "ADR", "UDINT"),
        narrow("8:15", "ADR", "UDINT"),
      ].sort(),
    );
  });

  it("refuses ADR through SUPER^, an interface method and a property setter", () => {
    expect(
      errors(
        `${OO}FUNCTION_BLOCK FB2 EXTENDS FB
METHOD M : BOOL
VAR_INPUT q : UDINT; END_VAR
VAR x : INT; END_VAR
M := SUPER^.M(ADR(x));
END_METHOD
END_FUNCTION_BLOCK
PROGRAM P
VAR x : INT; fb : FB; itf : I; b : BOOL; END_VAR
itf := fb;
b := itf.M(q := ADR(x));
b := itf.M(ADR(x));
fb.Pr := ADR(x);
itf.Pr := ADR(x);
END_PROGRAM
`,
        OO_FEATURES,
      ),
    ).toEqual(
      [
        narrow("31:15", "ADR", "UDINT"),
        narrow("37:17", "ADR", "UDINT"),
        narrow("38:12", "ADR", "UDINT"),
        narrow("39:10", "ADR", "UDINT"),
        narrow("40:11", "ADR", "UDINT"),
      ].sort(),
    );
  });

  it("refuses an __XWORD or PVOID value stored into a narrow integer", () => {
    expect(
      errors(
        `FUNCTION F : BOOL
VAR_INPUT d : UDINT; END_VAR
F := TRUE;
END_FUNCTION
PROGRAM P
VAR x : INT; xw : __XWORD; pv : PVOID; u : UDINT; w : LWORD; b : BOOL; i : INT; END_VAR
xw := ADR(x);
pv := ADR(x);
u := xw;
u := pv;
w := xw;
b := F(xw);
i := xw;
END_PROGRAM
`,
        { features: ["+pointer_to", "+platform_types"] },
      ),
    ).toEqual(
      [
        narrow("9:6", "__XWORD", "UDINT"),
        narrow("10:6", "__XWORD", "UDINT"),
        narrow("12:8", "__XWORD", "UDINT"),
        narrow("13:6", "__XWORD", "INT"),
      ].sort(),
    );
  });

  it("refuses a METHOD's pointer output captured into a narrow integer", () => {
    expect(
      errors(`FUNCTION_BLOCK FB
VAR z : INT; END_VAR
METHOD M : BOOL
VAR_OUTPUT o : POINTER TO INT; END_VAR
o := ADR(z);
M := TRUE;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM P
VAR fb : FB; u : UDINT; b : BOOL; END_VAR
b := fb.M(o => u);
END_PROGRAM
`),
    ).toEqual([
      `11:16: The output 'o' gives a 64-bit address, which UDINT cannot hold; ${TAIL}`,
    ]);
  });

  it("refuses ADR as a narrow FOR control variable's start, end or step", () => {
    expect(
      errors(`PROGRAM P
VAR x : INT; u : UDINT; i : DINT; END_VAR
FOR u := ADR(x) TO 10 DO i := i + 1; END_FOR
FOR i := 0 TO ADR(x) DO u := 1; END_FOR
FOR i := 0 TO 10 BY ADR(x) DO u := 1; END_FOR
END_PROGRAM
`),
    ).toEqual(
      [
        narrow("3:10", "ADR", "UDINT"),
        narrow("4:15", "ADR", "DINT"),
        narrow("5:21", "ADR", "DINT"),
      ].sort(),
    );
  });

  it("gives only the binding error for ADR bound to a VAR_IN_OUT (#5)", () => {
    expect(
      errors(`FUNCTION FIO : BOOL
VAR_IN_OUT io : UDINT; END_VAR
FIO := TRUE;
END_FUNCTION
PROGRAM P
VAR x : INT; b : BOOL; END_VAR
b := FIO(io := ADR(x));
END_PROGRAM
`),
    ).toEqual([
      "7:16: VAR_IN_OUT 'io' must be bound to a variable, not an expression",
    ]);
  });

  it("refuses a pointer output captured into a narrow integer in a test file (#14)", () => {
    const src = compile(
      `FUNCTION_BLOCK FB
VAR_OUTPUT o : POINTER TO INT; END_VAR
END_FUNCTION_BLOCK
PROGRAM P
END_PROGRAM
`,
    );
    expect(src.errors).toEqual([]);
    const parsed = parseTestFile(
      "TEST 'c'\nVAR u : UDINT; fb : FB; END_VAR\nfb(o => u);\nEND_TEST\n",
      "t.st",
    );
    expect(parsed.errors).toEqual([]);
    expect(
      analyzeTestFile(parsed.testFile!, src.symbolTables!, src.ast).errors.map(
        (e) => `${e.line}:${e.column}: ${e.message}`,
      ),
    ).toEqual([
      `3:9: The output 'o' gives a 64-bit address, which UDINT cannot hold; ${TAIL}`,
    ]);
  });

  it("refuses an address in a CASE selector, negated, scaled, summed or into a non-integer (#6)", () => {
    const offset = "An address can only be offset by + or - an integer";
    expect(
      errors(`PROGRAM P
VAR x : INT; y : INT; u : UDINT; w : LWORD; r : REAL; lr : LREAL; b : BOOL; t : TIME; END_VAR
CASE ADR(x) OF 1: u := 1; END_CASE
w := ADR(x) + ADR(y);
u := -ADR(x);
w := -ADR(x);
w := ADR(x) * 2;
w := (ADR(x) * 2) + 1;
w := NOT ADR(x);
w := ADR(x) OR 0;
r := ADR(x);
lr := ADR(x);
b := ADR(x);
t := ADR(x);
END_PROGRAM
`),
    ).toEqual(
      [
        "3:6: A CASE selector cannot be an address",
        `4:6: ${offset}`,
        `5:6: ${offset}`,
        `6:6: ${offset}`,
        `7:6: ${offset}`,
        `8:6: ${offset}`,
        `9:6: ${offset}`,
        `10:6: ${offset}`,
        narrow("11:6", "ADR", "REAL"),
        narrow("12:7", "ADR", "LREAL"),
        narrow("13:6", "ADR", "BOOL"),
        narrow("14:6", "ADR", "TIME"),
      ].sort(),
    );
  });
});
