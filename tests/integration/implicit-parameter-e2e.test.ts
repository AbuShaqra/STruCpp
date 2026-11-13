/**
 * A FUNCTION whose inputs carry {attribute 'implicit-parameter'} end to end
 * (g++): the inputs are ordinary ones, filled by the call or by their initial
 * values, in every dialect.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile, type CompileOptions } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `FUNCTION LOG : INT
VAR_INPUT
  code : INT;
  {attribute 'implicit-parameter' := 'pouname'}
  pouName : STRING := 'none';
  {attribute 'implicit-parameter' := 'position'}
  position : STRING;
END_VAR
LOG := code + LEN(pouName) * 100 + LEN(position) * 10000;
END_FUNCTION
PROGRAM MAIN
VAR r1, r2 : INT; END_VAR
r1 := LOG(code := 1, position := 'L1');
r2 := LOG(2, 'MAIN', 'L12');
END_PROGRAM
`;

describeIfGpp("implicit-parameter inputs — generated C++", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-implicit-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("runs as ordinary inputs in every dialect", () => {
    for (const [opts, name] of [
      [{}, "implicit_default"],
      [{ strict: true }, "implicit_strict"],
      [{ dialect: "iec-3" }, "implicit_iec3"],
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
        mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p; p.run();\n std::cout << (int)p.R1.get() << " " << (int)p.R2.get();\n return 0;\n}\n`,
      });
      expect(out.trim().split(/\s+/)).toEqual(["20401", "30402"]);
    }
  });
});
