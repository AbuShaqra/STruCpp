// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: an unsigned integer assigned or passed to a wider signed one keeps its
 * value under g++, in every mode.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `FUNCTION FD : DINT VAR_INPUT x : DINT; END_VAR FD := x; END_FUNCTION
PROGRAM Main
VAR
  u : UINT := 65535; us : USINT := 255; ud : UDINT := 4294967295;
  d, d2, d3 : DINT; i : INT; l, l2 : LINT;
END_VAR
d := u;
i := us;
l := ud;
d2 := us;
l2 := u;
d3 := FD(u) + u;
END_PROGRAM
`;

describe.skipIf(!hasGpp)("unsigned to wider signed — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-widen-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const [label, options] of [
    ["no dialect", {}],
    ["iec-3", { dialect: "iec-3" }],
    ["strict", { strict: true }],
  ] as const) {
    it(`keeps every value (${label})`, () => {
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
        testName: `widen_${label.replace(/\W/g, "_")}`,
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.D.get() << " " << p.I.get() << " " << p.L.get() << " " << p.D2.get() << " "
              << p.L2.get() << " " << p.D3.get() << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe("65535 255 4294967295 255 65535 131070");
    });
  }
});
