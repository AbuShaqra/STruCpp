/**
 * E2E: the bounds of an ARRAY, in a named type or written inline, may be
 * integer literals, constants (a POU's VAR CONSTANT, a VAR_GLOBAL CONSTANT in
 * any file, a -D constant), enumeration values and arithmetic on them. A
 * bound that is not a constant is an error.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const GVL = `VAR_GLOBAL CONSTANT
  HI : INT := 3;
  DOUBLE : INT := HI * 2;
END_VAR
`;

const MAIN = `TYPE E2 : (A, B, C); END_TYPE
TYPE EV : (X := 2, Y := 5); END_TYPE
TYPE TA : ARRAY[0..HI] OF INT; END_TYPE
TYPE TB : ARRAY[E2#A..E2#C] OF INT; END_TYPE
TYPE TC : ARRAY[1..DOUBLE, 0..HI - 2] OF INT; END_TYPE
TYPE TD : ARRAY[EV.X..EV.Y] OF INT; END_TYPE
TYPE TN : ARRAY[0..NDEF] OF INT; END_TYPE
TYPE SS : STRUCT f : ARRAY[0..HI] OF INT; g : ARRAY[A..C] OF BOOL; END_STRUCT END_TYPE
VAR_GLOBAL
  ga : ARRAY[0..DOUBLE] OF INT;
END_VAR
FUNCTION Size : DINT
VAR_INPUT v : ARRAY[0..HI] OF INT; END_VAR
  Size := UPPER_BOUND(v, 1) - LOWER_BOUND(v, 1) + 1;
END_FUNCTION
FUNCTION_BLOCK FB_A
VAR CONSTANT LOCAL_HI : INT := HI + 1; END_VAR
VAR m : ARRAY[0..LOCAL_HI] OF INT; e : ARRAY[E2#A..E2#B] OF INT; END_VAR
VAR_OUTPUT o : DINT; END_VAR
  o := UPPER_BOUND(m, 1) * 10 + UPPER_BOUND(e, 1);
END_FUNCTION_BLOCK
PROGRAM Main
VAR
  a : TA; b : TB; c : TC; d : TD; t : TN; s : SS;
  l : ARRAY[E2#A..E2#B] OF INT;
  l2 : ARRAY[0..HI, EV#X..EV#Y] OF INT;
  l3 : ARRAY[-HI..HI] OF INT;
  l4 : ARRAY[0..GVL_K.HI] OF INT;
  fb : FB_A;
  n1, n2, n3, n4, n5, n6, n7, n8, n9 : DINT;
END_VAR
VAR_EXTERNAL ga : ARRAY[0..DOUBLE] OF INT; END_VAR
  n1 := UPPER_BOUND(a, 1) * 10 + UPPER_BOUND(b, 1);
  c[DOUBLE, 1] := 61;
  n2 := c[6, 1];
  n3 := LOWER_BOUND(d, 1) * 10 + UPPER_BOUND(d, 1);
  n4 := UPPER_BOUND(s.f, 1) * 10 + UPPER_BOUND(s.g, 1);
  l2[HI, 5] := 35;
  n5 := UPPER_BOUND(l, 1) * 100 + l2[3, 5];
  n6 := LOWER_BOUND(l3, 1) + UPPER_BOUND(ga, 1) * 10;
  a[HI] := 7; l[TO_INT(E2#B)] := 8;
  n7 := Size(a) + a[3] + l[1];
  fb();
  n8 := fb.o;
  n9 := UPPER_BOUND(t, 1) + UPPER_BOUND(l4, 1);
END_PROGRAM
`;

const SOURCES = {
  fileName: "main.st",
  additionalSources: [{ source: GVL, fileName: "GVL_K.st" }],
  globalConstants: { NDEF: 6 },
};

const MODES: Array<[string, Parameters<typeof compile>[1]]> = [
  ["features", { features: ["+named_global_lists"] }],
  ["iec-3 features", { dialect: "iec-3", features: ["+named_global_lists"] }],
  ["strict", { strict: true, features: ["+named_global_lists"] }],
];

function errorsFor(source: string): string[] {
  return compile(source, {}).errors.map((e) => e.message);
}

describe("constant array bounds", () => {
  it.each(MODES)("are accepted (%s)", (_name, options) => {
    const r = compile(MAIN, { ...SOURCES, ...options });
    expect(r.errors.map((e) => e.message)).toEqual([]);
  });

  it("gives a named array type its declared bounds", () => {
    const r = compile(MAIN, { ...SOURCES, ...MODES[0]![1] });
    expect(r.headerCode).toContain("using TA = Array1D<IEC_INT, 0, 3>;");
    expect(r.headerCode).toContain("using TB = Array1D<IEC_INT, 0, 2>;");
    expect(r.headerCode).toContain("using TC = Array2D<IEC_INT, 1, 6, 0, 1>;");
    expect(r.headerCode).toContain("using TD = Array1D<IEC_INT, 2, 5>;");
    expect(r.headerCode).toContain("using TN = Array1D<IEC_INT, 0, 6>;");
    expect(r.headerCode).not.toContain("__INLINE_ARRAY");
  });

  it("refuses a bound that is not a constant", () => {
    expect(
      errorsFor(`PROGRAM Main
VAR n : INT; a : ARRAY[0..n] OF INT; END_VAR
END_PROGRAM`),
    ).toEqual([
      "The bounds of an ARRAY must be integer constants: 'N' is not a constant",
    ]);
    expect(
      errorsFor(`TYPE TA : ARRAY[0..NOPE] OF INT; END_TYPE
PROGRAM Main VAR a : TA; END_VAR END_PROGRAM`),
    ).toEqual([
      "The bounds of an ARRAY must be integer constants: 'NOPE' is not a constant",
    ]);
    expect(
      errorsFor(`TYPE E2 : (A, B); END_TYPE
PROGRAM Main VAR a : ARRAY[E2#A..E2#Z] OF INT; END_VAR END_PROGRAM`),
    ).toEqual([
      "The bounds of an ARRAY must be integer constants: 'E2.Z' is not a constant",
    ]);
  });

  it("refuses a bare member that two enumerations declare", () => {
    expect(
      errorsFor(`TYPE E2 : (A, B); END_TYPE
TYPE E3 : (B, C); END_TYPE
PROGRAM Main VAR a : ARRAY[A..B] OF INT; END_VAR END_PROGRAM`),
    ).toEqual([
      "The bounds of an ARRAY must be integer constants: 'B' is not a constant",
    ]);
  });
});

describe.skipIf(!hasGpp)("constant array bounds end to end", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-arrbounds-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it.each(MODES)("builds and runs (%s)", (name, options) => {
    const r = compile(MAIN, {
      ...SOURCES,
      ...options,
      headerFileName: "generated.hpp",
    });
    expect(r.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: r.headerCode,
      cppCode: r.cppCode,
      testName: `array_bounds_${name.replace(/[ -]/g, "_")}`,
      mainCode: `#include <iostream>
int main() {
  strucpp::Program_MAIN p;
  p.run();
  std::cout << (int)p.N1 << " " << (int)p.N2 << " " << (int)p.N3 << " "
            << (int)p.N4 << " " << (int)p.N5 << " " << (int)p.N6 << " "
            << (int)p.N7 << " " << (int)p.N8 << " " << (int)p.N9 << std::endl;
  return 0;
}
`,
    });
    expect(out).toBe("32 61 25 32 135 57 19 41 9");
  });
});
