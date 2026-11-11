// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * E2E for conditional pragmas: one program, built with g++ and run under
 * three sets of defines, prints the result of the branch that was active.
 * The dead branches hold code that does not compile.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const CLI_PATH = path.resolve(__dirname, "../../dist/node/cli.js");

const PROGRAM = `PROGRAM Main
VAR
{IF defined(SIM)}
  base : INT := 1;
{ELSIF hasvalue(MODE, 'fast')}
  base : INT := 2;
{ELSE}
  base : INT := 3;
{END_IF}
  out : INT;
END_VAR
{IF defined(SIM) AND NOT defined(MODE)}
  out := base;
{ELSIF hasvalue(MODE, 'fast')}
  out := base * 1;
{ELSE}
  {IF defined(NEVER)}
  this is not structured text := ;
  {END_IF}
  out := base + 0;
{END_IF}
{IF defined(BROKEN)}
  out := no_such_variable;
{END_IF}
END_PROGRAM
`;

const MAIN = `
#include <iostream>
int main() {
    strucpp::Program_MAIN prog;
    prog.run();
    std::cout << static_cast<int>(prog.OUT) << std::endl;
    return 0;
}
`;

describe.skipIf(!hasGpp)("conditional pragmas end to end", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-cond-e2e-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it.each([
    [{ SIM: "" }, "1"],
    [{ MODE: "fast" }, "2"],
    [{}, "3"],
  ])("defines %j build and print %s", (defines, expected) => {
    const result = compile(PROGRAM, {
      strict: true,
      features: ["+conditional_pragmas"],
      pragmaDefines: defines,
    });
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: `cond_${expected}`,
      mainCode: MAIN,
    });
    expect(stdout).toBe(expected);
  });

  it("without the feature the program does not compile", () => {
    const result = compile(PROGRAM, { pragmaDefines: { SIM: "" } });
    expect(result.success).toBe(false);
  });

  it("the CLI with a profile file and -D builds the SIM variant", () => {
    if (!fs.existsSync(CLI_PATH)) throw new Error(`CLI not built: ${CLI_PATH}`);
    const dir = fs.mkdtempSync(path.join(tempDir, "cli-"));
    const src = path.join(dir, "main.st");
    const profile = path.join(dir, "vendor-cond.json");
    fs.writeFileSync(src, PROGRAM);
    fs.writeFileSync(
      profile,
      JSON.stringify({
        id: "vendor-cond",
        extends: "iec-3",
        features: ["conditional_pragmas"],
      }),
    );
    const out = path.join(dir, "generated.cpp");
    execFileSync(
      "node",
      [
        CLI_PATH,
        src,
        "-o",
        out,
        "--strict",
        "--dialect-file",
        profile,
        "-D",
        "SIM",
      ],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 },
    );
    const stdout = compileAndRunStandalone({
      tempDir: dir,
      pchPath,
      headerCode: fs.readFileSync(path.join(dir, "generated.hpp"), "utf-8"),
      cppCode: fs.readFileSync(out, "utf-8"),
      testName: "cond_cli",
      mainCode: MAIN,
    });
    expect(stdout).toBe("1");
  });
});
