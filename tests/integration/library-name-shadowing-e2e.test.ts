/**
 * E2E: user declarations named like bundled-library symbols (a subrange
 * alias SR, an FB SPEED, a global MATH) build with g++ next to a used library
 * block and run with the user's meaning.
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

describe.skipIf(!hasGpp || !libsAvailable)(
  "user names shadowing library symbols end to end",
  () => {
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-shadow-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    it("builds and runs the user's SR, SPEED and MATH", () => {
      const result = compile(
        `
TYPE SR : INT(0..10); END_TYPE
FUNCTION_BLOCK SPEED
VAR_INPUT kmh : INT; END_VAR
VAR_OUTPUT ms : INT; END_VAR
ms := kmh / 2;
END_FUNCTION_BLOCK
VAR_GLOBAL
  MATH : INT := 7;
END_VAR
PROGRAM Main
VAR r : SR := 4; s : SPEED; t : TON; q : INT; END_VAR
s(kmh := 36);
t(IN := TRUE, PT := T#0s);
q := s.ms + r + MATH;
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
        testName: "shadow",
        mainCode: `#include <iostream>
int main() {
  strucpp::Program_MAIN p;
  p.run();
  std::cout << p.Q << std::endl;
  return 0;
}
`,
      });
      expect(out).toBe("29");
    });
  },
);
