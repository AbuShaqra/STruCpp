/**
 * The feature interface_zero end to end (g++): assign 0 to an interface,
 * compare it with 0, pass 0 to a function, FB and method input, then assign
 * an instance and call through it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `INTERFACE I_A
METHOD M : INT
END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB_A IMPLEMENTS I_A
METHOD M : INT
M := 7;
END_METHOD
METHOD IsNull : BOOL
VAR_INPUT x : I_A; END_VAR
IsNull := x = 0;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_U
VAR_INPUT i : I_A; END_VAR
VAR_OUTPUT isNull : BOOL; END_VAR
isNull := i = 0;
END_FUNCTION_BLOCK
FUNCTION IsSet : BOOL
VAR_INPUT x : I_A; END_VAR
IsSet := x <> 0;
END_FUNCTION
PROGRAM MAIN
VAR
  fb : FB_A;
  u : FB_U;
  inputNull, methodNull : BOOL;
  itf : I_A := 0;
  nullAtStart, nullAfterZero, setAfterAssign, argZero, argSet : BOOL;
  r : INT := -1;
END_VAR
nullAtStart := itf = 0;
itf := fb;
itf := 0;
nullAfterZero := itf = 0;
argZero := IsSet(0);
u(i := 0);
inputNull := u.isNull;
methodNull := fb.IsNull(0);
itf := fb;
setAfterAssign := itf <> 0;
argSet := IsSet(itf);
IF itf <> 0 THEN
  r := itf.M();
END_IF
END_PROGRAM
`;

describeIfGpp("interface_zero — generated C++", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-itfzero-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("0 is NULL; an instance assigned afterwards is called", () => {
    const result = compile(SOURCE, {
      headerFileName: "generated.hpp",
      features: ["+interface_zero"],
    });
    expect(result.errors.map((e) => `${e.line}: ${e.message}`)).toEqual([]);
    const prints = [
      "NULLATSTART",
      "NULLAFTERZERO",
      "ARGZERO",
      "SETAFTERASSIGN",
      "ARGSET",
      "R",
      "INPUTNULL",
      "METHODNULL",
    ]
      .map((p) => `std::cout << (int)p.${p}.get() << " ";`)
      .join(" ");
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "itf_zero",
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p; p.run();\n ${prints}\n return 0;\n}\n`,
    })
      .trim()
      .split(/\s+/);
    expect(out).toEqual(["1", "1", "0", "1", "1", "7", "1", "1"]);
  });
});
