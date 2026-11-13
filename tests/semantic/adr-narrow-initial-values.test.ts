/**
 * ADR(x) for an integer narrower than an address is refused in every initial
 * value: a top-level or CONFIGURATION global, an array literal element and a
 * structure initializer element, nested. An address-wide integer takes it.
 * POINTER TO and ADR in a test file follow pointer_to.
 */
import { describe, it, expect } from "vitest";
import { compile, type CompileOptions } from "../../src/index.js";
import { parseTestFile } from "../../src/testing/test-parser.js";

const TAIL = "use a POINTER TO or PVOID, or __XWORD, LWORD or ULINT";

describe("ADR into a narrower integer in an initial value", () => {
  it("is refused in globals, array literals and structure initializers", () => {
    const src = `TYPE ST_A : STRUCT f : UDINT; w : __XWORD; END_STRUCT; END_TYPE
TYPE T_A : ARRAY[0..1] OF DWORD; END_TYPE
FUNCTION_BLOCK FB_D
VAR_INPUT d : UDINT; END_VAR
END_FUNCTION_BLOCK
VAR_GLOBAL gx : INT; gu : UDINT := ADR(gx); ga : T_A := [ADR(gx), ADR(gx)]; gw : ARRAY[0..1] OF __XWORD := [ADR(gx), ADR(gx)]; END_VAR
CONFIGURATION C
VAR_GLOBAL cx : INT; cu : UDINT := ADR(cx); END_VAR
RESOURCE R ON PLC
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM I WITH T : MAIN;
END_RESOURCE
END_CONFIGURATION
PROGRAM MAIN
VAR
  x, y : INT;
  arr : ARRAY[0..1] OF UDINT := [ADR(x), ADR(y)];
  s : ST_A := (f := ADR(x));
  fb : FB_D := (d := ADR(x));
END_VAR
END_PROGRAM
`;
    for (const opts of [{}, { strict: true }]) {
      expect(
        compile(src, opts as Partial<CompileOptions>)
          .errors.map((e) => `${e.line}:${e.column}: ${e.message}`)
          .sort(),
      ).toEqual(
        [
          `6:36: ADR gives a 64-bit address, which UDINT cannot hold; ${TAIL}`,
          `6:58: ADR gives a 64-bit address, which DWORD cannot hold; ${TAIL}`,
          `6:67: ADR gives a 64-bit address, which DWORD cannot hold; ${TAIL}`,
          `8:36: ADR gives a 64-bit address, which UDINT cannot hold; ${TAIL}`,
          `17:34: ADR gives a 64-bit address, which UDINT cannot hold; ${TAIL}`,
          `17:42: ADR gives a 64-bit address, which UDINT cannot hold; ${TAIL}`,
          `18:21: ADR gives a 64-bit address, which UDINT cannot hold; ${TAIL}`,
          `19:22: ADR gives a 64-bit address, which UDINT cannot hold; ${TAIL}`,
        ].sort(),
      );
    }
  });

  it("accepts an address-wide element", () => {
    const src = `TYPE ST_A : STRUCT w : __XWORD; END_STRUCT; END_TYPE
PROGRAM MAIN
VAR x : INT; arr : ARRAY[0..1] OF ULINT := [ADR(x), ADR(x)]; s : ST_A := (w := ADR(x)); END_VAR
END_PROGRAM
`;
    expect(
      compile(src).errors.filter((e) => e.message.startsWith("ADR gives")),
    ).toEqual([]);
  });
});

describe("POINTER TO and ADR in a test file", () => {
  const TESTS = `TEST 'p'
VAR v : INT; p : POINTER TO INT; END_VAR
  p := ADR(v);
END_TEST
`;
  it("are refused without pointer_to", () => {
    expect(
      parseTestFile(TESTS, "t.st", { dialect: "iec-3" }).errors.map(
        (e) => `${e.line}:${e.column}: ${e.message}`,
      ),
    ).toEqual([
      "2:18: POINTER TO needs the feature pointer_to",
      "3:8: ADR needs the feature pointer_to",
    ]);
  });
  it("are accepted with it", () => {
    expect(parseTestFile(TESTS, "t.st").errors).toEqual([]);
    expect(
      parseTestFile(TESTS, "t.st", {
        dialect: "iec-3",
        features: ["+pointer_to"],
      }).errors,
    ).toEqual([]);
  });
});

describe("ADR into a narrower integer in a body or an FB input", () => {
  it("is refused in an assignment, a FUNCTION result and an FB input", () => {
    const src = `FUNCTION_BLOCK FB_D
VAR_INPUT d : UDINT; w : LWORD; END_VAR
END_FUNCTION_BLOCK
FUNCTION F : DWORD
VAR x : INT; END_VAR
F := ADR(x);
END_FUNCTION
PROGRAM MAIN
VAR
  x : INT; fb : FB_D;
  u : UDINT; dw : DWORD; di : DINT; i : INT; ui : UINT; wd : WORD; b : BYTE; si : SINT; us : USINT;
  lw : LWORD; ul : ULINT; p : POINTER TO INT;
END_VAR
u := ADR(x); dw := ADR(x); di := ADR(x); i := ADR(x); ui := ADR(x);
wd := ADR(x); b := ADR(x); si := ADR(x); us := ADR(x);
lw := ADR(x); ul := ADR(x); p := ADR(x);
fb(d := ADR(x), w := ADR(x));
END_PROGRAM
`;
    const narrow = (line: number, col: number, t: string): string =>
      `${line}:${col}: ADR gives a 64-bit address, which ${t} cannot hold; ${TAIL}`;
    for (const opts of [{}, { strict: true }]) {
      expect(
        compile(src, opts as Partial<CompileOptions>)
          .errors.map((e) => `${e.line}:${e.column}: ${e.message}`)
          .sort(),
      ).toEqual(
        [
          narrow(6, 6, "DWORD"),
          narrow(14, 6, "UDINT"),
          narrow(14, 20, "DWORD"),
          narrow(14, 34, "DINT"),
          narrow(14, 47, "INT"),
          narrow(14, 61, "UINT"),
          narrow(15, 7, "WORD"),
          narrow(15, 20, "BYTE"),
          narrow(15, 34, "SINT"),
          narrow(15, 48, "USINT"),
          narrow(17, 9, "UDINT"),
        ].sort(),
      );
    }
  });
});
