/**
 * METHODs in a PROGRAM, end to end through g++: the generated members compile
 * and run, see the program's VARs, take inputs and return values, write a
 * configuration VAR_GLOBAL through VAR_EXTERNAL (Review Focus 6) and call each
 * other.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import { nodeDialectIO } from "../../src/node/dialect-io.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

describeIfGpp("PROGRAM methods end to end", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-progmeth-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function run(
    source: string,
    mainBody: string,
    name: string,
    options: Parameters<typeof compile>[1] = {
      features: ["+program_methods"],
    },
  ): string {
    const result = compile(source, {
      headerFileName: "generated.hpp",
      ...options,
    });
    expect(result.errors.map((e) => `${e.line}: ${e.message}`)).toEqual([]);
    return compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: name,
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n${mainBody}\n return 0;\n}\n`,
    });
  }

  it("a program method increments a program VAR", () => {
    const out = run(
      `PROGRAM MAIN
VAR n : INT; END_VAR
METHOD Inc
  n := n + 1;
END_METHOD
  Inc();
END_PROGRAM
`,
      " Program_MAIN p;\n p.run(); p.run(); p.run();\n std::cout << p.N.get() << std::endl;",
      "progmeth_inc",
    );
    expect(out).toBe("3");
  });

  it("a program method with VAR_INPUT and a return value", () => {
    const out = run(
      `PROGRAM MAIN
VAR total : DINT; last : DINT; END_VAR
METHOD AddScaled : DINT
VAR_INPUT k : DINT; factor : DINT; END_VAR
VAR tmp : DINT; END_VAR
  tmp := k * factor;
  total := total + tmp;
  AddScaled := total;
END_METHOD
  last := AddScaled(2, 5);
END_PROGRAM
`,
      " Program_MAIN p;\n p.run(); p.run();\n std::cout << p.TOTAL.get() << ' ' << p.LAST.get() << ' ' << p.ADDSCALED(1, 1).get() << std::endl;",
      "progmeth_input_return",
    );
    expect(out).toBe("20 20 21");
  });

  it("a program method that writes a configuration VAR_GLOBAL through VAR_EXTERNAL", () => {
    const out = run(
      `CONFIGURATION C
  VAR_GLOBAL g : INT := 7; END_VAR
  RESOURCE R ON PLC
    TASK T(INTERVAL := T#100ms, PRIORITY := 1);
    PROGRAM Inst WITH T : MAIN;
  END_RESOURCE
END_CONFIGURATION

PROGRAM MAIN
VAR_EXTERNAL g : INT; END_VAR
VAR seen : INT; END_VAR
METHOD Bump : INT
  g := g + 10;
  Bump := g;
END_METHOD
  seen := Bump();
END_PROGRAM
`,
      " Configuration_C c;\n c.INST.run(); c.INST.run();\n std::cout << G.value.get() << ' ' << c.INST.SEEN.get() << std::endl;",
      "progmeth_external",
    );
    expect(out).toBe("27 27");
  });

  it("a program method calls another program method", () => {
    const out = run(
      `PROGRAM MAIN
VAR n : INT; r : INT; END_VAR
METHOD Inc
  n := n + 1;
END_METHOD
METHOD IncTwice : INT
  Inc();
  MAIN.Inc();
  IncTwice := n;
END_METHOD
  r := IncTwice();
END_PROGRAM
`,
      " Program_MAIN p;\n p.run(); p.run();\n std::cout << p.N.get() << ' ' << p.R.get() << std::endl;",
      "progmeth_calls_method",
    );
    expect(out).toBe("4 4");
  });

  it("compiles and runs under the vendor-a profile", () => {
    const out = run(
      `PROGRAM MAIN
VAR n : INT; END_VAR
METHOD Inc : INT
  n := n + 2;
  Inc := n;
END_METHOD
  Inc();
END_PROGRAM
`,
      " Program_MAIN p;\n p.run(); p.run();\n std::cout << p.N.get() << std::endl;",
      "progmeth_vendor_a",
      {
        dialect: "vendor-a",
        dialectPath: ["tests/fixtures/dialects/good"],
        dialectIO: nodeDialectIO,
      },
    );
    expect(out).toBe("4");
  });
});
