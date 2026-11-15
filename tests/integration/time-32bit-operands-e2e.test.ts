// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: the 32-bit TIME, DATE, TOD and DT with every operand shape the checker
 * accepts: a literal, a SEL result or a dereference times or divided by a
 * variable, a typed number or an expression (either order); an LTIME bound to
 * a TIME FUNCTION or METHOD input (named or positional) or STRUCT initialiser
 * field; MOD by an integer or a duration (0 gives 0), also through a
 * REFERENCE TO; TIME / TIME; a REAL divisor computed in double; a ULINT
 * divisor at or above 2^63. g++ and run.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `FUNCTION FT : TIME
VAR_INPUT a : TIME; END_VAR
FT := a;
END_FUNCTION
FUNCTION_BLOCK FB
METHOD M : TIME
VAR_INPUT b : TIME; END_VAR
M := b;
END_METHOD
END_FUNCTION_BLOCK
TYPE S : STRUCT a : TIME; END_STRUCT; END_TYPE
PROGRAM MAIN
VAR
  t1 : TIME := T#1s; t2 : TIME := T#1000ms; di : DINT := 3; d0 : DINT := 0; rl : REAL := 0.5;
  pt : POINTER TO TIME; lt : LTIME := LTIME#1500us; fb : FB; s : S := (a := LTIME#3ms);
  tod1 : TOD := TOD#00:00:01.000; rt : REFERENCE TO TIME; ul : ULINT := ULINT#9223372036854775808;
  r : ARRAY[1..40] OF UDINT; q : LINT;
END_VAR
pt := ADR(t1);
rt REF= t2;
r[1] := TIME_TO_UDINT(T#1s * di);
r[2] := TIME_TO_UDINT(T#1s / di);
r[3] := TIME_TO_UDINT(T#1s * rl);
r[4] := TIME_TO_UDINT(T#3s / REAL#3.0);
r[5] := TIME_TO_UDINT(T#1s * INT#3);
r[6] := TIME_TO_UDINT(T#1s * (di + 1));
r[7] := TIME_TO_UDINT(DIV_TIME(T#1s, di));
r[8] := TIME_TO_UDINT(SEL(TRUE, t1, T#5s) / di);
r[9] := TIME_TO_UDINT(pt^ * rl);
r[10] := TIME_TO_UDINT(pt^ / di);
r[11] := TIME_TO_UDINT(di * T#1s);
r[12] := TIME_TO_UDINT(FT(a := lt));
r[13] := TIME_TO_UDINT(FT(lt));
r[14] := TIME_TO_UDINT(fb.M(b := lt));
r[15] := TIME_TO_UDINT(s.a);
r[16] := TIME_TO_UDINT(t2 MOD 300);
r[17] := TIME_TO_UDINT(t2 MOD di);
r[18] := TIME_TO_UDINT(t2 MOD T#300ms);
r[19] := TOD_TO_UDINT(tod1 MOD 300);
r[20] := TIME_TO_UDINT(rt MOD 300);
r[21] := TIME_TO_UDINT(t2 MOD d0);
r[22] := TIME_TO_UDINT(T#10s / T#3s);
r[23] := TIME_TO_UDINT(T#49ms / 49.0);
r[24] := TIME_TO_UDINT(DIV_TIME(T#49ms, 49.0));
r[25] := TIME_TO_UDINT(T#10s / ul);
r[26] := TIME_TO_UDINT(T#10s / ULINT#18446744073709551615);
END_PROGRAM
`;

describe.skipIf(!hasGpp)("32-bit date and time operands — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-time32-ops-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("computes every operand shape", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "time32_operands",
      extraFlags: ["-fsanitize=undefined", "-fno-sanitize-recover=undefined"],
      mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    for (int i = 1; i <= 26; ++i) std::cout << p.R[i].get() << " ";
    std::cout << std::endl;
    return 0;
}
`,
    });
    expect(stdout.split(" ")).toEqual([
      // * and / with a non-variable TIME (1-11)
      "3000",
      "333",
      "500",
      "1000",
      "3000",
      "4000",
      "333",
      "1666",
      "500",
      "333",
      "3000",
      // an LTIME into a TIME input or STRUCT field (12-15)
      "1",
      "1",
      "1",
      "3",
      // MOD (16-21), TIME / TIME (22)
      "100",
      "1",
      "100",
      "100",
      "100",
      "0",
      "3",
      // a REAL divisor in double (23-24), a ULINT divisor >= 2^63 (25-26)
      "1",
      "1",
      "0",
      "0",
    ]);
  });
});
