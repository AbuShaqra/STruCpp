// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: a user PROGRAM calls bundled OSCAT functions through the oscat-basic
 * .stlib, and the compiled binary returns their values. These functions keep
 * a POINTER TO BYTE local, which the manifest must not list as an input.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const LIBS_DIR = path.resolve(__dirname, "../../libs");
const oscatAvailable = fs.existsSync(path.join(LIBS_DIR, "oscat-basic.stlib"));

describe.skipIf(!hasGpp || !oscatAvailable)(
  "OSCAT functions called from a user program",
  () => {
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-oscat-calls-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    it("CHR_TO_STRING, UPPERCASE and BYTE_TO_STRH return their strings", () => {
      const result = compile(
        `
        PROGRAM Main
          VAR s1 : STRING(1); s2 : STRING; s3 : STRING; END_VAR
          s1 := CHR_TO_STRING(65);
          s2 := UPPERCASE('abc');
          s3 := BYTE_TO_STRH(16#A5);
        END_PROGRAM
      `,
        { libraries: discoverStlibs(LIBS_DIR) },
      );
      expect(result.errors).toEqual([]);
      expect(result.success).toBe(true);

      const stdout = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode!,
        cppCode: result.cppCode!,
        testName: "oscat_calls",
        mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN prog;
    prog.run();
    std::cout << prog.S1.c_str() << "|" << prog.S2.c_str() << "|"
              << prog.S3.c_str() << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe("A|ABC|A5");
    });
  },
);
