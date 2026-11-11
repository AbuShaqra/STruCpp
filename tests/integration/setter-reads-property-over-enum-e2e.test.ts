/**
 * E2E: a PROPERTY named like an enumeration member, whose SET body reads the
 * property's name (the value being set), emitted the enumeration member and
 * failed g++. The SET body reads the value now; a bare member of another
 * name still names the enumeration member.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `TYPE Mode : (Idle, Speed, Stop); END_TYPE
FUNCTION_BLOCK FB
VAR v : INT := 3; m : Mode := Mode#Idle; END_VAR
PROPERTY Speed : INT
GET
Speed := v * 2;
END_GET
SET
v := Speed + 1;
IF Speed > 5 THEN m := Mode#Speed; END_IF;
END_SET
END_PROPERTY
PROPERTY Level : Mode
SET
IF Level = Stop THEN v := 0; END_IF;
END_SET
END_PROPERTY
PROPERTY Cur : Mode
GET
Cur := m;
END_GET
END_PROPERTY
END_FUNCTION_BLOCK
PROGRAM Main
VAR f : FB; i1, i2, i3 : INT; END_VAR
i1 := f.Speed;
f.Speed := 7; i2 := f.Speed;
IF f.Cur = Mode#Speed THEN i3 := 1; END_IF;
f.Level := Mode#Stop; i3 := i3 * 10 + f.Speed;
END_PROGRAM
`;

describeIfGpp(
  "SET body reading its property over an enumeration member",
  () => {
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-setenum-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    for (const [label, options] of [
      ["no dialect", { features: ["+property"] }],
      ["strict, vendor features", { strict: true, features: ["+property"] }],
    ] as const) {
      it(`runs (${label})`, () => {
        const result = compile(SOURCE, {
          headerFileName: "generated.hpp",
          ...options,
          features: [...options.features],
        });
        expect(result.errors).toEqual([]);
        const out = compileAndRunStandalone({
          tempDir,
          pchPath,
          headerCode: result.headerCode,
          cppCode: result.cppCode,
          testName: "setter_enum",
          mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p;\n p.run();\n std::cout << p.I1.get() << '|' << p.I2.get() << '|' << p.I3.get() << std::endl;\n return 0;\n}\n`,
        });
        // 3 * 2; v = 8 -> 16; Cur = Speed, then Level = Stop sets v = 0
        expect(out).toBe("6|16|10");
      });
    }
  },
);
