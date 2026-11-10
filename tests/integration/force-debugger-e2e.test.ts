// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: a source-level debugger stopped in a PROGRAM forces and unforces a
 * variable with the expressions the VS Code extension evaluates
 * (vscode-extension/client/src/debug-utils.ts: forceExpressions /
 * unforceExpression), through the runtime's strucpp_force_capture and
 * strucpp_unforce entry points.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import { compile } from "../../src/index.js";
import { hasGpp, CXX_STD, RUNTIME_INCLUDE_PATH } from "./test-helpers.js";

const hasGdb = (() => {
  try {
    execSync("gdb --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasGpp || !hasGdb)("forcing from a stopped debugger", () => {
  let tempDir: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-force-gdb-"));
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("forces at one breakpoint, holds across the cycle, and unforces at the next", () => {
    const result = compile(
      `PROGRAM Main
         VAR x : INT; seen : INT; END_VAR
         seen := x;
         x := x + 1;
       END_PROGRAM`,
      { headerFileName: "generated.hpp" },
    );
    expect(result.errors).toEqual([]);
    fs.writeFileSync(path.join(tempDir, "generated.hpp"), result.headerCode);
    fs.writeFileSync(path.join(tempDir, "generated.cpp"), result.cppCode);
    fs.writeFileSync(
      path.join(tempDir, "main.cpp"),
      `#include "generated.hpp"
#include <cstdio>
int main() {
  strucpp::Program_MAIN prog;
  for (int i = 0; i < 3; ++i) {
    prog.run();
    std::printf("%d %d\\n", (int)prog.SEEN, (int)prog.X);
    std::fflush(stdout);
  }
  return 0;
}
`,
    );
    const bin = path.join(tempDir, "prog");
    execSync(
      `g++ -std=${CXX_STD} -g -O0 -I"${RUNTIME_INCLUDE_PATH}" -I"${tempDir}" ` +
        `"${path.join(tempDir, "main.cpp")}" "${path.join(tempDir, "generated.cpp")}" -o "${bin}"`,
      { encoding: "utf-8" },
    );
    const script = path.join(tempDir, "cmds.gdb");
    fs.writeFileSync(
      script,
      [
        "set pagination off",
        "set confirm off",
        "break strucpp::Program_MAIN::run",
        "run",
        // forceExpressions("this->X", "100")
        "print this->X.value_ = 100",
        'printf "capture=%d\\n", strucpp_force_capture((void*)&(this->X), sizeof(this->X.value_))',
        "continue",
        // unforceExpression("this->X")
        'printf "unforce=%d\\n", strucpp_unforce((void*)&(this->X))',
        "delete",
        "continue",
        "",
      ].join("\n"),
    );
    const out = execSync(`gdb -batch -x "${script}" "${bin}" 2>&1`, {
      encoding: "utf-8",
      timeout: 60000,
    });
    const lines = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^(capture|unforce)=|^\d+ \d+$/.test(l));
    // Cycle 1 is forced throughout; cycle 2 starts forced and is unforced at
    // its breakpoint; cycle 3 runs free.
    expect(lines).toEqual([
      "capture=0",
      "100 100",
      "unforce=0",
      "100 101",
      "101 102",
    ]);
  });
});
