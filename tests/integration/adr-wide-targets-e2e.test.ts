/**
 * An address stored where it fits (g++): ADR(x) + 0 into ULINT, ADR(x) into a
 * TYPE alias of LWORD and into a POINTER TO input.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `TYPE MyL : LWORD; END_TYPE
FUNCTION G : BOOL
VAR_INPUT p : POINTER TO INT; END_VAR
G := p <> 0;
END_FUNCTION
PROGRAM MAIN
VAR x : INT; lw : LWORD; ml : MyL; ul : ULINT; b : BOOL; END_VAR
lw := ADR(x);
ml := ADR(x);
ul := ADR(x) + 0;
b := G(ADR(x));
END_PROGRAM
`;

describe.skipIf(!hasGpp)("addresses stored where they fit (#9)", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-adr-wide-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("builds and stores the whole address", () => {
    const r = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(r.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: r.headerCode,
      cppCode: r.cppCode,
      testName: "adr_wide_targets",
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p; p.run();\n std::cout << (p.LW.get() == (unsigned long long)p.ML) << " " << (p.UL.get() == p.LW.get()) << " " << p.B.get();\n return 0;\n}\n`,
    });
    expect(out.trim().split(/\s+/)).toEqual(["1", "1", "1"]);
  });
});
