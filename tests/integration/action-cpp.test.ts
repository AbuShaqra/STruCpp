/**
 * ACTION blocks end to end through g++: a PROGRAM's top-level and in-POU
 * actions run (acceptance 1), an FB action runs through an instance and from a
 * method, an action writes a configuration VAR_GLOBAL through VAR_EXTERNAL
 * (Review Focus 6), RETURN leaves an action, and all of it compiles under
 * --strict --dialect iec-3.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

describeIfGpp("ACTIONs end to end", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-action-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function run(
    source: string,
    mainBody: string,
    name: string,
    options: Parameters<typeof compile>[1] = {},
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

  it("a PROGRAM's top-level action runs (acceptance 1)", () => {
    const out = run(
      `PROGRAM MAIN
VAR n : INT; END_VAR
  Count();
  Count();
END_PROGRAM

ACTION MAIN.Count:
  n := n + 1;
END_ACTION
`,
      " Program_MAIN p;\n p.run();\n std::cout << p.N.get() << std::endl;",
      "action_top_level",
    );
    expect(out).toBe("2");
  });

  it("a PROGRAM's in-POU action runs", () => {
    const out = run(
      `PROGRAM MAIN
VAR n : INT; END_VAR
  Bump();
  ACTION Bump
    n := n + 3;
  END_ACTION
END_PROGRAM
`,
      " Program_MAIN p;\n p.run(); p.run();\n std::cout << p.N.get() << std::endl;",
      "action_in_pou",
    );
    expect(out).toBe("6");
  });

  it("an FB action through an instance", () => {
    const out = run(
      `FUNCTION_BLOCK Counter
VAR n : INT; END_VAR
  n := n + 1;
  ACTION Reset:
    n := 0;
  END_ACTION
END_FUNCTION_BLOCK

PROGRAM MAIN
VAR b : Counter; before : INT; after : INT; END_VAR
  b();
  b();
  before := b.n;
  b.Reset();
  after := b.n;
END_PROGRAM
`,
      " Program_MAIN p;\n p.run();\n std::cout << p.BEFORE.get() << ' ' << p.AFTER.get() << std::endl;",
      "action_fb_instance",
    );
    expect(out).toBe("2 0");
  });

  it("an action called from a method", () => {
    const out = run(
      `FUNCTION_BLOCK Counter
VAR n : INT; END_VAR
METHOD Step : INT
  Inc();
  THIS.Inc();
  Step := n;
END_METHOD
  ACTION Inc:
    n := n + 10;
  END_ACTION
END_FUNCTION_BLOCK

PROGRAM MAIN
VAR b : Counter; r : INT; END_VAR
  r := b.Step();
END_PROGRAM
`,
      " Program_MAIN p;\n p.run(); p.run();\n std::cout << p.R.get() << std::endl;",
      "action_from_method",
    );
    expect(out).toBe("40");
  });

  it("an action writes a configuration global through VAR_EXTERNAL", () => {
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
  Bump();
  seen := g;
END_PROGRAM

ACTION MAIN.Bump
  g := g + 10;
END_ACTION
`,
      " Configuration_C c;\n c.INST.run(); c.INST.run();\n std::cout << G.value.get() << ' ' << c.INST.SEEN.get() << std::endl;",
      "action_external",
    );
    expect(out).toBe("27 27");
  });

  it("an action with RETURN", () => {
    const out = run(
      `PROGRAM MAIN
VAR n : INT; END_VAR
  Limited();
  ACTION Limited:
    IF n >= 2 THEN
      RETURN;
    END_IF
    n := n + 1;
  END_ACTION
END_PROGRAM
`,
      " Program_MAIN p;\n p.run(); p.run(); p.run(); p.run();\n std::cout << p.N.get() << std::endl;",
      "action_return",
    );
    expect(out).toBe("2");
  });

  it("an action under --strict --dialect iec-3", () => {
    const out = run(
      `FUNCTION_BLOCK Counter
VAR_INPUT delta : INT; END_VAR
VAR n : INT; END_VAR
  Inc();
  ACTION Inc:
    n := n + delta;
  END_ACTION
END_FUNCTION_BLOCK

PROGRAM MAIN
VAR b : Counter; n : INT; total : INT; END_VAR
  b(delta := 5);
  Count();
  ACTION Count:
    n := n + 1;
    total := b.n + n;
  END_ACTION
END_PROGRAM
`,
      " Program_MAIN p;\n p.run(); p.run();\n std::cout << p.TOTAL.get() << std::endl;",
      "action_strict_iec",
      { strict: true, dialect: "iec-3" },
    );
    expect(out).toBe("12");
  });
});
