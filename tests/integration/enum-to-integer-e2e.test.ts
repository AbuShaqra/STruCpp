// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * E2E: TO_DINT, TO_INT and the other conversions of an enumeration variable,
 * STRUCT field, array element or value give its underlying integer. Built
 * with g++ and run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

describe.skipIf(!hasGpp)("enum to integer conversion — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-enumint-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it.each([[undefined], ["iec-3" as const]])(
    "builds and runs (%s)",
    (dialect) => {
      const result = compile(
        `
      TYPE E_MODE : (ALPHA, BETA := 5, GAMMA); END_TYPE
      TYPE E_W : WORD (W1 := 1, W2 := 300); END_TYPE
      TYPE ST : STRUCT e : E_MODE := BETA; END_STRUCT END_TYPE
      PROGRAM Main
      VAR m : E_MODE := GAMMA; w : E_W := W2; s : ST;
        arr : ARRAY[0..1] OF E_MODE := [ALPHA, GAMMA];
        d : DINT; i : INT; u : UDINT; l : LINT; r : REAL; bv : BYTE; d3 : DINT; d4 : DINT; END_VAR
        d := TO_DINT(m);
        i := TO_INT(m);
        u := TO_UDINT(w);
        l := TO_LINT(E_MODE#BETA);
        r := TO_REAL(m);
        bv := TO_BYTE(m);
        d3 := TO_DINT(s.e);
        d4 := TO_DINT(arr[1]) + TO_DINT(BETA);
      END_PROGRAM
    `,
        { headerFileName: "generated.hpp", ...(dialect ? { dialect } : {}) },
      );
      expect(result.errors).toEqual([]);
      const stdout = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: `enum_to_integer_${dialect ?? "none"}`.replace("-", "_"),
        mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN prog;
    prog.run();
    std::cout << prog.D.get() << " " << prog.I.get() << " " << prog.U.get() << " "
              << prog.L.get() << " " << prog.R.get() << " " << int(prog.BV.get()) << " "
              << prog.D3.get() << " " << prog.D4.get() << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe("6 6 300 5 6 6 5 11");
    },
  );
});
