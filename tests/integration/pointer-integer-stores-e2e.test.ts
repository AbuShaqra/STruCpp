// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: what the new argument and pointer checks leave accepted builds and runs
 * right. A REF_TO assigned to an LWORD, ULINT or LINT holds its address (it
 * failed g++ before), and a REF_TO into a DWORD builds with its warning; a
 * POINTER TO round-trips through an LWORD; a SINT into a UINT input warns
 * and wraps as C++ converts it; a TON takes an LTIME preset argument; a
 * POINTER TO BYTE moves under --strict. g++ and run, in the modes each builds.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const LIBS_DIR = path.resolve(__dirname, "../../libs");

const SOURCE = `TYPE PINT : POINTER TO INT; END_TYPE
TYPE ST_PA : STRUCT pa : PINT; END_STRUCT END_TYPE
FUNCTION F_UI : UDINT
VAR_INPUT x : UINT; END_VAR
F_UI := UINT_TO_UDINT(x);
END_FUNCTION
FUNCTION F_LI : LINT
VAR_INPUT x : LINT; END_VAR
F_LI := x;
END_FUNCTION
PROGRAM Main
VAR
  lt : LTIME := LTIME#1h2m3s; ok5 : BOOL; qs : ST_PA; v2 : INT;
  x : INT := 7; r : REF_TO INT; p : POINTER TO INT; q : POINTER TO INT;
  la : LWORD; lw : LWORD; ul : ULINT; li : LINT; dw : DWORD; si : SINT := SINT#-1;
  ok1 : BOOL; ok2 : BOOL; ok3 : BOOL; ok4 : BOOL; v : INT; u : UDINT;
  tm : TON; pt : LTIME := LT#5s; et : BOOL;
  bytes : ARRAY[0..3] OF BYTE := [1, 2, 3, 4]; pb : POINTER TO BYTE; b3 : BYTE;
END_VAR
r := REF(x);
p := ADR(x);
la := ADR(x);
lw := r;
ul := r;
li := r;
ok1 := lw = la AND ul = LWORD_TO_ULINT(la) AND li = LWORD_TO_LINT(la);
dw := r;
ok2 := dw = LWORD_TO_DWORD(la);
lw := p;
q := lw;
v := q^;
ok3 := q = p;
u := F_UI(si);
tm(IN := FALSE, PT := pt);
et := tm.Q;
pb := ADR(bytes);
pb := pb + 2;
b3 := pb^;
ok4 := b3 = 3;
ok5 := F_LI(lt) = LTIME_TO_LINT(lt);
qs.pa := la;
v2 := qs.pa^;
END_PROGRAM
`;

const MAIN = `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.OK1.get() << " " << p.OK2.get() << " " << p.OK3.get() << " "
              << p.V.get() << " " << p.U.get() << " " << p.ET.get() << " "
              << p.OK4.get() << " " << p.OK5.get() << " " << p.V2.get() << std::endl;
    return 0;
}
`;

describe.skipIf(!hasGpp)("pointer and argument stores — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-ptrint-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("builds and runs with the warnings of the default mode", () => {
    const result = compile(SOURCE, {
      headerFileName: "generated.hpp",
      libraries: discoverStlibs(LIBS_DIR),
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((w) => `${w.line}: ${w.message}`)).toEqual([
      "27: A REF_TO value gives a 64-bit address, which DWORD cannot hold; use a POINTER TO or PVOID, or __XWORD, LWORD or ULINT",
      "33: Cannot pass SINT to an input of type UINT without a conversion; use SINT_TO_UINT",
      "40: Cannot pass LTIME to an input of type LINT without a conversion; use LTIME_TO_LINT",
    ]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "ptrint_default",
      mainCode: MAIN,
    });
    // The address truncated to 32 bits equals the DWORD it was stored into.
    expect(stdout).toBe("1 1 1 7 65535 0 1 1 7");
  });

  it("moves a POINTER TO BYTE under --strict", () => {
    const result = compile(
      `PROGRAM Main
VAR bytes : ARRAY[0..3] OF BYTE := [1, 2, 3, 4]; pb : POINTER TO BYTE; ok4 : BOOL; END_VAR
pb := ADR(bytes);
pb := pb + 2;
ok4 := pb^ = 3;
END_PROGRAM
`,
      { strict: true, headerFileName: "generated.hpp" },
    );
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "ptrint_strict",
      mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.OK4.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("1");
  });
});
