/**
 * Named arguments in method calls bind by name (C16). The call used to drop
 * the names and emit the values in source order, so `m.Drive(b := 2, a := 1)`
 * ran as Drive(2, 1). Ends in g++ so the result is the proof.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

describeIfGpp("named arguments in method calls", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-namedargs-"));
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

  it("out-of-order named inputs give 12 (the C16 probe)", () => {
    const out = run(
      `FUNCTION_BLOCK FB_M
METHOD PUBLIC Drive : INT
VAR_INPUT a : INT; b : INT; END_VAR
Drive := a * 10 + b;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main
VAR m : FB_M; r : INT; END_VAR
r := m.Drive(b := 2, a := 1);
END_PROGRAM
`,
      " Program_MAIN p;\n p.run();\n std::cout << p.R.get() << std::endl;",
      "na_probe",
    );
    expect(out).toBe("12");
  });

  it("VAR_IN_OUT declared before VAR_INPUT, named out of order", () => {
    const out = run(
      `FUNCTION_BLOCK FB_M
METHOD PUBLIC Move : INT
VAR_IN_OUT pos : INT; END_VAR
VAR_INPUT delta : INT; scale : INT; END_VAR
pos := pos + delta * scale;
Move := pos;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main
VAR m : FB_M; p : INT := 100; r : INT; END_VAR
r := m.Move(scale := 3, delta := 2, pos := p);
END_PROGRAM
`,
      " Program_MAIN p;\n p.run();\n std::cout << p.R.get() << ' ' << p.P.get() << std::endl;",
      "na_inout_first",
    );
    expect(out).toBe("106 106");
  });

  it("VAR_IN_OUT and VAR_OUTPUT (=>) mixed, named out of order", () => {
    const out = run(
      `FUNCTION_BLOCK FB_M
METHOD PUBLIC Calc : INT
VAR_INPUT a : INT; END_VAR
VAR_OUTPUT sum : INT; END_VAR
VAR_IN_OUT acc : INT; END_VAR
VAR_INPUT b : INT; END_VAR
acc := acc + 1;
sum := a + b;
Calc := a - b;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main
VAR m : FB_M; cnt : INT := 5; s : INT; r : INT; END_VAR
r := m.Calc(b := 4, sum => s, acc := cnt, a := 10);
END_PROGRAM
`,
      " Program_MAIN p;\n p.run();\n std::cout << p.R.get() << ' ' << p.S.get() << ' ' << p.CNT.get() << std::endl;",
      "na_mixed",
    );
    expect(out).toBe("6 14 6");
  });

  it("a missing input takes its default", () => {
    const out = run(
      `FUNCTION_BLOCK FB_M
METHOD PUBLIC Drive : INT
VAR_INPUT a : INT; b : INT := 7; c : INT; END_VAR
Drive := a * 100 + b * 10 + c;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main
VAR m : FB_M; r : INT; END_VAR
r := m.Drive(c := 1, a := 2);
END_PROGRAM
`,
      " Program_MAIN p;\n p.run();\n std::cout << p.R.get() << std::endl;",
      "na_default",
    );
    expect(out).toBe("271");
  });

  it("positional arguments are unchanged", () => {
    const out = run(
      `FUNCTION_BLOCK FB_M
METHOD PUBLIC Drive : INT
VAR_INPUT a : INT; b : INT; END_VAR
Drive := a * 10 + b;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main
VAR m : FB_M; r : INT; END_VAR
r := m.Drive(1, 2);
END_PROGRAM
`,
      " Program_MAIN p;\n p.run();\n std::cout << p.R.get() << std::endl;",
      "na_positional",
    );
    expect(out).toBe("12");
  });

  it("a FUNCTION call named out of order (guard)", () => {
    const out = run(
      `FUNCTION F : INT
VAR_INPUT a : INT; b : INT; END_VAR
F := a * 10 + b;
END_FUNCTION
PROGRAM Main
VAR r : INT; END_VAR
r := F(b := 2, a := 1);
END_PROGRAM
`,
      " Program_MAIN p;\n p.run();\n std::cout << p.R.get() << std::endl;",
      "na_function",
    );
    expect(out).toBe("12");
  });

  it("an inherited method binds by name", () => {
    const out = run(
      `FUNCTION_BLOCK FB_A
METHOD PUBLIC Drive : INT
VAR_INPUT a : INT; b : INT; END_VAR
Drive := a * 10 + b;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_B EXTENDS FB_A
END_FUNCTION_BLOCK
PROGRAM Main
VAR m : FB_B; r : INT; END_VAR
r := m.Drive(b := 2, a := 1);
END_PROGRAM
`,
      " Program_MAIN p;\n p.run();\n std::cout << p.R.get() << std::endl;",
      "na_inherited",
    );
    expect(out).toBe("12");
  });

  it("a method calling a sibling method by name (this-> and bare)", () => {
    const out = run(
      `FUNCTION_BLOCK FB_M
VAR r1 : INT; r2 : INT; r3 : INT; END_VAR
METHOD Drive : INT
VAR_INPUT a : INT; b : INT; END_VAR
Drive := a * 10 + b;
END_METHOD
METHOD Both
r1 := THIS.Drive(b := 2, a := 1);
r2 := Drive(b := 4, a := 3);
END_METHOD
Both();
END_FUNCTION_BLOCK
PROGRAM Main
VAR m : FB_M; END_VAR
m();
END_PROGRAM
`,
      " Program_MAIN p;\n p.run();\n std::cout << p.M.R1.get() << ' ' << p.M.R2.get() << std::endl;",
      "na_sibling",
    );
    expect(out).toBe("12 34");
  });

  it("a program method called with named arguments", () => {
    const out = run(
      `PROGRAM MAIN
VAR r : INT; q : INT; END_VAR
METHOD Drive : INT
VAR_INPUT a : INT; b : INT; END_VAR
Drive := a * 10 + b;
END_METHOD
  r := Drive(b := 2, a := 1);
  q := MAIN.Drive(b := 4, a := 3);
END_PROGRAM
`,
      " Program_MAIN p;\n p.run();\n std::cout << p.R.get() << ' ' << p.Q.get() << std::endl;",
      "na_program",
    );
    expect(out).toBe("12 34");
  });

  it("SUPER, interface and REFERENCE TO calls bind by name", () => {
    const out = run(
      `INTERFACE I_M
METHOD Drive : INT
VAR_INPUT a : INT; b : INT; END_VAR
END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB_Base IMPLEMENTS I_M
METHOD Drive : INT
VAR_INPUT a : INT; b : INT; END_VAR
Drive := a * 10 + b;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_D EXTENDS FB_Base
METHOD Twice : INT
Twice := SUPER.Drive(b := 2, a := 1) * 2;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main
VAR d : FB_D; itf : I_M; rf : REFERENCE TO FB_D; r1 : INT; r2 : INT; r3 : INT; END_VAR
itf := d;
rf REF= d;
r1 := d.Twice();
r2 := itf.Drive(b := 4, a := 3);
r3 := rf.Drive(b := 6, a := 5);
END_PROGRAM
`,
      " Program_MAIN p;\n p.run();\n std::cout << p.R1 << ' ' << p.R2 << ' ' << p.R3 << std::endl;",
      "na_super_itf_ref",
    );
    expect(out).toBe("24 34 56");
  });
});
