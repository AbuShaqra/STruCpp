// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: OSCAT's ROUND(IN, N) is called for two arguments, positional or named,
 * and the standard ROUND for one; both build and run under g++.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const LIBS_DIR = path.resolve(__dirname, "../../libs");
const libsAvailable = fs.existsSync(path.join(LIBS_DIR, "oscat-basic.stlib"));

const SOURCE = `PROGRAM Main
VAR x : REAL := 3.14159; a : REAL; b : REAL; c : REAL; d : REAL; END_VAR
a := ROUND(x, 2);
b := ROUND(N := 3, IN := x);
c := ROUND(x);
d := ROUND(2.5);
END_PROGRAM
`;

describe.skipIf(!hasGpp || !libsAvailable)(
  "library ROUND(IN, N) beside the standard ROUND — g++ e2e",
  () => {
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-round-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    for (const [label, reverse] of [
      ["bundled order", false],
      ["reversed order", true],
    ] as const) {
      it(`builds and runs (${label})`, () => {
        const libraries = discoverStlibs(LIBS_DIR);
        if (reverse) libraries.reverse();
        const result = compile(SOURCE, {
          headerFileName: "generated.hpp",
          libraries,
        });
        expect(result.errors).toEqual([]);
        const stdout = compileAndRunStandalone({
          tempDir,
          pchPath,
          headerCode: result.headerCode,
          cppCode: result.cppCode,
          testName: `library_round_${reverse ? "rev" : "fwd"}`,
          mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.A.get() << " " << p.B.get() << " " << p.C.get() << " "
              << p.D.get() << std::endl;
    return 0;
}
`,
        });
        expect(stdout).toBe("3.14 3.142 3 3");
      });
    }
  },
);
