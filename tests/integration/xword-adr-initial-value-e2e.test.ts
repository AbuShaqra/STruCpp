/**
 * `ADR(x)` as the initial value of an integer variable (`__XWORD`, `ULINT`,
 * `LWORD`) builds and stores the address, in a PROGRAM, a FUNCTION and a
 * top-level VAR_GLOBAL (g++).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile, type CompileOptions } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `VAR_GLOBAL g : INT := 7; gw : __XWORD := ADR(g); END_VAR
FUNCTION F : INT
VAR x : INT := 9; w : __XWORD := ADR(x); p : POINTER TO INT; END_VAR
p := w;
F := p^;
END_FUNCTION
PROGRAM MAIN
VAR
  x : INT := 5;
  w : __XWORD := ADR(x);
  u : ULINT := ADR(x);
  lw : LWORD := ADR(x);
  t : __XWORD;
  p : POINTER TO INT;
  same, viaGlobal, fromFunction : INT;
END_VAR
t := ADR(x);
IF w = t THEN same := same + 1; END_IF;
IF u = t THEN same := same + 1; END_IF;
IF lw = t THEN same := same + 1; END_IF;
p := gw;
viaGlobal := p^;
fromFunction := F();
END_PROGRAM
`;

describe.skipIf(!hasGpp)("ADR as an initial value of an integer", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-xword-init-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("stores the address, as an assignment in the body does", () => {
    for (const [opts, name] of [
      [{}, "xword_init_default"],
      [{ strict: true }, "xword_init_strict"],
    ] as [Partial<CompileOptions>, string][]) {
      const result = compile(SOURCE, {
        headerFileName: "generated.hpp",
        ...opts,
      });
      expect(result.errors).toEqual([]);
      const out = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: name,
        mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p; p.run();\n std::cout << (int)p.SAME.get() << " " << (int)p.VIAGLOBAL.get() << " " << (int)p.FROMFUNCTION.get();\n return 0;\n}\n`,
      });
      expect(out.trim().split(/\s+/)).toEqual(["3", "7", "9"]);
    }
  });
});
