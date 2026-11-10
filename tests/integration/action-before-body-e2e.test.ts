/**
 * E2E: an ACTION written before the body of its FUNCTION_BLOCK or PROGRAM,
 * as a METHOD is, alone or mixed with VAR blocks, methods and actions after
 * the body. It generates the same C++ as the action written after the body.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const BEFORE = `
FUNCTION_BLOCK FB_Q
VAR n : INT; END_VAR
ACTION A_Up: n := n + 1; END_ACTION
VAR_OUTPUT o : INT; END_VAR
METHOD M : INT
  A_Up();
  M := n;
END_METHOD
ACTION A_Ten
  n := n + 10;
END_ACTION
n := 0;
A_Up();
A_Ten();
o := M();
ACTION A_After: n := n + 100; END_ACTION
END_FUNCTION_BLOCK
PROGRAM Main
VAR q : FB_Q; m, r : INT; END_VAR
ACTION A_M: m := m + 1; END_ACTION
  q();
  A_M();
  A_M();
  q.A_After();
  r := q.o;
END_PROGRAM
`;

const AFTER = `
FUNCTION_BLOCK FB_Q
VAR n : INT; END_VAR
n := 0;
A_Up();
ACTION A_Up: n := n + 1; END_ACTION
END_FUNCTION_BLOCK
PROGRAM Main
VAR q : FB_Q; m : INT; END_VAR
  q();
  A_M();
ACTION A_M: m := m + 1; END_ACTION
END_PROGRAM
`;

const SAME_BEFORE = `
FUNCTION_BLOCK FB_Q
VAR n : INT; END_VAR
ACTION A_Up: n := n + 1; END_ACTION
n := 0;
A_Up();
END_FUNCTION_BLOCK
PROGRAM Main
VAR q : FB_Q; m : INT; END_VAR
ACTION A_M: m := m + 1; END_ACTION
  q();
  A_M();
END_PROGRAM
`;

const MODES: Array<[string, Parameters<typeof compile>[1]]> = [
  ["no flags", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
  ["strict iec-3", { strict: true, dialect: "iec-3" }],
];

describe("ACTION before the body", () => {
  it.each(MODES)("parses and analyses (%s)", (_name, options) => {
    expect(compile(BEFORE, options).errors.map((e) => e.message)).toEqual([]);
  });

  it("generates the same C++ as the action after the body", () => {
    const before = compile(SAME_BEFORE, {});
    const after = compile(AFTER, {});
    expect(before.errors).toEqual([]);
    expect(after.errors).toEqual([]);
    expect(before.cppCode.replace(/^#line.*$/gm, "")).toBe(
      after.cppCode.replace(/^#line.*$/gm, ""),
    );
    expect(before.headerCode).toBe(after.headerCode);
  });

  it("still reports a statement that is not closed by END_ACTION", () => {
    const r = compile(
      `PROGRAM Main VAR m : INT; END_VAR ACTION A_M: m := 1; m := 2; END_PROGRAM`,
      {},
    );
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!hasGpp)("ACTION before the body end to end", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-actbefore-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it.each(MODES)("builds and runs (%s)", (name, options) => {
    const r = compile(BEFORE, { ...options, headerFileName: "generated.hpp" });
    expect(r.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: r.headerCode,
      cppCode: r.cppCode,
      testName: `action_before_${name.replace(/[ -]/g, "_")}`,
      mainCode: `#include <iostream>
int main() {
  strucpp::Program_MAIN p;
  p.run();
  std::cout << (int)p.M << " " << (int)p.R << " " << (int)p.Q.N << std::endl;
  return 0;
}
`,
    });
    expect(out).toBe("2 12 112");
  });
});
