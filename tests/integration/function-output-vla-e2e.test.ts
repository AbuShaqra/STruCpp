// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: a FUNCTION or METHOD `VAR_OUTPUT` of type ARRAY[*] (Ed. 3 6.5.3)
 * is a view of the array bound to it, passed by value: writes reach the
 * bound array (a local, a list global, a CONFIGURATION global, 2-D, through
 * an interface); an unbound one is an empty array.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `INTERFACE I_A
METHOD Fill : INT
VAR_OUTPUT a : ARRAY[*] OF INT; END_VAR
END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB_A IMPLEMENTS I_A
METHOD Fill : INT
VAR_OUTPUT a : ARRAY[*] OF INT; END_VAR
a[UPPER_BOUND(a, 1)] := 9;
Fill := DINT_TO_INT(UPPER_BOUND(a, 1));
END_METHOD
END_FUNCTION_BLOCK
FUNCTION F : INT
VAR_OUTPUT a : ARRAY[*] OF INT; END_VAR
VAR i : DINT; END_VAR
FOR i := LOWER_BOUND(a, 1) TO UPPER_BOUND(a, 1) DO
  a[i] := DINT_TO_INT(i) * 2;
END_FOR
F := DINT_TO_INT(UPPER_BOUND(a, 1) - LOWER_BOUND(a, 1) + 1);
END_FUNCTION
FUNCTION F2 : INT
VAR_OUTPUT a : ARRAY[*, *] OF INT; END_VAR
a[1, 2] := 4;
F2 := 1;
END_FUNCTION
VAR_GLOBAL g : ARRAY[1..2, 1..2] OF INT; END_VAR
PROGRAM Main
VAR_EXTERNAL g : ARRAY[1..2, 1..2] OF INT; END_VAR
VAR
  fb : FB_A; it : I_A;
  arr : ARRAY[0..4] OF INT; loc : ARRAY[1..3] OF INT;
  o1, o2, o3, o4 : INT;
END_VAR
it := fb;
o1 := it.Fill(a => arr) + fb.Fill(a => arr);
F2(a => g);
o2 := arr[4] + g[1, 2];
o3 := F(a => loc) * 100 + loc[3];
o4 := F();
END_PROGRAM
`;

const CONFIG = `FUNCTION F : INT
VAR_OUTPUT a : ARRAY[*] OF INT; END_VAR
a[2] := 6;
F := 1;
END_FUNCTION
PROGRAM Main
VAR_EXTERNAL g : ARRAY[1..2] OF INT; END_VAR
VAR o1 : INT; END_VAR
F(a => g);
o1 := g[2];
END_PROGRAM
CONFIGURATION Cfg
VAR_GLOBAL g : ARRAY[1..2] OF INT; END_VAR
RESOURCE R ON PLC
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM inst WITH T : Main;
END_RESOURCE
END_CONFIGURATION
`;

/** Whole-array stores and bindings a view takes, each with the value it gives. */
const CASES: Array<{
  title: string;
  source: string;
  /** The C++ main body; the program Main's O1 by default. */
  main: string | undefined;
  expected: string;
}> = [
  {
    title: "a whole-array store into an ARRAY[*] in-out and output",
    source: `FUNCTION WIO : INT
VAR_IN_OUT a : ARRAY[*] OF INT; END_VAR
VAR t : ARRAY[1..3] OF INT := [4, 5, 6]; END_VAR
a := t;
WIO := 0;
END_FUNCTION
FUNCTION WOUT : INT
VAR_OUTPUT a : ARRAY[*] OF INT; END_VAR
VAR t : ARRAY[1..3] OF INT := [4, 5, 6]; END_VAR
a := t;
WOUT := 0;
END_FUNCTION
FUNCTION WOUT2 : INT
VAR_OUTPUT a : ARRAY[*] OF INT; END_VAR
VAR_INPUT b : ARRAY[*] OF INT; END_VAR
a := b;
WOUT2 := 0;
END_FUNCTION
PROGRAM Main
VAR w, q, z : ARRAY[1..3] OF INT; src : ARRAY[1..3] OF INT := [7, 8, 9]; o1, o2, o3 : INT; END_VAR
WIO(a := w); o1 := w[1] * 100 + w[3];
WOUT(a => q); o2 := q[1] * 100 + q[3];
WOUT2(b := src, a => z); o3 := z[1] * 100 + z[3];
END_PROGRAM
`,
    main: `strucpp::Program_MAIN p; p.run(); std::cout << (int)p.O1 << " " << (int)p.O2 << " " << (int)p.O3 << std::endl;`,
    expected: "406 406 709",
  },
  {
    title: "a whole-array store into a FUNCTION ARRAY[*] in-out",
    source: `FUNCTION WIO : INT
VAR_IN_OUT a : ARRAY[*] OF INT; END_VAR
VAR t : ARRAY[1..3] OF INT := [4, 5, 6]; END_VAR
a := t;
WIO := 0;
END_FUNCTION
PROGRAM Main
VAR w, q, z : ARRAY[1..3] OF INT; src : ARRAY[1..3] OF INT := [7, 8, 9]; o1, o2, o3 : INT; END_VAR
WIO(a := w); o1 := w[1] * 100 + w[3];
END_PROGRAM
`,
    main: `strucpp::Program_MAIN p; p.run(); std::cout << (int)p.O1 << " " << (int)p.O2 << " " << (int)p.O3 << std::endl;`,
    expected: "406 0 0",
  },
  {
    title:
      "an output bound to a STRUCT field, an FB member and a REFERENCE TO ARRAY",
    source: `TYPE SA : STRUCT arr : ARRAY[1..3] OF INT; END_STRUCT END_TYPE
FUNCTION F : INT
VAR_OUTPUT a : ARRAY[*] OF INT; END_VAR
a[UPPER_BOUND(a, 1)] := 9;
F := 0;
END_FUNCTION
FUNCTION_BLOCK FB_C
VAR arr : ARRAY[1..3] OF INT; END_VAR
METHOD Go : INT
F(a => arr);
Go := arr[3];
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main
VAR s : SA; fc : FB_C; r : REFERENCE TO ARRAY[1..3] OF INT; b : ARRAY[1..3] OF INT; o1, o2, o3 : INT; END_VAR
F(a => s.arr); o1 := s.arr[3];
o2 := fc.Go();
r REF= b; F(a => r); o3 := b[3];
END_PROGRAM
`,
    main: `strucpp::Program_MAIN p; p.run(); std::cout << (int)p.O1 << " " << (int)p.O2 << " " << (int)p.O3 << std::endl;`,
    expected: "9 9 9",
  },
  {
    title: "an output bound to a dereference and to in-outs",
    source: `FUNCTION F : INT
VAR_OUTPUT a : ARRAY[*] OF INT; END_VAR
a[UPPER_BOUND(a, 1)] := 9;
F := 0;
END_FUNCTION
FUNCTION G : INT
VAR_IN_OUT io : ARRAY[*] OF INT; fixed : ARRAY[1..3] OF INT; END_VAR
F(a => io); F(a => fixed);
G := 0;
END_FUNCTION
PROGRAM Main
VAR p : POINTER TO ARRAY[1..3] OF INT; b, c, d : ARRAY[1..3] OF INT; o1, o2, o3 : INT; END_VAR
p := ADR(b); F(a => p^); o1 := b[3];
G(io := c, fixed := d); o2 := c[3]; o3 := d[3];
END_PROGRAM
`,
    main: `strucpp::Program_MAIN p; p.run(); std::cout << (int)p.O1 << " " << (int)p.O2 << " " << (int)p.O3 << std::endl;`,
    expected: "9 9 9",
  },
  {
    title: "a 3-D ARRAY[*] in-out",
    source: `FUNCTION F3 : INT
VAR_IN_OUT a : ARRAY[*, *, *] OF INT; END_VAR
a[1, 2, 3] := 7;
F3 := 0;
END_FUNCTION
PROGRAM Main
VAR c : ARRAY[1..2, 1..2, 1..3] OF INT; o1 : INT; END_VAR
F3(a := c); o1 := c[1, 2, 3];
END_PROGRAM
`,
    main: undefined,
    expected: "7",
  },
  {
    title:
      "ARRAY OF STRING(20), STRUCT elements, recursion and a nested in-out",
    source: `TYPE ST : STRUCT a : INT; b : STRING; END_STRUCT END_TYPE
FUNCTION FS : INT
VAR_OUTPUT a : ARRAY[*] OF STRING; END_VAR
a[LOWER_BOUND(a, 1)] := 'hello';
FS := LEN(a[LOWER_BOUND(a, 1)]);
END_FUNCTION
FUNCTION FT : INT
VAR_OUTPUT a : ARRAY[*] OF ST; END_VAR
a[2].a := 5; a[2].b := 'xy';
FT := 0;
END_FUNCTION
FUNCTION REC : INT
VAR_INPUT n : INT; END_VAR
VAR_OUTPUT a : ARRAY[*] OF INT; END_VAR
IF n > 0 THEN
  a[n] := n * 10;
  REC := REC(n := n - 1, a => a);
ELSE
  REC := 0;
END_IF
END_FUNCTION
FUNCTION INNER : INT
VAR_IN_OUT b : ARRAY[*] OF INT; END_VAR
b[1] := 33;
INNER := 0;
END_FUNCTION
FUNCTION OUTER : INT
VAR_OUTPUT a : ARRAY[*] OF INT; END_VAR
INNER(b := a);
OUTER := 0;
END_FUNCTION
PROGRAM Main
VAR
  s : ARRAY[0..1] OF STRING(20);
  t : ARRAY[1..2] OF ST;
  r : ARRAY[1..3] OF INT;
  q : ARRAY[1..3] OF INT;
  n : INT;
  o1, o2, o3 : INT;
END_VAR
n := FS(a => s);
o1 := n * 10 + LEN(s[0]);
FT(a => t); o2 := t[2].a * 10 + LEN(t[2].b);
REC(n := 3, a => r); OUTER(a => q); o3 := r[1] + r[2] + r[3] + q[1];
END_PROGRAM
`,
    main: `strucpp::Program_MAIN p; p.run(); std::cout << (int)p.O1 << " " << (int)p.O2 << " " << (int)p.O3 << std::endl;`,
    expected: "55 52 93",
  },
  {
    title: "an output bound in a global's initial value",
    source: `FUNCTION F : INT
VAR_OUTPUT a : ARRAY[*] OF INT; END_VAR
a[UPPER_BOUND(a, 1)] := 9;
F := DINT_TO_INT(UPPER_BOUND(a, 1));
END_FUNCTION
VAR_GLOBAL
  x : INT := F(a => garr);
  garr : ARRAY[1..3] OF INT := [1, 2, 3];
END_VAR
PROGRAM Main
VAR_EXTERNAL x : INT; garr : ARRAY[1..3] OF INT; END_VAR
VAR o1, o2 : INT; END_VAR
o1 := x; o2 := garr[3];
END_PROGRAM
`,
    main: `strucpp::Program_MAIN p; p.run(); std::cout << (int)p.O1 << " " << (int)p.O2 << std::endl;`,
    expected: "3 9",
  },
  {
    title: "a whole-array store into a FUNCTION_BLOCK ARRAY[*] in-out",
    source: `FUNCTION LIT : INT
VAR_IN_OUT a : ARRAY[*] OF INT; END_VAR
a[LOWER_BOUND(a, 1)] := 1;
LIT := a[LOWER_BOUND(a, 1)];
END_FUNCTION
FUNCTION_BLOCK FB_V
VAR_IN_OUT a : ARRAY[*] OF INT; END_VAR
VAR t : ARRAY[1..3] OF INT := [5, 6, 7]; END_VAR
a := t;
END_FUNCTION_BLOCK
PROGRAM Main
VAR
  x : ARRAY[1..3] OF INT;
  y : ARRAY[1..3] OF INT;
  fv : FB_V;
  o1, o2, o3 : INT;
END_VAR
o1 := LIT(a := x) * 10 + x[3];
fv(a := y); o2 := y[1] * 10 + y[3];
o3 := 0;
END_PROGRAM
`,
    main: `strucpp::Program_MAIN p; p.run(); std::cout << (int)p.O1 << " " << (int)p.O2 << " " << (int)p.O3 << std::endl;`,
    expected: "10 57 0",
  },
  {
    title: "a whole-array store from one view into another",
    source: `FUNCTION F : INT
VAR_IN_OUT a : ARRAY[*] OF INT; b : ARRAY[*] OF INT; END_VAR
a := b;
F := 0;
END_FUNCTION
PROGRAM Main
VAR d : ARRAY[1..3] OF INT; e : ARRAY[5..7] OF INT := [7,8,9]; O1 : INT; END_VAR
F(d, e);
O1 := d[1]*100+d[2]*10+d[3];
END_PROGRAM
`,
    main: undefined,
    expected: "789",
  },
  {
    title: "a whole-array store from a STRUCT field",
    source: `TYPE H : STRUCT arr : ARRAY[0..2] OF INT := [1,2,3]; END_STRUCT END_TYPE
FUNCTION GetH : H
END_FUNCTION
FUNCTION F : INT
VAR_IN_OUT a : ARRAY[*] OF INT; END_VAR
VAR h : H; END_VAR
a := h.arr;
F := 0;
END_FUNCTION
PROGRAM Main
VAR d : ARRAY[1..3] OF INT; O1 : INT; END_VAR
F(d);
O1 := d[1]*100+d[2]*10+d[3];
END_PROGRAM
`,
    main: undefined,
    expected: "123",
  },
  {
    title: "a whole-array store into a FUNCTION_BLOCK in-out from a member",
    source: `FUNCTION_BLOCK FBW
VAR_IN_OUT a : ARRAY[*] OF INT; END_VAR
VAR src : ARRAY[0..2] OF INT := [4,5,6]; lit : INT; END_VAR
a := src;
END_FUNCTION_BLOCK
PROGRAM Main
VAR d : ARRAY[1..3] OF INT; w : FBW; O1 : INT; END_VAR
w(a := d);
O1 := d[1]*100+d[2]*10+d[3];
END_PROGRAM
`,
    main: undefined,
    expected: "456",
  },
];

/** A whole-array store of another length into an ARRAY[*] parameter. */
const LENGTH_FAULT = `FUNCTION W : INT
VAR_IN_OUT a : ARRAY[*] OF INT; END_VAR
VAR t : ARRAY[1..2] OF INT := [4, 5]; END_VAR
a := t;
W := 0;
END_FUNCTION
PROGRAM Main
VAR w : ARRAY[1..3] OF INT; o1 : INT; END_VAR
W(a := w); o1 := w[1];
END_PROGRAM
`;

describe("FUNCTION / METHOD VAR_OUTPUT ARRAY[*] parameters", () => {
  it("refuse more than 3 dimensions", () => {
    const r = compile(`FUNCTION F4 : INT
VAR_IN_OUT a : ARRAY[*, *, *, *] OF INT; END_VAR
F4 := 0;
END_FUNCTION
PROGRAM Main END_PROGRAM
`);
    expect(r.errors.map((e) => `${e.line}:${e.column} ${e.message}`)).toEqual([
      "2:16 'a' is an ARRAY[*] of 4 dimensions: an ARRAY[*] parameter has at most 3",
    ]);
  });

  it("are views passed by value", () => {
    const r = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(r.errors).toEqual([]);
    expect(r.headerCode).toContain("IEC_INT F(ArrayView1D<IEC_INT> A);");
    expect(r.headerCode).toContain("IEC_INT F2(ArrayView2D<IEC_INT> A);");
    expect(r.headerCode).toMatch(/FILL\(ArrayView1D<IEC_INT> A\)/);
    expect(r.headerCode).not.toMatch(/ArrayView\dD<IEC_INT>& A/);
  });
});

describe.skipIf(!hasGpp)(
  "FUNCTION / METHOD VAR_OUTPUT ARRAY[*] — g++ e2e",
  () => {
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-outvla-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    it("writes reach the bound array", () => {
      const r = compile(SOURCE, { headerFileName: "generated.hpp" });
      expect(r.errors).toEqual([]);
      const out = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: r.headerCode,
        cppCode: r.cppCode,
        testName: "function_output_vla",
        mainCode: `#include <iostream>
int main() {
  strucpp::Program_MAIN p;
  p.run();
  std::cout << p.O1 << " " << p.O2 << " " << p.O3 << " " << p.O4 << std::endl;
  return 0;
}
`,
      });
      expect(out.trim()).toBe("8 13 306 0");
    });

    it.each(CASES)("$title", ({ title, source, main, expected }) => {
      const r = compile(source, { headerFileName: "generated.hpp" });
      expect(r.errors).toEqual([]);
      const out = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: r.headerCode,
        cppCode: r.cppCode,
        testName: `function_output_vla_${CASES.findIndex((c) => c.title === title)}`,
        mainCode: `#include <iostream>
int main() {
  ${main ?? "strucpp::Program_MAIN p; p.run(); std::cout << (int)p.O1 << std::endl;"}
  return 0;
}
`,
      });
      expect(out.trim()).toBe(expected);
    });

    it("a whole-array store of another length is a bounds fault", () => {
      const r = compile(LENGTH_FAULT, { headerFileName: "generated.hpp" });
      expect(r.errors).toEqual([]);
      expect(() =>
        compileAndRunStandalone({
          tempDir,
          pchPath,
          headerCode: r.headerCode,
          cppCode: r.cppCode,
          testName: "function_output_vla_length",
          mainCode: `#include <iostream>
int main() {
  strucpp::Program_MAIN p; p.run(); std::cout << (int)p.O1 << std::endl;
  return 0;
}
`,
        }),
      ).toThrow(/Array lengths differ in a whole-array assignment/);
    });

    it("an unbound output written faults naming VAR_OUTPUT", () => {
      const r = compile(
        `FUNCTION F : INT
VAR_OUTPUT a : ARRAY[*] OF INT; END_VAR
a[1] := 5;
F := 0;
END_FUNCTION
PROGRAM Main
VAR o1 : INT; END_VAR
o1 := F();
END_PROGRAM
`,
        { headerFileName: "generated.hpp" },
      );
      expect(r.errors).toEqual([]);
      expect(() =>
        compileAndRunStandalone({
          tempDir,
          pchPath,
          headerCode: r.headerCode,
          cppCode: r.cppCode,
          testName: "function_output_vla_unbound",
          mainCode: `#include <iostream>
int main() {
  strucpp::Program_MAIN p; p.run(); std::cout << (int)p.O1 << std::endl;
  return 0;
}
`,
        }),
      ).toThrow(/Null reference dereference in VAR_OUTPUT/);
    });

    it("writes reach a CONFIGURATION global", () => {
      const r = compile(CONFIG, { headerFileName: "generated.hpp" });
      expect(r.errors).toEqual([]);
      const out = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: r.headerCode,
        cppCode: r.cppCode,
        testName: "function_output_vla_cfg",
        mainCode: `#include <iostream>
int main() {
  static strucpp::Configuration_CFG cfg;
  cfg.INST.run();
  std::cout << cfg.INST.O1.get() << std::endl;
  return 0;
}
`,
      });
      expect(out.trim()).toBe("6");
    });
  },
);
