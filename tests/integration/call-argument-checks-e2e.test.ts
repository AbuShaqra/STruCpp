// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: forms the added checks warn about build and run with the right
 * values: a typed conversion of the long or short form of its date or time
 * (`LTIME_TO_DINT(t)` of a TIME), a library FUNCTION's scalar in/out copied
 * in and out, LTIME elements of initializers stored in TIME, `0` returned as
 * a METHOD's interface result, a POINTER TO result stored in a pointer and an
 * ARRAY OF DINT passed to an ARRAY OF INT input. g++ and run.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile, compileStlib } from "../../src/index.js";
import { loadStlibArchive } from "../../src/library/library-loader.js";
import type { StlibArchive } from "../../src/library/library-manifest.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const MAIN = (expr: string): string => `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << ${expr} << std::endl;
    return 0;
}
`;

describe.skipIf(!hasGpp)("added argument checks — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-argchecks-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const run = (
    source: string,
    print: string,
    name: string,
    libraries: StlibArchive[] = [],
  ): { stdout: string; warnings: string[] } => {
    const result = compile(source, {
      headerFileName: "generated.hpp",
      libraries,
    });
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: name,
      mainCode: MAIN(print),
    });
    return { stdout, warnings: result.warnings.map((w) => w.message) };
  };

  it("converts a short date or time into its long form's conversion, and the long into the short one's", () => {
    const { stdout, warnings } = run(
      `PROGRAM Main
VAR t : TIME := T#3ms; lt : LTIME := LTIME#4ms; dt1 : DT := DT#1970-01-01-00:00:02;
  tod1 : TOD := TOD#00:00:01; r : LINT; END_VAR
r := LTIME_TO_LINT(t);
r := r + TIME_TO_LINT(lt) * 10;
r := r + LDT_TO_LINT(dt1) / 1000;
r := r + LTOD_TO_LINT(tod1);
END_PROGRAM
`,
      "p.R",
      "argchecks_temporal",
    );
    expect(stdout).toBe(String(3000000 + 40 + 2000000 + 1000000000));
    expect(warnings).toEqual([
      "Argument 'IN' of 'TIME_TO_LINT' expects TIME, got LTIME",
    ]);
  });

  it("copies a library FUNCTION's scalar in/out of another type in and out", () => {
    const lib = compileStlib(
      [
        {
          source: `FUNCTION F_IO : INT VAR_IN_OUT x : INT; END_VAR x := x + 1; F_IO := x; END_FUNCTION`,
          fileName: "lib.st",
        },
      ],
      { name: "lio", version: "1.0.0", namespace: "lio" },
    );
    expect(lib.errors).toEqual([]);
    const { stdout, warnings } = run(
      `PROGRAM Main
VAR w : WORD := 4; ui : UINT := 7; r : DINT; END_VAR
r := F_IO(ui);
r := r * 100 + F_IO(w);
r := r * 100 + UINT_TO_DINT(ui) * 10 + WORD_TO_DINT(w);
END_PROGRAM
`,
      "p.R",
      "argchecks_lib_inout",
      [loadStlibArchive(JSON.parse(JSON.stringify(lib.archive)))],
    );
    expect(stdout).toBe("80585");
    expect(warnings).toHaveLength(2);
  });

  it("stores LTIME elements of STRUCT and ARRAY initializers in TIME", () => {
    const { stdout } = run(
      `TYPE S_T : STRUCT t : TIME; u : INT; END_STRUCT END_TYPE
TYPE S_W : STRUCT s : S_T; END_STRUCT END_TYPE
PROGRAM Main
VAR s : S_T := (t := LTIME#1s, u := 2);
  a : ARRAY[1..2] OF TIME := [LTIME#2s, T#3s];
  w : S_W := (s := (t := LTIME#4s));
  sa : ARRAY[1..2] OF S_T := [(t := LTIME#5s), (t := T#6s)];
  r : DINT;
END_VAR
r := TIME_TO_DINT(s.t) + TIME_TO_DINT(a[1]) + TIME_TO_DINT(a[2])
  + TIME_TO_DINT(w.s.t) + TIME_TO_DINT(sa[1].t) + TIME_TO_DINT(sa[2].t);
END_PROGRAM
`,
      "p.R",
      "argchecks_ltime_init",
    );
    expect(stdout).toBe("21000");
  });

  it("returns 0 as a METHOD's interface result (NULL) and a POINTER TO result into a pointer", () => {
    const { stdout } = run(
      `INTERFACE I_A END_INTERFACE
FUNCTION_BLOCK FB_A
METHOD MM : I_A MM := 0; END_METHOD
END_FUNCTION_BLOCK
FUNCTION F10 : POINTER TO INT VAR_INPUT p : POINTER TO INT; END_VAR F10 := p; END_FUNCTION
PROGRAM Main
VAR fb : FB_A; i : I_A; p : POINTER TO INT; v : INT := 9; r : INT; END_VAR
i := fb.MM();
IF i = 0 THEN r := 10; END_IF
p := F10(ADR(v));
r := r + p^;
END_PROGRAM
`,
      "p.R",
      "argchecks_null_ptr",
    );
    expect(stdout).toBe("19");
  });

  it("passes an ARRAY OF DINT to an ARRAY OF INT input with a warning", () => {
    const { stdout, warnings } = run(
      `FUNCTION F3 : INT VAR_INPUT a : ARRAY[1..3] OF INT; END_VAR F3 := a[1] + a[3]; END_FUNCTION
PROGRAM Main
VAR d : ARRAY[1..3] OF DINT := [1, 2, 300]; r : INT; END_VAR
r := F3(d);
END_PROGRAM
`,
      "p.R",
      "argchecks_array_dint",
    );
    expect(stdout).toBe("301");
    expect(warnings).toEqual([
      "Cannot store ARRAY[1..3] OF DINT in input 'A' of type ARRAY[1..3] OF INT",
    ]);
  });
});
