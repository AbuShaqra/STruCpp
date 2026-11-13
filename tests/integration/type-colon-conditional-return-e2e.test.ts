/**
 * type_colon_optional and conditional_return end to end (g++): a STRUCT
 * declared without the colon and `RETURN (cond);` in a FUNCTION, METHOD and
 * PROGRAM run as their IEC spellings do.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile, type CompileOptions } from "../../src/index.js";
import type { DialectProfile } from "../../src/dialect.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const CODESYS3: DialectProfile = {
  id: "codesys3",
  name: "codesys3",
  extends: "iec-3",
  features: ["type_colon_optional", "conditional_return"],
  semantics: {},
};

const SOURCE = `TYPE
  ST_P STRUCT a : INT := 3; b : DINT; END_STRUCT
END_TYPE
FUNCTION F : INT
VAR_INPUT x : INT; END_VAR
F := 1;
RETURN (x > 5);
F := 2;
END_FUNCTION
FUNCTION_BLOCK FB_A
VAR_OUTPUT n : INT; END_VAR
METHOD M : INT
VAR_INPUT k : INT; END_VAR
M := k;
RETURN (k < 0);
M := k * 2;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR
  p : ST_P;
  fb : FB_A;
  r1, r2, r3, r4, steps : INT;
END_VAR
r1 := F(7);
r2 := F(1);
r3 := fb.M(-4);
r4 := fb.M(4);
p.b := p.b + 1;
RETURN (p.b >= 2);
steps := steps + 1;
END_PROGRAM
`;

describeIfGpp(
  "type_colon_optional and conditional_return — generated C++",
  () => {
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-colonret-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function run(opts: Partial<CompileOptions>, name: string): string[] {
      const result = compile(SOURCE, {
        headerFileName: "generated.hpp",
        ...opts,
      });
      expect(result.errors.map((e) => `${e.line}: ${e.message}`)).toEqual([]);
      const prints = ["R1", "R2", "R3", "R4", "STEPS"]
        .map((v) => `std::cout << (int)p.${v}.get() << " ";`)
        .join(" ");
      return compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: name,
        mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p; p.run(); p.run(); p.run();\n ${prints} std::cout << (int)p.P.A.get();\n return 0;\n}\n`,
      })
        .trim()
        .split(/\s+/);
    }

    // Three cycles: the program body stops at RETURN once p.b reaches 2.
    const EXPECTED = ["1", "2", "-4", "8", "1", "3"];

    it("runs under a profile with both features", () => {
      expect(run({ dialect: CODESYS3 }, "colonret_profile")).toEqual(EXPECTED);
    });

    it("runs with the features given one by one, under --strict too", () => {
      const features = ["+type_colon_optional", "+conditional_return"];
      expect(run({ features }, "colonret_flags")).toEqual(EXPECTED);
      expect(run({ features, strict: true }, "colonret_strict")).toEqual(
        EXPECTED,
      );
    });

    it("is refused under iec-3", () => {
      const r = compile(SOURCE, { dialect: "iec-3" });
      expect(r.errors.map((e) => e.message).sort()).toEqual([
        "RETURN (condition) needs the feature conditional_return",
        "RETURN (condition) needs the feature conditional_return",
        "RETURN (condition) needs the feature conditional_return",
        "TYPE ST_P without ':' before STRUCT needs the feature type_colon_optional",
      ]);
    });
  },
);
