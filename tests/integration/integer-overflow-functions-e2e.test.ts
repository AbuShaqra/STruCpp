// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: ADD, SUB, MUL, NEG and ABS called as functions, integer `**`, and
 * untyped constant expressions past DINT wrap at the declared width with no
 * C++ undefined behaviour (UBSan, recovery off); LTIME / 0 is a fault.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const UBSAN = ["-fsanitize=undefined", "-fno-sanitize-recover=undefined"];

describe.skipIf(!hasGpp)(
  "integer overflow in functions and constants — g++ UBSan e2e",
  () => {
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-ovf-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    /** Compiles `source` with UBSan, runs MAIN once and prints `print` (C++ expressions on `p`). */
    function run(source: string, print: string[], name: string): string {
      const result = compile(source, { headerFileName: "generated.hpp" });
      expect(result.errors.map((e) => e.message)).toEqual([]);
      return compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: name,
        extraFlags: UBSAN,
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    strucpp::strucpp_set_current_task("FAST");
    try { p.run(); } catch (const std::exception& e) { std::cout << e.what() << "|"; }
    std::cout ${print.map((e) => `<< (${e}) << " "`).join(" ")} << std::endl;
    return 0;
}
`,
      });
    }

    it("wraps ADD, SUB, MUL, NEG and ABS called as functions", () => {
      const stdout = run(
        `PROGRAM Main
VAR xd : DINT := 2147483647; nd : DINT := -2147483648; nl : LINT := -9223372036854775807 - 1;
xl : LINT := 9223372036854775807; ni : INT := -32768;
a1, a2, s1, m1, m2, g1, b1 : DINT; a3, s2, m3, b2 : LINT; b3 : INT; END_VAR
a1 := ADD(xd, 1);
a2 := ADD(xd, 1, 1);
a3 := ADD(xl, 1);
s1 := SUB(nd, 1);
s2 := SUB(nl, 1);
m1 := MUL(xd, 2);
m2 := MUL(xd, 2, 3);
m3 := MUL(xl, xl);
g1 := NEG(nd);
b1 := ABS(nd);
b2 := ABS(nl);
b3 := ABS(ni);
END_PROGRAM
`,
        [
          "p.A1.get()",
          "p.A2.get()",
          "p.A3.get()",
          "p.S1.get()",
          "p.S2.get()",
          "p.M1.get()",
          "p.M2.get()",
          "p.M3.get()",
          "p.G1.get()",
          "p.B1.get()",
          "p.B2.get()",
          "p.B3.get()",
        ],
        "ovf_functions",
      );
      expect(stdout).toBe(
        "-2147483648 -2147483647 -9223372036854775808 2147483647 9223372036854775807 -2 -6 1 -2147483648 -2147483648 -9223372036854775808 -32768",
      );
    });

    it("computes integer ** exactly and wraps it; a REAL target keeps the real power", () => {
      const stdout = run(
        `PROGRAM Main
VAR i : DINT := 2; k : DINT := 3; e : DINT := -1; z : DINT := 0;
l1, l2, l3 : LINT; d1, d2, d3, d4 : DINT; r1 : REAL; r2 : LREAL; END_VAR
l1 := LINT#2 ** 63;
l2 := LINT#2 ** 62;
l3 := LINT#3 ** 39;
d1 := i ** 31;
d2 := k ** e;
d3 := e ** e;
d4 := (i ** 3) + 1;
r1 := i ** -1;
r2 := k ** 40;
END_PROGRAM
`,
        [
          "p.L1.get()",
          "p.L2.get()",
          "p.L3.get()",
          "p.D1.get()",
          "p.D2.get()",
          "p.D3.get()",
          "p.D4.get()",
          "p.R1.get()",
          "(p.R2.get() > 1.2157665e19 && p.R2.get() < 1.2157666e19)",
        ],
        "ovf_expt",
      );
      expect(stdout).toBe(
        "-9223372036854775808 4611686018427387904 4052555153018976267 -2147483648 0 -1 9 0.5 1",
      );
    });

    it("computes integer ** in the target's width when the target is wider", () => {
      const stdout = run(
        `PROGRAM Main
VAR d : DINT := 2; u2 : UDINT := 2; u : UDINT := 3000000000; i3 : INT := 3;
l1 : LINT := 2 ** 40; l2, l3, x, li : LINT; ul : ULINT; s : SINT; dd : DINT; END_VAR
l2 := 2 ** 31;
l3 := d ** 40;
ul := u2 ** 40;
x := u ** d;
li := i3 ** 39;
s := 2 ** 7;
dd := d ** 31;
END_PROGRAM
`,
        [
          "p.L1.get()",
          "p.L2.get()",
          "p.L3.get()",
          "p.UL.get()",
          "p.X.get()",
          "p.LI.get()",
          "static_cast<int>(p.S.get())",
          "p.DD.get()",
        ],
        "ovf_expt_wide",
      );
      expect(stdout).toBe(
        "1099511627776 2147483648 1099511627776 1099511627776 9000000000000000000 4052555153018976267 -128 -2147483648",
      );
    });

    it("evaluates an untyped constant past DINT exactly in a call, a comparison, MOD and /", () => {
      const stdout = run(
        `FUNCTION F : LINT
VAR_INPUT x : LINT; END_VAR
F := x;
END_FUNCTION
PROGRAM Main
VAR dz : DINT := 0; a : LINT; b : BOOL; c : DINT; d : DINT; m : LINT; END_VAR
a := F(2147483647 + 1);
b := dz < 2147483647 + 1;
c := (-2147483647 - 2) MOD 10;
d := (2147483647 + 1) / 2;
m := 2147483647 + 1 + dz;
END_PROGRAM
`,
        ["p.A.get()", "p.B.get()", "p.C.get()", "p.D.get()", "p.M.get()"],
        "ovf_exact_uses",
      );
      expect(stdout).toBe("2147483648 1 -9 1073741824 2147483648");
    });

    it("gives an untyped constant expression its exact value, cut where it is stored", () => {
      const stdout = run(
        `TYPE S : STRUCT
  a : DINT := 2147483647 + 1;
  b : LINT := 2147483647 + 1;
  c : UDINT := 4294967295 + 1;
END_STRUCT END_TYPE
PROGRAM Main
VAR l : LINT := 2147483647 + 1; u : UDINT := 4294967295 + 1; d : DINT := 2147483647 + 1;
h : LINT := (2147483647 + 1) / 2 * 3; st1 : S; v : UDINT; END_VAR
v := 4294967295 * 2;
END_PROGRAM
`,
        [
          "p.L.get()",
          "p.U.get()",
          "p.D.get()",
          "p.H.get()",
          "p.ST1.A.get()",
          "p.ST1.B.get()",
          "p.ST1.C.get()",
          "p.V.get()",
        ],
        "ovf_constants",
      );
      expect(stdout).toBe(
        "2147483648 0 -2147483648 3221225472 -2147483648 2147483648 0 4294967294",
      );
    });

    it("faults on LTIME / LTIME#0 and LTIME / 0, naming the POU, line and task", () => {
      const source = (divisor: string): string => `PROGRAM Main
VAR a : LTIME := LTIME#5s; z : LTIME; n : DINT; q : LTIME; ok : LTIME; END_VAR
ok := a / LTIME#2s;
q := a / ${divisor};
END_PROGRAM
`;
      for (const [divisor, name] of [
        ["z", "ovf_ltime_ltime"],
        ["n", "ovf_ltime_int"],
      ] as const) {
        const stdout = run(source(divisor), ["p.OK.get()", "p.Q.get()"], name);
        expect(stdout).toBe("Division by zero in MAIN, line 4, task FAST|2 0");
      }
    });
  },
);
