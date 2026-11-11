/**
 * E2E: a REFERENCE TO input of a library FUNCTION refers to the caller's
 * variable. The manifest dropped the reference, so the call failed g++.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile, compileStlib } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

describe.skipIf(!hasGpp)(
  "library FUNCTION REFERENCE TO inputs — g++ e2e",
  () => {
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-libref-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    it("updates the caller's variable", () => {
      const lib = compileStlib(
        [
          {
            source: `FUNCTION Bump : INT
VAR_INPUT r : REFERENCE TO INT; d : INT; END_VAR
r := r + d;
Bump := r;
END_FUNCTION`,
            fileName: "bump.st",
          },
        ],
        { name: "bump-lib", version: "1.0.0", namespace: "strucpp" },
      );
      expect(lib.success).toBe(true);
      const result = compile(
        `PROGRAM Main
VAR x, y, z, w : INT := 1; a : ARRAY[0..1] OF INT := [3, 4]; END_VAR
y := Bump(x, 5);
z := Bump(d := 10, r := x);
w := Bump(a[1], 100) + a[1];
END_PROGRAM`,
        { headerFileName: "generated.hpp", libraries: [lib.archive!] },
      );
      expect(result.errors).toEqual([]);
      const stdout = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: "library_function_ref",
        mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN p;
    p.run();
    std::cout << p.X.get() << " " << p.Y.get() << " " << p.Z.get() << " " << p.W.get() << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe("16 6 16 208");
    });
  },
);
