// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: `(src * b) / c` with an intermediate past the operand type gives the
 * same value whatever `src` is (a local, an input, a THIS^/SUPER^ member, an
 * inherited member, a global, a GVL-qualified one, an FB member, a method or
 * function result, a property, an array element, a struct field, a pointer
 * dereference, a REFERENCE TO), for INT, SINT, USINT and UINT. Also signed
 * and unsigned AND/OR/XOR in initial values, and arithmetic of a bit string
 * with an untyped constant. Built with g++ and run.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

/** Operand sources read in the derived block's body. */
const BODY_SOURCES = [
  "la",
  "inA",
  "SUPER^.x",
  "THIS^.x",
  "SUPER.x",
  "THIS.x",
  "x",
  "fb.x",
  "fb.MA()",
  "THIS^.MA()",
  "SUPER^.MA()",
  "MA()",
  "FA()",
  "fb.PA",
  "THIS^.PA",
  "PA",
  "gA",
  "GVL.gA",
  "gFb.x",
  "gFb.PA",
  "gFb.MA()",
  "GVL.gFb.x",
  "arr[1]",
  "s.x",
  "p^",
  "rf",
];

/** Operand sources read in a METHOD of the derived block. */
const METHOD_SOURCES = ["THIS^.x", "SUPER^.x", "x", "THIS^.PA", "fb.MA()"];

/** a, b, c per type: a * b leaves the type, (a * b) / c fits it again. */
const VALUES: Record<string, [number, number, number]> = {
  INT: [300, 200, 100],
  SINT: [20, 10, 10],
  USINT: [20, 20, 10],
  UINT: [300, 300, 100],
};

function matrixSource(t: string): string {
  const [a, b, c] = VALUES[t]!;
  const expr = (src: string): string => `(${src} * lb) / lc`;
  return `TYPE StT : STRUCT x : ${t}; END_STRUCT; END_TYPE
FUNCTION FA : ${t}
FA := ${a};
END_FUNCTION
FUNCTION_BLOCK Base
VAR x : ${t} := ${a}; END_VAR
METHOD MA : ${t}
MA := x;
END_METHOD
PROPERTY PA : ${t}
GET
PA := x;
END_GET
END_PROPERTY
END_FUNCTION_BLOCK
FUNCTION_BLOCK Derived EXTENDS Base
VAR_INPUT inA : ${t}; END_VAR
VAR_OUTPUT res : ARRAY[0..${BODY_SOURCES.length - 1}] OF ${t};
  mres : ARRAY[0..${METHOD_SOURCES.length - 1}] OF ${t}; END_VAR
VAR la : ${t} := ${a}; lb : ${t} := ${b}; lc : ${t} := ${c}; fb : Base;
  arr : ARRAY[0..1] OF ${t} := [0, ${a}]; s : StT := (x := ${a}); v : ${t} := ${a};
  p : POINTER TO ${t}; rf : REFERENCE TO ${t}; END_VAR
METHOD Run
${METHOD_SOURCES.map((e, i) => `mres[${i}] := ${expr(e)};`).join("\n")}
END_METHOD
p := ADR(v);
rf REF= v;
${BODY_SOURCES.map((e, i) => `res[${i}] := ${expr(e)};`).join("\n")}
Run();
END_FUNCTION_BLOCK
PROGRAM Main
VAR d : Derived; END_VAR
d(inA := ${a});
END_PROGRAM
`;
}

function gvlSource(t: string): string {
  return `VAR_GLOBAL gA : ${t} := ${VALUES[t]![0]}; gFb : Base; END_VAR\n`;
}

describe.skipIf(!hasGpp)("operand typing — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-optyping-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const t of Object.keys(VALUES)) {
    it(`computes a ${t} intermediate wide for every operand source`, () => {
      const [a, b, c] = VALUES[t]!;
      const result = compile(matrixSource(t), {
        headerFileName: "generated.hpp",
        fileName: "main.st",
        features: ["+named_global_lists", "+property", "+self_caret"],
        additionalSources: [{ source: gvlSource(t), fileName: "GVL.st" }],
      });
      expect(result.errors).toEqual([]);
      const stdout = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: `optyping_${t.toLowerCase()}`,
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    for (int i = 0; i < ${BODY_SOURCES.length}; i++) std::cout << static_cast<long>(p.D.RES[i]) << " ";
    for (int i = 0; i < ${METHOD_SOURCES.length}; i++) std::cout << static_cast<long>(p.D.MRES[i]) << " ";
    std::cout << std::endl;
    return 0;
}
`,
      });
      const wide = String((a * b) / c);
      const got = stdout.split(" ");
      const labels = [...BODY_SOURCES, ...METHOD_SOURCES.map((s) => `M:${s}`)];
      expect(Object.fromEntries(labels.map((l, i) => [l, got[i]]))).toEqual(
        Object.fromEntries(labels.map((l) => [l, wide])),
      );
    });
  }

  it("computes signed/unsigned AND/OR/XOR widened in every initial value", () => {
    const result = compile(
      `TYPE St : STRUCT f : LINT; g : LINT := DINT#-7 OR UDINT#4000000000; END_STRUCT; END_TYPE
VAR_GLOBAL g1 : LINT := DINT#-7 OR UDINT#4000000000; g2 : LINT := DINT#-7 XOR UDINT#4000000000;
  gs : St := (f := DINT#-7 OR UDINT#4000000000); END_VAR
PROGRAM Main
VAR s : St := (f := DINT#-7 XOR UDINT#4000000000); o1, o2, o3, o4, o5, o7 : LINT; END_VAR
o1 := g1; o2 := g2; o3 := gs.f; o4 := gs.g; o5 := s.f; o7 := s.g;
END_PROGRAM
CONFIGURATION C
VAR_GLOBAL cg : LINT := (DINT#-7 OR UDINT#1) AND UDINT#4000000000; END_VAR
RESOURCE R ON PLC
TASK t(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM inst WITH t : Main;
END_RESOURCE
END_CONFIGURATION
`,
      { headerFileName: "generated.hpp" },
    );
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "optyping_initials",
      mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.O1.get() << " " << p.O2.get() << " " << p.O3.get() << " " << p.O4.get() << " "
              << p.O5.get() << " " << strucpp::CG.value.get() << " " << p.O7.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("-7 -4000000007 -7 -7 -4000000007 4000000000 -7");
  });

  it("computes a bit string with an untyped constant in the bit string's type", () => {
    const result = compile(
      `PROGRAM Main
VAR dw : DWORD := 4000000000; w : WORD := 65535; u1, u2 : UDINT; d1 : DINT; l1 : LINT; END_VAR
u1 := MAX(dw / 2 + 3, 5);
u2 := LIMIT(0, dw / 86400 + 3, 4000000000);
d1 := w * 2;
l1 := dw + 1;
END_PROGRAM
`,
      { headerFileName: "generated.hpp" },
    );
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "optyping_bitstring",
      mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.U1.get() << " " << p.U2.get() << " " << p.D1.get() << " " << p.L1.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("2000000003 46299 131070 4000000001");
  });

  it("builds an address offset stored in an address-wide integer under --strict", () => {
    const result = compile(
      `PROGRAM Main
VAR ai : ARRAY[0..3] OF INT := [10, 20, 30, 40]; pi : POINTER TO INT; xw : LWORD; v : INT;
  x : DINT := 16#11223344; q : POINTER TO BYTE; b : BYTE; END_VAR
xw := ADR(x) + 4;
q := ADR(x) + 1;
b := q^;
pi := ADR(ai[0]);
pi := pi + 2;
v := pi^;
END_PROGRAM
`,
      { headerFileName: "generated.hpp", strict: true },
    );
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "optyping_address",
      mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.V.get() << " " << static_cast<int>(p.B.get()) << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("20 51");
  });

  for (const [label, options] of [
    ["no dialect", {}],
    ["strict", { strict: true }],
    ["iec-3 with pointer_to", { dialect: "iec-3", features: ["+pointer_to"] }],
  ] as const) {
    it(`computes arithmetic on a difference of two addresses as a byte count (${label})`, () => {
      const result = compile(
        `PROGRAM Main
VAR arr : ARRAY[0..9] OF INT; p, q : POINTER TO INT; n : INT := 2;
  y : INT; d1, d2, d3, d4, d5, d6, d7, d8 : DINT; l1 : LINT; END_VAR
p := ADR(arr[6]); q := ADR(arr[0]);
y := (p - q) / 2;
d1 := (p - q) / 2;
d2 := (p - q) / n;
d3 := (p - q) + 1;
d4 := (p - q) * 2;
d5 := (p - q) MOD 5;
d6 := (p - q) - 1;
d7 := (ADR(arr[6]) - ADR(arr[0])) / 2;
d8 := (p - q) / INT#2;
l1 := p - q;
END_PROGRAM
`,
        { headerFileName: "generated.hpp", ...options },
      );
      expect(result.errors).toEqual([]);
      const stdout = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: "optyping_difference",
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.Y.get() << " " << p.D1.get() << " " << p.D2.get() << " " << p.D3.get() << " "
              << p.D4.get() << " " << p.D5.get() << " " << p.D6.get() << " " << p.D7.get() << " "
              << p.D8.get() << " " << p.L1.get() << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe("6 6 6 13 24 2 11 6 6 12");
    });
  }

  it("keeps an untyped literal argument of LIMIT or MAX that lies outside the other arguments' type", () => {
    const result = compile(
      `PROGRAM Main
VAR w : WORD := 16#FFFF; i : INT := 32767; r1, r2, r3, r4 : DINT; END_VAR
r1 := LIMIT(0, w + 1, 100000);
r2 := LIMIT(0, i + 1, 100000);
r3 := MAX(w, 70000);
r4 := MIN(i, -40000);
END_PROGRAM
`,
      { headerFileName: "generated.hpp" },
    );
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "optyping_literal_args",
      mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.R1.get() << " " << p.R2.get() << " " << p.R3.get() << " " << p.R4.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("65536 32768 70000 -40000");
  });

  it("keeps the type-cut literal of a function with no mixed-type overload, as before", () => {
    const result = compile(
      `PROGRAM Main
VAR ud : UDINT := 5; w : WORD := 16#00F0; si : SINT := 100; i : INT := 30000;
  r1, r2, r3, r4, r5, r6, r7, r8, r9 : LINT; END_VAR
r1 := ADD(ud, -1);
r2 := XOR(w, -1);
r3 := AND(w, -1);
r4 := MUL(si, 1000);
r5 := SUB(i, 40000);
r6 := ADD(i, 32768, i);
r7 := MAX(w, 70000, 5);
r8 := MIN(i, -40000, 5);
r9 := MAX(70000, w, 5);
END_PROGRAM
`,
      { headerFileName: "generated.hpp" },
    );
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "optyping_plain_functions",
      mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.R1.get() << " " << p.R2.get() << " " << p.R3.get() << " " << p.R4.get() << " "
              << p.R5.get() << " " << p.R6.get() << " " << p.R7.get() << " " << p.R8.get() << " "
              << p.R9.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("4 65295 240 -96 -10000 27232 4464 5 4464");
  });

  it("compares with an untyped literal outside the other argument's type by its value", () => {
    const result = compile(
      `PROGRAM Main
VAR w : WORD := 16#FFFF; i : INT := 30000; u : UDINT := 4294967295;
  b1, b2, b3, b4, b5 : BOOL; END_VAR
b1 := GT(w, 70000);
b2 := LT(i, 40000);
b3 := EQ(u, -1);
b4 := GE(i, -40000, -50000);
b5 := NE(w, 131071);
END_PROGRAM
`,
      { headerFileName: "generated.hpp" },
    );
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "optyping_compare_literals",
      mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.B1.get() << " " << p.B2.get() << " " << p.B3.get() << " " << p.B4.get() << " "
              << p.B5.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("0 1 0 1 1");
  });

  it("passes a computed first argument of a many-argument function at the deduced type", () => {
    const result = compile(
      `FUNCTION_BLOCK Fb
VAR x : DINT := 10; v : DINT := 5; END_VAR
VAR_OUTPUT o1, o2 : DINT; END_VAR
o1 := ADD(THIS^.x + 1, v, 1);
o2 := MAX(THIS^.x + 1, v, 1);
END_FUNCTION_BLOCK
PROGRAM Main
VAR dw : DWORD := 16#F0; lw : LWORD := 16#F0; d : DINT := 7; w : WORD := 16#FFFF; fb : Fb;
  r1 : DWORD; r2 : LWORD; r3 : DINT; r4 : WORD; r5, r6 : DINT;
  si : SINT := 100; i : INT := 32767; r7, r8, r9 : DINT; END_VAR
r1 := AND(dw + 1, dw, 16#FF);
r2 := OR(lw + 1, lw, 1);
r3 := ADD(d + 1, d, 1);
r4 := ADD(w + 1, w, 1);
fb();
r5 := fb.o1;
r6 := fb.o2;
r7 := ADD(si + 1, si * 2);
r8 := MAX(i + 1, i * 2, 1);
r9 := MIN(i + 1, i * 2, 1);
END_PROGRAM
`,
      { headerFileName: "generated.hpp", features: ["+self_caret"] },
    );
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "optyping_computed_args",
      mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.R1.get() << " " << p.R2.get() << " " << p.R3.get() << " " << p.R4.get() << " "
              << p.R5.get() << " " << p.R6.get() << " " << p.R7.get() << " " << p.R8.get() << " "
              << p.R9.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("240 241 16 0 17 11 301 65534 1");
  });
});
