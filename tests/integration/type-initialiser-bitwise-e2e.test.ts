// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: AND, OR, XOR and NOT of a typed bit string in a STRUCT element's
 * default (an alias, a nested STRUCT, an array literal and `NOT (x)` included)
 * are bitwise, as the same expression is in a POU variable's initial value.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `VAR_GLOBAL CONSTANT GM : WORD := 16#F0; GB : BYTE := 16#0F; GL : LWORD := 16#0F; END_VAR
TYPE MYW : WORD; END_TYPE
TYPE INNER : STRUCT w : WORD; b : BYTE; END_STRUCT END_TYPE
TYPE ST : STRUCT
  a : WORD := 16#F0 AND 16#3C;
  o : WORD := 16#F0 OR 16#0F;
  x : WORD := 16#F0 XOR 16#FF;
  g : WORD := GM AND 16#30;
  n : WORD := NOT WORD#16#00F0;
  nb : BOOL := NOT FALSE;
  b : BOOL := TRUE AND (1 > 0);
  c : BOOL := FALSE OR (2 < 1);
  an : MYW := NOT WORD#16#00F0;
  q : BYTE := (NOT BYTE#16#0F) / 16;
  pb : BOOL := NOT (1 > 0);
  pw : WORD := NOT (WORD#16#00F0);
  i : INNER := (w := NOT WORD#16#00F0, b := NOT BYTE#16#F0);
  arr : ARRAY[0..1] OF WORD := [NOT WORD#16#00F0, 16#F0 AND 16#3C];
  ka : WORD := (NOT GB) / 16;
  kb : BOOL := (NOT GB) = 16#F0;
  kc : LWORD := NOT GL;
  kf : WORD := NOT (NOT GM);
  km : WORD := NOT GM;
  sh : LWORD := SHL(NOT DWORD#16#0F, 4);
END_STRUCT END_TYPE
PROGRAM MAIN
VAR s : ST; pa : WORD := 16#F0 AND 16#3C; pn : WORD := NOT GM; END_VAR
END_PROGRAM
`;

describe.skipIf(!hasGpp)(
  "bitwise operators in a STRUCT default — g++ e2e",
  () => {
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-typeinit-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    it("refuses a FUNCTION call in a STRUCT default", () => {
      const r = compile(
        "FUNCTION FW : WORD VAR_INPUT x : WORD; END_VAR FW := x; END_FUNCTION\nTYPE S : STRUCT d : WORD := NOT FW(16#0F); END_STRUCT END_TYPE\nPROGRAM MAIN VAR s : S; END_VAR END_PROGRAM\n",
      );
      expect(r.errors.map((e) => e.message)).toEqual([
        "The default of STRUCT field 'S.D' must be a constant expression: 'FW' is a FUNCTION call",
      ]);
    });

    for (const [label, options] of [
      ["no dialect", {}],
      ["iec-3", { dialect: "iec-3" }],
      ["strict", { strict: true }],
    ] as const) {
      it(`gives a STRUCT default the value of the same POU initial value (${label})`, () => {
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
          testName: `typeinit_${label.replace(/\W/g, "_")}`,
          mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    const auto& s = p.S;
    std::cout << s.A << " " << s.O << " " << s.X << " " << s.G << " " << s.N << " "
              << s.NB << s.B << s.C << " " << p.PA.get() << " " << p.PN.get() << " "
              << s.AN << " " << int(s.Q) << " " << s.PB << " " << s.PW << " " << s.I.W << " "
              << int(s.I.B) << " " << s.ARR.at(0) << " " << s.ARR.at(1) << " "
              << s.KA << s.KB << " " << s.KC << " " << s.KF << " " << s.KM << " " << s.SH << std::endl;
    return 0;
}
`,
        });
        expect(stdout).toBe(
          "48 255 15 48 65295 110 48 65295 65295 15 0 65295 65295 15 65295 48 151 18446744073709551600 240 65295 4294967040",
        );
      });
    }
    const WIDTH_SOURCE = `VAR_GLOBAL CONSTANT GL : LWORD := 16#0F; GW : WORD := 16#00F3; GB : BYTE := 16#0F; GM : WORD := 16#00F0; END_VAR
TYPE ST : STRUCT
  sa : LWORD := SHL(GL, 40);
  sw : WORD := SHR(SHL(GW, 15), 7);
  sn : WORD := NOT SHR(SHL(GW, 15), 7);
  ma : WORD := NOT (BYTE#16#01 OR WORD#16#0100);
  mb : WORD := NOT (WORD#16#0100 OR BYTE#16#01);
  mc : WORD := NOT (GB OR GM);
  md : WORD := NOT (GM OR GB);
  ra : WORD := NOT ROL(GM, 4);
  rb : WORD := ROR(GM, 4);
  rc : WORD := SHR(NOT(GM), 2);
END_STRUCT END_TYPE
PROGRAM MAIN
VAR s, t : ST; w : WORD; END_VAR
t.sa := SHL(GL, 40); t.sw := SHR(SHL(GW, 15), 7); t.sn := NOT SHR(SHL(GW, 15), 7);
w := BYTE#16#01 OR WORD#16#0100; t.ma := NOT w; t.mb := NOT w;
w := GB OR GM; t.mc := NOT w; t.md := NOT w;
t.ra := NOT ROL(GM, 4); t.rb := ROR(GM, 4); t.rc := SHR(NOT(GM), 2);
END_PROGRAM
`;

    for (const [label, options] of [
      ["no dialect", {}],
      ["iec-3", { dialect: "iec-3" }],
      ["strict", { strict: true }],
    ] as const) {
      it(`computes a folded constant and a mixed-width operand in the declared width, as a body does (${label})`, () => {
        const result = compile(WIDTH_SOURCE, {
          ...options,
          headerFileName: "generated.hpp",
        });
        expect(result.errors).toEqual([]);
        const stdout = compileAndRunStandalone({
          tempDir,
          pchPath,
          headerCode: result.headerCode,
          cppCode: result.cppCode,
          testName: `typeinit_width_${label.replace(/\W/g, "_")}`,
          mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    for (const auto* s : {&p.S, &p.T}) {
        std::cout << s->SA << " " << s->SW << " " << s->SN << " " << s->MA << " "
                  << s->MB << " " << s->MC << " " << s->MD << " " << s->RA << " "
                  << s->RB << " " << s->RC << std::endl;
    }
    return 0;
}
`,
        });
        const line =
          "16492674416640 256 65279 65278 65278 65280 65280 61695 15 16323";
        expect(stdout).toBe(`${line}\n${line}`);
      });
    }
  },
);
