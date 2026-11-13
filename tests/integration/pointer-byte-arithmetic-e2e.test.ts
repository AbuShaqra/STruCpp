// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: pointer arithmetic counts bytes, as on a PLC: `p + n`, `p - n` and
 * `ADR(x) + n` move the address by n bytes whatever the target type is.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `TYPE ST : STRUCT a : BYTE; b : INT; c : DINT; END_STRUCT END_TYPE
PROGRAM MAIN
VAR arr : ARRAY[0..3] OF INT := [10, 20, 30, 40]; p : POINTER TO INT; v1, v2, v3, v4, v5 : INT; s : ST; pd : POINTER TO DINT; d : DINT; END_VAR
p := ADR(arr[0]);
p := p + 2; v1 := p^;
p := ADR(arr[0]) + 4; v2 := p^;
p := 2 + ADR(arr[0]); v3 := p^;
p := ADR(arr[3]) - 6; v4 := p^;
p := p - 0; v5 := p^;
s.c := 77; pd := ADR(s) + 4; d := pd^;
END_PROGRAM
`;

describe.skipIf(!hasGpp)("pointer arithmetic in bytes — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-ptrbytes-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const [label, options] of [
    ["no dialect", {}],
    ["strict", { strict: true }],
  ] as const) {
    it(`moves pointers by bytes (${label})`, () => {
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
        testName: `ptrbytes_${label.replace(/\W/g, "_")}`,
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.V1.get() << " " << p.V2.get() << " " << p.V3.get() << " " << p.V4.get() << " "
              << p.V5.get() << " " << p.D.get() << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe("20 30 20 10 10 77");
    });
  }
});
