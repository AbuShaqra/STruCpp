// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * E2E: variables of an alias of an elementary or enumeration type, or of a
 * subrange, start at their default (0, FALSE, the first value, the lower
 * bound) even in memory that held other data. Built with g++ and run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

describe.skipIf(!hasGpp)("scalar alias variable defaults — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-aliasinit-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("builds and runs", () => {
    const result = compile(
      `
      TYPE T : INT; END_TYPE
      TYPE T2 : T; END_TYPE
      TYPE TR : REAL; END_TYPE
      TYPE TB : BOOL; END_TYPE
      TYPE E2 : (A, B); END_TYPE
      TYPE E2A : E2; END_TYPE
      TYPE SRX : INT(3..10); END_TYPE
      FUNCTION_BLOCK FB
      VAR_OUTPUT m : T; END_VAR
        m := m + 1;
      END_FUNCTION_BLOCK
      FUNCTION F : INT
      VAR fl : SRX; END_VAR
        F := fl;
      END_FUNCTION
      PROGRAM Main
      VAR x : T; x2 : T2; r : TR; b : TB; e : E2A; s : SRX; fb : FB;
        nx : INT; nx2 : INT; isZero : BOOL; nb : BOOL; isA : BOOL; ns : INT;
        nm : INT; nf : INT; END_VAR
        x := x + 1;
        nx := x;
        nx2 := x2;
        isZero := r = 0.0;
        nb := b;
        isA := e = E2#A;
        ns := s;
        fb();
        nm := fb.m;
        nf := F();
      END_PROGRAM
      `,
      { headerFileName: "generated.hpp" },
    );
    expect(result.errors.map((e) => `${e.line}: ${e.message}`)).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "scalar_alias_init",
      mainCode: `#include <iostream>
#include <cstring>
#include <new>
int main() {
  using namespace strucpp;
  // Construct over memory that held other data.
  alignas(Program_MAIN) static unsigned char buf[sizeof(Program_MAIN)];
  std::memset(buf, 0x5A, sizeof buf);
  Program_MAIN* p = new (buf) Program_MAIN();
  p->run();
  std::cout << p->NX.get() << " " << p->NX2.get() << " " << p->ISZERO.get() << " "
            << p->NB.get() << " " << p->ISA.get() << " " << p->NS.get() << " "
            << p->NM.get() << " " << p->NF.get() << std::endl;
  return 0;
}
`,
    });
    expect(out).toBe("1 0 1 0 1 3 1 3");
  });
});
