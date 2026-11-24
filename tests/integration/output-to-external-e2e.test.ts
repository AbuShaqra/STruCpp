// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: an output binding (`=>`) to a VAR_EXTERNAL of a CONFIGURATION global
 * writes the global: ENO and ordinary VAR_OUTPUTs of FB, FUNCTION and METHOD
 * calls, into a scalar, a STRUCT field, an ARRAY element and a bit. A bit
 * assignment to a scalar VAR_EXTERNAL writes it too. g++ runs it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `TYPE SX : STRUCT f : BOOL; v : INT; END_STRUCT END_TYPE
FUNCTION_BLOCK FB
VAR_INPUT x : INT; END_VAR
VAR_OUTPUT y : INT; q : BOOL; END_VAR
y := x * 2;
q := TRUE;
END_FUNCTION_BLOCK
FUNCTION F : INT
VAR_INPUT x : INT; END_VAR
VAR_OUTPUT o : INT; b : BOOL; END_VAR
o := x + 1;
b := TRUE;
F := x;
END_FUNCTION
FUNCTION_BLOCK FM
METHOD M : INT
VAR_INPUT x : INT; END_VAR
VAR_OUTPUT o : INT; END_VAR
o := x + 2;
M := x;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main
VAR_EXTERNAL
  gok, gok2, gok3, goff : BOOL; gy, gy2, gz : INT; gw : WORD;
  gs : SX; ga : ARRAY[1..3] OF INT; gb : ARRAY[1..3] OF BOOL;
END_VAR
VAR fb : FB; fm : FM; r : INT; END_VAR
fb(EN := TRUE, x := 5, y => gy, ENO => gok);
fb(EN := gok, x := 4, y => gs.v, ENO => gs.f);
fb(x := 3, y => ga[2], ENO => gb[2], q => gw.3);
fb(EN := FALSE, x := 9, ENO => goff);
r := F(EN := TRUE, x := 7, o => gy2, ENO => gok2);
r := F(x := 1, o => ga[3], ENO => gb[1], b => gw.5);
r := fm.M(EN := TRUE, x := 1, o => gz, ENO => gok3);
gw.0 := TRUE;
gb[3] := gok AND gok2 AND gok3 AND NOT goff;
END_PROGRAM
CONFIGURATION C
VAR_GLOBAL
  gok, gok2, gok3 : BOOL; goff : BOOL := TRUE; gy, gy2, gz : INT; gw : WORD;
  gs : SX; ga : ARRAY[1..3] OF INT; gb : ARRAY[1..3] OF BOOL;
END_VAR
RESOURCE R ON PLC
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM P WITH T : Main;
END_RESOURCE
END_CONFIGURATION
`;

const MAIN = `
#include <iostream>
int main() {
    static strucpp::Configuration_C cfg;
    cfg.P.run();
    using A3 = strucpp::Array1D<strucpp::IEC_INT, 1, 3>;
    using B3 = strucpp::Array1D<strucpp::IEC_BOOL, 1, 3>;
    std::cout << strucpp::GOK.read() << strucpp::GOK2.read() << strucpp::GOK3.read()
              << strucpp::GOFF.read() << " " << strucpp::GY.read() << " "
              << strucpp::GY2.read() << " " << strucpp::GZ.read() << " "
              << strucpp::GW.read() << " "
              << strucpp::GS.with_lock([](strucpp::SX* s) { return (bool)s->F; })
              << strucpp::GS.with_lock([](strucpp::SX* s) { return (int)s->V; }) << " "
              << strucpp::GA.with_lock([](A3* a) { return (int)(*a)[2]; }) << " "
              << strucpp::GA.with_lock([](A3* a) { return (int)(*a)[3]; }) << " "
              << strucpp::GB.with_lock([](B3* a) { return (bool)(*a)[1]; })
              << strucpp::GB.with_lock([](B3* a) { return (bool)(*a)[2]; })
              << strucpp::GB.with_lock([](B3* a) { return (bool)(*a)[3]; }) << std::endl;
    return 0;
}
`;

describe.skipIf(!hasGpp)("output binding to a VAR_EXTERNAL — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-out-ext-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const [label, options] of [
    ["no dialect", {}],
    ["iec-3", { dialect: "iec-3" }],
    ["strict", { strict: true }],
  ] as const) {
    it(`writes the CONFIGURATION globals (${label})`, () => {
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
        testName: `out_ext_${label.replace(/\W/g, "_")}`,
        mainCode: MAIN,
      });
      // gw: bits 0, 3, 5 = 41
      expect(stdout).toBe("1110 10 8 3 41 18 6 2 111");
    });
  }

  it("writes an ENO target through the global, never into a read", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.cppCode).toContain("GOK->write(true);");
    expect(result.cppCode).toContain(
      "GS->with_lock([&](auto* __glk){ (*__glk).F = true; });",
    );
    expect(result.cppCode).not.toMatch(/->read\(\) =|\}\) = (true|false);/);
  });
});
