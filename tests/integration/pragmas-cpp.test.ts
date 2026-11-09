// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * Pragmas end to end: a program with `{attribute ...}` lines compiles with
 * and without `--dialect iec-3`, builds with g++ and prints the same as the
 * same program without pragmas.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import type { CompileOptions } from "../../src/types.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const PLAIN = `FUNCTION_BLOCK Acc
VAR_INPUT step : INT; END_VAR
VAR_OUTPUT total : INT; END_VAR
total := total + step;
END_FUNCTION_BLOCK
VAR_GLOBAL n : INT; END_VAR
PROGRAM Main
VAR
  acc : Acc;
  i : INT;
END_VAR
FOR i := 1 TO 4 DO
  acc(step := i);
END_FOR;
n := acc.total * 2;
END_PROGRAM
`;

const WITH_PRAGMAS = `{attribute 'scoped'}
FUNCTION_BLOCK Acc
VAR_INPUT {attribute 'hide'} step : INT; END_VAR
VAR_OUTPUT total : INT; END_VAR
{attribute 'nocheck'}
total := total + {inline note} step;
END_FUNCTION_BLOCK
{attribute 'keep'}
VAR_GLOBAL n : INT; END_VAR
{attribute 'after_init'
 attribute 'spans lines'}
PROGRAM Main
VAR
  {attribute 'path'}
  acc : Acc;
  i : INT;
END_VAR
FOR i := 1 TO 4 DO
  acc(step := i); {attribute 'trailing'}
END_FOR;
n := acc.total * 2;
END_PROGRAM
{attribute 'end of file'}
`;

describeIfGpp("pragmas end to end", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-pragmas-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function run(source: string, opts: CompileOptions, name: string): string {
    const result = compile(source, { ...opts, headerFileName: "generated.hpp" });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    return compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: name,
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p;\n p.run();\n std::cout << N.get() << std::endl;\n return 0;\n}\n`,
    });
  }

  it("without the pragmas the program prints 20", () => {
    expect(run(PLAIN, {}, "pragmas_plain")).toBe("20");
  });

  it("with the pragmas and no dialect: same output, one warning each", () => {
    const result = compile(WITH_PRAGMAS);
    expect(
      result.warnings.filter((w) => /pragma ignored/i.test(w.message)),
    ).toHaveLength(9);
    expect(run(WITH_PRAGMAS, {}, "pragmas_default")).toBe("20");
  });

  it("with the pragmas under --dialect iec-3: same output", () => {
    expect(run(WITH_PRAGMAS, { dialect: "iec-3" }, "pragmas_iec3")).toBe("20");
  });
});
