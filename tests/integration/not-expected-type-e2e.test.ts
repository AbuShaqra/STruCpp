// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: NOT of an untyped constant takes the expected type of every context it
 * is used in: a comparison, a CASE label, an initialiser, a result, a
 * dereference, a SEL/MUX argument, and a 64-bit complement.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const MODES = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
] as const;

interface Case {
  name: string;
  source: string;
  print: string;
  expected: string;
  modes?: typeof MODES;
}

const CASES: Case[] = [
  {
    name: "comparison with a bit string, either side, and an IF condition",
    source: `PROGRAM Main
VAR w : WORD := 16#FF0F; b : BYTE := 16#F0; c1, c2, c3, c4 : BOOL; END_VAR
c1 := w = NOT 16#00F0; c2 := NOT 16#00F0 = w; c3 := b = NOT 16#0F;
IF w = NOT 16#00F0 THEN c4 := TRUE; END_IF;
END_PROGRAM`,
    print: `p.C1.get() << p.C2.get() << p.C3.get() << p.C4.get()`,
    expected: "1111",
  },
  {
    name: "CASE label on a WORD selector",
    source: `PROGRAM Main
VAR w : WORD := 16#FF0F; cs : INT; END_VAR
CASE w OF NOT 16#00F0: cs := 1; ELSE cs := 2; END_CASE;
END_PROGRAM`,
    print: `p.CS.get()`,
    expected: "1",
  },
  {
    name: "local ARRAY, STRUCT, ARRAY of STRUCT, alias and TYPE default initialisers",
    source: `TYPE ST : STRUCT a : WORD; b : BYTE; END_STRUCT END_TYPE
TYPE MYW : WORD; END_TYPE
TYPE MYD : WORD := NOT 16#00F0; END_TYPE
PROGRAM Main
VAR arr : ARRAY[0..1] OF WORD := [NOT 16#00F0, NOT 16#0F00]; s : ST := (a := NOT 16#00F0, b := NOT 16#0F);
sarr : ARRAY[0..0] OF ST := [(a := NOT 16#00F0)]; iaw : MYW := NOT 16#00F0; dw : MYD; END_VAR
END_PROGRAM`,
    print: `p.ARR[0].get() << " " << p.ARR[1].get() << " " << p.S.A.get() << " " << int(p.S.B.get()) << " " << p.SARR[0].A.get() << " " << p.IAW << " " << p.DW`,
    expected: "65295 61695 65295 240 65295 65295 65295",
  },
  {
    name: "FUNCTION result assignment",
    source: `FUNCTION F : WORD
VAR_INPUT q : INT; END_VAR
F := NOT 16#00F0;
END_FUNCTION
PROGRAM Main
VAR r : WORD; END_VAR
r := F(1);
END_PROGRAM`,
    print: `p.R.get()`,
    expected: "65295",
  },
  {
    name: "LWORD complement of a literal from 16#80000000 up",
    source: `PROGRAM Main
VAR l1, l2, l3 : LWORD; END_VAR
l1 := NOT 16#FFFF0000; l2 := NOT 16#FFFFFFFF; l3 := NOT (16#80000000 OR 16#1);
END_PROGRAM`,
    print: `std::hex << p.L1.get() << " " << p.L2.get() << " " << p.L3.get()`,
    expected: "ffffffff0000ffff ffffffff00000000 ffffffff7ffffffe",
  },
  {
    name: "SEL and MUX arguments",
    source: `PROGRAM Main
VAR w1, w2 : WORD; END_VAR
w1 := SEL(TRUE, 16#0, NOT 16#00F0); w2 := MUX(1, 16#0, NOT 16#00F0);
END_PROGRAM`,
    print: `p.W1.get() << " " << p.W2.get()`,
    expected: "65295 65295",
  },
  {
    name: "assignment through a dereference",
    source: `PROGRAM Main
VAR t, u : WORD; p : POINTER TO WORD; r : REF_TO WORD; END_VAR
p := ADR(t); p^ := NOT 16#00F0; r := REF(u); r^ := NOT 16#0F00;
END_PROGRAM`,
    print: `p.T.get() << " " << p.U.get()`,
    expected: "65295 61695",
    // POINTER TO and ADR are not IEC 61131-3
    modes: MODES.filter(([label]) => label !== "iec-3"),
  },
];

describe.skipIf(!hasGpp)("NOT typed from its expected type — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-not-exp-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  CASES.forEach((c, i) => {
    it(`complements in a ${c.name}`, () => {
      for (const [label, options] of c.modes ?? MODES) {
        const result = compile(c.source, {
          ...options,
          headerFileName: "generated.hpp",
        });
        expect(result.errors, label).toEqual([]);
        const stdout = compileAndRunStandalone({
          tempDir,
          pchPath,
          headerCode: result.headerCode,
          cppCode: result.cppCode,
          testName: `notexp_${i}_${label.replace(/\W/g, "_")}`,
          mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << ${c.print} << std::endl;
    return 0;
}
`,
        });
        expect(stdout, label).toBe(c.expected);
      }
    });
  });
});
