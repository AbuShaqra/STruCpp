// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: a store outside a subrange is a run-time fault naming the variable,
 * the value, the range, the POU and the line; stores inside it go through.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `TYPE SR : INT (0..10); END_TYPE
TYPE SA : SR; END_TYPE
TYPE ST : STRUCT f : SR; END_STRUCT END_TYPE
PROGRAM Main
VAR s : SR := 5; v : INT := 42; x : INT (1..3) := 2; a : SA; t : ST; ok : SR; END_VAR
ok := 7;
a := 9;
t.f := 10;
x := 3;
s := v;
END_PROGRAM
`;

describe.skipIf(!hasGpp)("subrange store — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-subrange-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const [label, options] of [
    ["no dialect", {}],
    ["iec-3", { dialect: "iec-3" }],
    ["strict", { strict: true }],
  ] as const) {
    it(`faults outside the range (${label})`, () => {
      const result = compile(SOURCE, {
        ...options,
        headerFileName: "generated.hpp",
      });
      expect(result.errors).toEqual([]);
      const stdout = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: `subrange_${label.replace(/\W/g, "_")}`,
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    try { p.run(); } catch (const std::exception& e) { std::cout << e.what() << "|"; }
    std::cout << p.OK << " " << p.A << " " << p.X << " " << p.T.F << " " << p.S << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe(
        "Value 42 outside 0..10 stored in S in MAIN, line 10|7 9 3 10 5",
      );
    });
  }

  const PATHS = `TYPE SR : INT (0..10); END_TYPE
TYPE SUW : ULINT (0..18446744073709551614); END_TYPE
FUNCTION_BLOCK FB
VAR_INPUT i : SR; END_VAR
VAR_OUTPUT o : INT; END_VAR
o := 42;
END_FUNCTION_BLOCK
FUNCTION FR : SR
VAR_INPUT a : INT; END_VAR
FR := a;
END_FUNCTION
FUNCTION FI : INT
VAR_INPUT a : SR; END_VAR
FI := a;
END_FUNCTION
VAR_GLOBAL g : SR; END_VAR
PROGRAM Main
VAR f : FB; x : SR; v : INT := 42; r : INT; k : INT; SR_MIN : INT := 0; SR_MAX : INT := 100; w : SUW; big : ULINT := 9223372036854775808; huge : ULINT := 18446744073709551615; END_VAR
CASE k OF
1: f(i := v);
2: f(o => x);
3: r := FR(v);
4: r := FI(v);
5: g := v;
6: x := v;
7: w := big;
8: w := huge;
END_CASE;
END_PROGRAM
`;

  const runPaths = (name: string, extraFlags: string[]): string[] => {
    const result = compile(PATHS, { headerFileName: "generated.hpp" });
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
    strucpp::strucpp_set_current_task("T");
    for (int k = 1; k <= 8; ++k) {
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

  it("checks FB inputs and outputs, FUNCTION inputs and results, globals; qualifies the bounds; compares ULINT exactly", () => {
    expect(runPaths("subrange_paths", [])).toEqual([
      "1 Value 42 outside 0..10 stored in I in FB, line 4, task T",
      "2 Value 42 outside 0..10 stored in X in MAIN, line 21, task T",
      "3 Value 42 outside 0..10 stored in FR in FR, line 10, task T",
      "4 Value 42 outside 0..10 stored in A in FI, line 13, task T",
      "5 Value 42 outside 0..10 stored in G in MAIN, line 24, task T",
      "6 Value 42 outside 0..10 stored in X in MAIN, line 25, task T",
      "7 ok",
      "8 Value 18446744073709551615 outside 0..18446744073709551614 stored in W in MAIN, line 27, task T",
    ]);
  });

  it("leaves the check out under STRUCPP_NO_BOUNDS_CHECK", () => {
    expect(
      runPaths("subrange_paths_off", ["-DSTRUCPP_NO_BOUNDS_CHECK"]),
    ).toEqual(["1 ok", "2 ok", "3 ok", "4 ok", "5 ok", "6 ok", "7 ok", "8 ok"]);
  });

  it("checks a CONFIGURATION global stored through VAR_EXTERNAL", () => {
    const result = compile(
      `TYPE SR : INT (0..10); END_TYPE
PROGRAM Main
VAR_EXTERNAL cg : SR; END_VAR
VAR v : INT := 42; END_VAR
cg := v;
END_PROGRAM
CONFIGURATION C
VAR_GLOBAL cg : SR; END_VAR
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
      testName: "subrange_config_global",
      mainCode: `
#include <iostream>
int main() {
    strucpp::strucpp_set_current_task("T");
    try { strucpp::Program_MAIN p(&strucpp::CG); p.run(); std::cout << "ok" << std::endl; }
    catch (const std::exception& e) { std::cout << e.what() << std::endl; }
    return 0;
}
`,
    });
    expect(stdout).toBe(
      "Value 42 outside 0..10 stored in CG in MAIN, line 5, task T",
    );
  });

  it("refuses a constant initial value outside the subrange", () => {
    const result = compile(`TYPE SR : INT (0..10); END_TYPE
TYPE SD : INT (0..10) := 42; END_TYPE
TYPE ST : STRUCT f : SR := 42; END_STRUCT END_TYPE
PROGRAM Main
VAR x : INT (0..10) := 42; y : SD; t : ST; a : ARRAY[1..2] OF SR := [42, 1]; ok : SR := 5; n : SR := -1; END_VAR
x := x;
END_PROGRAM
`);
    expect(
      result.errors.map((e) => `${e.line}:${e.column} ${e.message}`).sort(),
    ).toEqual([
      "2:26 The initial value 42 of 'SD' is outside its subrange 0..10",
      "3:28 The initial value 42 of 'F' is outside its subrange 0..10",
      "5:102 The initial value -1 of 'N' is outside its subrange 0..10",
      "5:24 The initial value 42 of 'X' is outside its subrange 0..10",
      "5:70 The initial value 42 of 'A' is outside its subrange 0..10",
    ]);
  });

  it("checks a typed based literal by its signed value, and a field of a FUNCTION result", () => {
    const result = compile(
      `TYPE SR : INT (0..10); END_TYPE
TYPE SH : INT (100..300); END_TYPE
TYPE ST : STRUCT f : SR; END_STRUCT END_TYPE
FUNCTION FS : ST
VAR_INPUT a : INT; END_VAR
FS.f := a;
END_FUNCTION
PROGRAM Main
VAR x : SH := 200; t : ST; v : INT := 42; k : INT; END_VAR
CASE k OF
1: x := SINT#16#FF;
2: t := FS(v);
END_CASE;
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
      testName: "subrange_typed_and_result_field",
      mainCode: `
#include <iostream>
int main() {
    strucpp::strucpp_set_current_task("T");
    for (int k = 1; k <= 2; ++k) {
        try { strucpp::Program_MAIN p; p.K = k; p.run(); std::cout << k << " ok|"; }
        catch (const std::exception& e) { std::cout << k << " " << e.what() << "|"; }
    }
    std::cout << std::endl;
    return 0;
}
`,
    });
    expect(stdout.split("|").filter((l) => l !== "")).toEqual([
      "1 Value -1 outside 100..300 stored in X in MAIN, line 11, task T",
      "2 Value 42 outside 0..10 stored in FS.F in FS, line 6, task T",
    ]);
  });

  it("refuses an initial value inside a STRUCT initialiser, a nested default, a multi-dimensional ARRAY and an ARRAY OF STRUCT; reads a typed based literal signed", () => {
    const result = compile(`TYPE SR : INT (0..10); END_TYPE
TYPE S8 : SINT (-10..10); END_TYPE
TYPE SH : INT (100..300); END_TYPE
TYPE ST : STRUCT f : SR; END_STRUCT END_TYPE
TYPE ST2 : STRUCT s : ST := (f := 42); END_STRUCT END_TYPE
PROGRAM Main
VAR t : ST := (f := 42); t2 : ST2; m : ARRAY[1..2, 1..2] OF SR := [[42, 1], [1, 1]];
  as : ARRAY[1..2] OF ST := [(f := 42), (f := 1)]; z : S8 := SINT#16#FF; h : SH := SINT#16#FF; ok : ST := (f := 3); END_VAR
END_PROGRAM
`);
    expect(
      result.errors.map((e) => `${e.line}:${e.column} ${e.message}`).sort(),
    ).toEqual([
      "5:35 The initial value 42 of 'S.F' is outside its subrange 0..10",
      "7:21 The initial value 42 of 'T.F' is outside its subrange 0..10",
      "7:69 The initial value 42 of 'M' is outside its subrange 0..10",
      "8:36 The initial value 42 of 'AS.F' is outside its subrange 0..10",
      "8:84 The initial value -1 of 'H' is outside its subrange 100..300",
    ]);
  });
});
