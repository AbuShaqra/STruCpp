/**
 * E2E: a library FUNCTION called with named arguments binds them to its
 * parameters by name, in its declared order, and an omitted input takes its
 * declared default, as for a user FUNCTION. The call used to pass the values
 * in source order and leave omitted inputs out.
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
  "library function named arguments end to end",
  () => {
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-libnamed-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    it("reorders named arguments and fills omitted defaults", () => {
      const result = compile(
        `
PROGRAM Main
VAR
  l : STRING := 'a,b,c'; s : STRING; sp : STRING;
  r1 : REAL; r2 : REAL; r3 : REAL; r4 : REAL;
END_VAR
s := LIST_GET(SEP := 44, LIST := l, POS := 2);
sp := LIST_GET(44, 2, l);
r1 := AIN(LOW := 0.0, BITS := 12, IN := 4095, HIGH := 5.0, SIGN := 255);
r2 := AIN(IN := 4095, BITS := 12, LOW := 0.0);
r3 := AIN(4095, 12, 255, 0.0, 10.0);
r4 := AIN(IN := 2047, LOW := 1.0, BITS := 12);
END_PROGRAM
`,
        { libraries: discoverStlibs(LIBS_DIR) },
      );
      expect(result.errors).toEqual([]);
      const out = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: "lib_named",
        mainCode: `
#include <iostream>
int main() {
  strucpp::Program_MAIN p;
  p.run();
  std::cout << p.S.c_str() << "|" << p.SP.c_str() << "|" << p.R1 << "|" << p.R2 << "|" << p.R3
            << "|" << (int)(p.R4 * 100) << std::endl;
  return 0;
}
`,
      });
      // The named LIST_GET call matches the positional one.
      expect(out).toBe("c|c|5|10|10|549");
    });
  },
);
