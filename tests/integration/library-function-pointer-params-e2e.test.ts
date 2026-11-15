// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: a library FUNCTION with POINTER TO, pointer-to-pointer, ARRAY OF
 * POINTER and LWORD inputs, its manifest serialized and loaded back, takes
 * addresses from a program and reads through them; its POINTER TO and REF_TO
 * outputs captured into LWORD give the address. g++ and run.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile, compileStlib } from "../../src/index.js";
import { loadStlibArchive } from "../../src/library/library-loader.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const FEATURES = ["+pointer_to"];

describe.skipIf(!hasGpp)("library FUNCTION pointer inputs — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-libfn-ptr-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("passes addresses to pointer inputs and reads through them", () => {
    const lib = compileStlib(
      [
        {
          source: `FUNCTION F_Sum : DINT
VAR_INPUT
  p : POINTER TO INT;
  pp : POINTER TO POINTER TO INT;
  ap : ARRAY[0..1] OF POINTER TO INT;
  w : LWORD;
END_VAR
F_Sum := INT_TO_DINT(p^) + INT_TO_DINT(pp^^) + INT_TO_DINT(ap[0]^) + INT_TO_DINT(ap[1]^)
  + SEL(w <> 0, 0, 1000);
END_FUNCTION
`,
          fileName: "lib.st",
        },
      ],
      {
        name: "ptrlib",
        version: "1.0.0",
        namespace: "ptrlib",
        features: FEATURES,
      },
    );
    expect(lib.errors).toEqual([]);
    const archive = loadStlibArchive(JSON.parse(JSON.stringify(lib.archive)));
    const result = compile(
      `PROGRAM Main
VAR a : INT := 1; b : INT := 20; c : INT := 300; pb : POINTER TO INT;
  arr : ARRAY[0..1] OF POINTER TO INT; s : DINT; END_VAR
pb := ADR(b);
arr[0] := ADR(c); arr[1] := ADR(a);
s := F_Sum(p := ADR(a), pp := ADR(pb), ap := arr, w := ADR(a));
END_PROGRAM
`,
      {
        headerFileName: "generated.hpp",
        features: FEATURES,
        libraries: [archive],
      },
    );
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "libfn_pointer_inputs",
      mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.S.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("1322");
  });

  it("captures POINTER TO and REF_TO outputs into an LWORD as the address", () => {
    const lib = compileStlib(
      [
        {
          source: `FUNCTION F_Out : INT
VAR_IN_OUT
  x : INT;
END_VAR
VAR_OUTPUT
  po : POINTER TO INT;
  ro : REF_TO INT;
END_VAR
po := ADR(x);
ro := REF(x);
F_Out := 1;
END_FUNCTION
`,
          fileName: "out.st",
        },
      ],
      {
        name: "outlib",
        version: "1.0.0",
        namespace: "outlib",
        features: ["+pointer_to", "+reference_to"],
      },
    );
    expect(lib.errors).toEqual([]);
    const archive = loadStlibArchive(JSON.parse(JSON.stringify(lib.archive)));
    const result = compile(
      `PROGRAM Main
VAR x : INT; lp : LWORD; lr : ULINT; want : LWORD; n : INT; ok : INT; END_VAR
n := F_Out(x := x, po => lp, ro => lr);
want := ADR(x);
ok := SEL(lp = want, 0, 1) + SEL(LWORD_TO_ULINT(want) = lr, 0, 10) + SEL(lp <> 0, 0, 100);
END_PROGRAM
`,
      {
        headerFileName: "generated.hpp",
        features: ["+pointer_to", "+reference_to"],
        libraries: [archive],
      },
    );
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "libfn_pointer_outputs",
      mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.OK.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("111");
  });
});
