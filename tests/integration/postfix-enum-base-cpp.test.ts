/**
 * Enumeration base type written after the value list, end to end through g++:
 * an enum declared `( ... ) DINT` (feature postfix_enum_base) drives a CASE
 * and its integer value is printed, with the same output as the base-first form.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

/** A program over `Mode`; `decl` is its TYPE declaration. */
function program(decl: string): string {
  return `TYPE
${decl}
END_TYPE
PROGRAM MAIN
VAR m : Mode; d : Mode := Mode#Run; code : DINT; END_VAR
  m := Mode#Fault;
  CASE m OF
    Mode#Idle: code := 1;
    Mode#Run: code := 2;
    Mode#Fault: code := 3;
  END_CASE
END_PROGRAM
`;
}

const PRINT =
  ' Program_MAIN p;\n p.run();\n std::cout << p.CODE.get() << " " << static_cast<long>(p.M.get().get()) << " " << static_cast<long>(p.D.get().get()) << std::endl;';

describeIfGpp("postfix enum base end to end", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-postfixenum-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function run(
    source: string,
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
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n${PRINT}\n return 0;\n}\n`,
    });
  }

  const POSTFIX = "Mode : (Idle := 10, Run := 20, Fault := 300) DINT;";
  const PREFIX = "Mode : DINT (Idle := 10, Run := 20, Fault := 300);";

  it("the postfix form drives a CASE and prints its value", () => {
    const out = run(program(POSTFIX), "postfixenum_postfix", {
      dialect: "iec-3",
      features: ["+postfix_enum_base"],
    });
    expect(out).toBe("3 300 20");
  });

  it("the base-first form prints the same", () => {
    const out = run(program(PREFIX), "postfixenum_prefix", {
      dialect: "iec-3",
    });
    expect(out).toBe("3 300 20");
  });
});
