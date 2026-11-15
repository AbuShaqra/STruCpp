// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E for feature string_default_80: a plain STRING holds 80 characters
 * (SIZEOF 81, WSTRING 162), a longer value stored is cut at 80, and a library
 * compiled with the feature keeps its 80 when a program without it binds a
 * plain STRING to its VAR_IN_OUT (copied in and out, cut at 80). g++ and run.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile, compileStlib } from "../../src/index.js";
import { loadStlibArchive } from "../../src/library/library-loader.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const LONG = "a".repeat(100);

const MAIN = `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.N1 << " " << p.N2 << " " << p.L1 << " " << p.L2 << " " << p.L3 << std::endl;
    return 0;
}
`;

describe.skipIf(!hasGpp)("feature string_default_80 — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-string80-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const SOURCE = `TYPE ST_A : STRUCT s : STRING; END_STRUCT; END_TYPE
FUNCTION F_Echo : STRING
VAR_INPUT a : STRING; END_VAR
F_Echo := a;
END_FUNCTION
PROGRAM Main
VAR s : STRING; w : WSTRING; st : ST_A; long : STRING(200) := '${LONG}';
  n1, n2, l1, l2, l3 : DINT; END_VAR
n1 := SIZEOF(s); n2 := SIZEOF(w);
s := long; l1 := LEN(s);
st.s := CONCAT(long, long); l2 := LEN(st.s);
l3 := LEN(F_Echo(long));
END_PROGRAM
`;

  for (const [label, options, expected] of [
    [
      "with the feature",
      { features: ["+string_default_80"] },
      "81 162 80 80 80",
    ],
    ["without it", {}, "255 510 100 200 100"],
  ] as const) {
    it(`a plain STRING's size and the cut of a store (${label})`, () => {
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
        testName: `string80_${label.replace(/\W/g, "_")}`,
        mainCode: MAIN,
      });
      expect(stdout).toBe(expected);
    });
  }

  it("a library compiled with the feature cuts at 80 through its VAR_IN_OUT, with no warning", () => {
    const lib = compileStlib(
      [
        {
          source: `FUNCTION_BLOCK FB_Add
VAR_IN_OUT s : STRING; END_VAR
s := CONCAT(s, 'x');
END_FUNCTION_BLOCK
`,
          fileName: "lib.st",
        },
      ],
      {
        name: "s80",
        version: "1.0.0",
        namespace: "s80",
        features: ["+string_default_80"],
      },
    );
    expect(lib.errors).toEqual([]);
    expect(lib.archive.manifest.stringDefaultLength).toBe(80);
    const archive = loadStlibArchive(JSON.parse(JSON.stringify(lib.archive)));
    const result = compile(
      `PROGRAM Main
VAR f : FB_Add; s : STRING := '${LONG}'; t : STRING := 'ab';
  n1, n2, l1, l2, l3 : DINT; END_VAR
f(s := s); l1 := LEN(s);
f(s := t); l2 := LEN(t);
n1 := SIZEOF(s); n2 := 0; l3 := 0;
END_PROGRAM
`,
      { headerFileName: "generated.hpp", libraries: [archive] },
    );
    expect(result.errors).toEqual([]);
    expect(
      result.warnings.filter((w) => w.message.includes("VAR_IN_OUT")),
    ).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "string80_library",
      mainCode: MAIN,
    });
    // 100 characters copied in are cut at 80; 'x' does not fit; 'ab' + 'x' does.
    expect(stdout).toBe("255 0 80 3 0");
  });

  it("an ARRAY[*] OF STRING parameter takes an array of 80-character strings", () => {
    const result = compile(
      `FUNCTION F_A : DINT
VAR_INPUT a : ARRAY[*] OF STRING; w : ARRAY[*] OF WSTRING; END_VAR
F_A := LEN(a[1]) * 100 + DINT_TO_DINT(UPPER_BOUND(a, 1)) * 10 + LEN(w[0]);
END_FUNCTION
PROGRAM Main
VAR x : ARRAY[0..1] OF STRING; y : ARRAY[0..1] OF WSTRING;
  n1, n2, l1, l2, l3 : DINT; END_VAR
x[1] := 'abc'; y[0] := "wz";
n1 := F_A(a := x, w := y); n2 := SIZEOF(x[0]); l1 := 0; l2 := 0; l3 := 0;
END_PROGRAM
`,
      { headerFileName: "generated.hpp", features: ["+string_default_80"] },
    );
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "string80_vla",
      mainCode: MAIN,
    });
    expect(stdout).toBe("312 81 0 0 0");
  });

  it("a plain STRING passed to a 254 library's METHOD in-out and output is copied", () => {
    const lib = compileStlib(
      [
        {
          source: `FUNCTION_BLOCK FB_L
METHOD M
VAR_IN_OUT q : STRING; END_VAR
q := CONCAT(q, 'x');
END_METHOD
METHOD M2
VAR_OUTPUT p : STRING; END_VAR
VAR_IN_OUT q : STRING; END_VAR
p := CONCAT(q, 'y');
END_METHOD
END_FUNCTION_BLOCK
`,
          fileName: "l.st",
        },
      ],
      { name: "l254", version: "1.0.0", namespace: "l254" },
    );
    expect(lib.errors).toEqual([]);
    const archive = loadStlibArchive(JSON.parse(JSON.stringify(lib.archive)));
    const result = compile(
      `PROGRAM Main
VAR f : FB_L; t : STRING := 'ab'; u : STRING; n1, n2, l1, l2, l3 : DINT; END_VAR
f.M(q := t);
f.M2(p => u, q := t);
n1 := LEN(t); n2 := LEN(u); l1 := SIZEOF(t); l2 := 0; l3 := 0;
END_PROGRAM
`,
      {
        headerFileName: "generated.hpp",
        features: ["+string_default_80"],
        libraries: [archive],
      },
    );
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "string80_lib_method",
      mainCode: MAIN,
    });
    // t: 'abx'; u: 'abxy'
    expect(stdout).toBe("3 4 81 0 0");
  });
});
