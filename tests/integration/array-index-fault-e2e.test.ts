// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: an array index out of bounds is a run-time fault naming the index, the
 * POU, the line and the running task; an unbound REFERENCE TO names the task.
 * STRUCPP_NO_BOUNDS_CHECK builds without the checks.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const ARRAY_SOURCE = `PROGRAM Main
VAR arr : ARRAY[0..2] OF INT; m : ARRAY[0..1, 0..1] OF INT; i : INT := 5; v : INT; END_VAR
arr[1] := 4; v := arr[1];
m[1, 1] := 3;
arr[i] := 1;
END_PROGRAM
`;

const REF_SOURCE = `FUNCTION_BLOCK FB
VAR_INPUT r : REFERENCE TO INT; END_VAR
VAR_OUTPUT o : INT; END_VAR
o := r;
END_FUNCTION_BLOCK
PROGRAM Main
VAR f : FB; END_VAR
f();
END_PROGRAM
`;

const MAIN = `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    strucpp::strucpp_set_current_task("FAST");
    try { p.run(); } catch (const std::exception& e) { std::cout << e.what(); }
    std::cout << std::endl;
    return 0;
}
`;

describe.skipIf(!hasGpp)("array index and reference faults — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-index-fault-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const [label, options] of [
    ["no dialect", {}],
    ["iec-3", { dialect: "iec-3" }],
    ["strict", { strict: true }],
  ] as const) {
    it(`names the index, POU, line and task (${label})`, () => {
      const result = compile(ARRAY_SOURCE, {
        ...options,
        headerFileName: "generated.hpp",
      });
      expect(result.errors).toEqual([]);
      const stdout = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: `index_fault_${label.replace(/\W/g, "_")}`,
        mainCode: MAIN,
      });
      expect(stdout).toBe(
        "Array index out of bounds: 5 in MAIN, line 5, task FAST",
      );
    });
  }

  it("names the reference, POU, line and task for an unbound REFERENCE TO", () => {
    const result = compile(REF_SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "ref_fault",
      mainCode: MAIN,
    });
    expect(stdout).toBe("Unbound REFERENCE TO R in FB, line 4, task FAST");
  });

  it("builds without the checks under STRUCPP_NO_BOUNDS_CHECK", () => {
    const result = compile(ARRAY_SOURCE.replace("arr[i] := 1;\n", ""), {
      headerFileName: "generated.hpp",
    });
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "no_bounds_check",
      extraFlags: ["-DSTRUCPP_NO_BOUNDS_CHECK"],
      mainCode: MAIN,
    });
    expect(stdout).toBe("");
  });

  const DEREF_SOURCE = `TYPE SS : STRUCT f : INT; END_STRUCT END_TYPE
FUNCTION F : INT
VAR_INPUT r : REFERENCE TO INT; END_VAR
F := r + 1;
END_FUNCTION
FUNCTION_BLOCK FB
VAR_INPUT r : REFERENCE TO INT; END_VAR
VAR_OUTPUT o : INT; END_VAR
o := r;
r := 5;
END_FUNCTION_BLOCK
PROGRAM Main
VAR p : POINTER TO INT; ps : POINTER TO SS; q : REF_TO INT; rr : REFERENCE TO INT; x : INT; fb1 : FB; k : INT; END_VAR
CASE k OF
1: x := p^;
2: p^ := 3;
3: x := ps^.f;
4: x := q^;
5: x := rr;
6: x := F(r := rr);
7: fb1();
8: rr := 4;
END_CASE;
END_PROGRAM
`;

  const ARRAYS_SOURCE = `TYPE U : UNION a : ARRAY[0..1, 0..1] OF INT; b : ARRAY[0..3] OF INT; END_UNION END_TYPE
FUNCTION SumV : DINT
VAR_IN_OUT v : ARRAY[*] OF DINT; END_VAR
VAR_INPUT k : DINT; END_VAR
SumV := v[k];
END_FUNCTION
PROGRAM Main
VAR q : ARRAY[0..2] OF INT; n : ARRAY[-5..-1] OF INT; u : ULINT := 18446744073709551615; v : ARRAY[0..4] OF DINT; uu : U; i : INT := 2; x : DINT; k : INT; END_VAR
CASE k OF
1: x := q[u];
2: n[u] := 7;
3: x := SumV(v, 7);
4: x := uu.a[i, 0];
5: x := q[i + 5];
END_CASE;
END_PROGRAM
`;

  const runCases = (
    source: string,
    name: string,
    count: number,
    extraFlags: string[] = [],
  ): string[] => {
    const result = compile(source, {
      headerFileName: "generated.hpp",
      features: ["+union"],
    });
    expect(result.errors).toEqual([]);
    return compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: name,
      extraFlags,
      mainCode: `
#include <iostream>
int main() {
    strucpp::strucpp_set_current_task("FAST");
    for (int k = 1; k <= ${count}; ++k) {
        try { strucpp::Program_MAIN p; p.K = k; p.run(); std::cout << k << " ok|"; }
        catch (const std::exception& e) { std::cout << k << " " << e.what() << "|"; }
    }
    std::cout << std::endl;
    return 0;
}
`,
    })
      .split("|")
      .filter((l) => l !== "");
  };

  it("names the POU, line and task for a NULL POINTER TO or REF_TO and an unbound REFERENCE TO", () => {
    expect(runCases(DEREF_SOURCE, "deref_faults", 8)).toEqual([
      "1 Null pointer dereference in MAIN, line 15, task FAST",
      "2 Null pointer dereference in MAIN, line 16, task FAST",
      "3 Null pointer dereference in MAIN, line 17, task FAST",
      "4 Null reference dereference in MAIN, line 18, task FAST",
      "5 Unbound REFERENCE TO RR in MAIN, line 19, task FAST",
      "6 Unbound REFERENCE TO R in F, line 4, task FAST",
      "7 Unbound REFERENCE TO R in FB, line 9, task FAST",
      "8 Unbound REFERENCE TO RR in MAIN, line 22, task FAST",
    ]);
  });

  it("names a ULINT index as written, and faults on it whatever the bounds", () => {
    expect(runCases(ARRAYS_SOURCE, "index_faults", 5)).toEqual([
      "1 Array index out of bounds: 18446744073709551615 in MAIN, line 10, task FAST",
      "2 Array index out of bounds: 18446744073709551615 in MAIN, line 11, task FAST",
      "3 Array index out of bounds: 7 in SUMV, line 5, task FAST",
      "4 Array index out of bounds: [2, 0] in MAIN, line 13, task FAST",
      "5 Array index out of bounds: 7 in MAIN, line 14, task FAST",
    ]);
  });

  it("leaves out the ARRAY[*] and UNION array checks under STRUCPP_NO_BOUNDS_CHECK", () => {
    const out = runCases(ARRAYS_SOURCE, "index_no_check", 5, [
      "-DSTRUCPP_NO_BOUNDS_CHECK",
    ]);
    expect(out[2]).toBe("3 ok");
    expect(out[3]).toBe("4 ok");
  });

  it("names the site without exceptions", () => {
    const result = compile(ARRAYS_SOURCE, {
      headerFileName: "generated.hpp",
      features: ["+union"],
    });
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "index_no_exceptions",
      extraFlags: ["-fno-exceptions"],
      mainCode: `
#include <cstdio>
#include <cstdlib>
namespace strucpp {
[[noreturn]] void iec_runtime_fault(IecFault reason, const char* context) noexcept {
    std::printf("fault %d %s\\n", static_cast<int>(reason), context != nullptr ? context : "");
    std::exit(0);
}
}
int main() {
    strucpp::strucpp_set_current_task("FAST");
    static strucpp::Program_MAIN p;
    p.K = 3;
    p.run();
    std::printf("nofault\\n");
    return 0;
}
`,
    });
    expect(stdout).toBe(
      "fault 1 Array index out of bounds in SUMV, line 5, task FAST",
    );
  });
});
