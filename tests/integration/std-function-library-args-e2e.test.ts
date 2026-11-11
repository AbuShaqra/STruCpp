// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: with the bundled libraries loaded, standard functions with valid
 * arguments build and run, and an argument outside the IEC constraint is
 * refused before g++ sees it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const LIBS_DIR = path.resolve(__dirname, "../../libs");
const libsAvailable = fs.existsSync(
  path.join(LIBS_DIR, "iec-std-functions.stlib"),
);

const source = (extra: string): string => `PROGRAM Main
VAR s : STRING := 'ABCDE'; n : INT; t : INT; x : REAL := 0.75; END_VAR
n := LEN(CONCAT(s, 'FG'));
t := TRUNC(LIMIT(0.0, x * 10.0, 5.0));
${extra}
END_PROGRAM
`;

describe.skipIf(!hasGpp || !libsAvailable)(
  "standard function arguments with libraries — g++ e2e",
  () => {
    let tempDir: string;
    let pchPath: string;
    const libraries = libsAvailable ? discoverStlibs(LIBS_DIR) : [];
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-stdlibargs-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    it("builds and runs valid calls", () => {
      const result = compile(source(""), {
        headerFileName: "generated.hpp",
        libraries,
      });
      expect(result.errors).toEqual([]);
      const stdout = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: "std_function_library_args",
        mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN p;
    p.run();
    std::cout << p.N.get() << " " << p.T.get() << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe("7 5");
    });

    it("refuses LEN of an INT", () => {
      const result = compile(source("n := LEN(n);"), {
        headerFileName: "generated.hpp",
        libraries,
      });
      expect(result.errors.map((e) => e.message)).toEqual([
        "Argument 'IN' of 'LEN' expects ANY_STRING, got INT",
      ]);
    });
  },
);
