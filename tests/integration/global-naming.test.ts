// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * RUNTIME_NAMESPACE_NAMES is exactly the set of runtime-callable and standard
 * function names that g++ rejects as a namespace-scope global next to the
 * runtime headers; and globals with such names build and run (g++ e2e).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import { compile } from "../../src/index.js";
import { RUNTIME_NAMESPACE_NAMES } from "../../src/backend/global-naming.js";
import { RUNTIME_CALLABLE_NAMES } from "../../src/semantic/runtime-functions.js";
import { StdFunctionRegistry } from "../../src/semantic/std-function-registry.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

// Typed truncations are resolved by pattern, not registered by name.
const TYPED_TRUNC_NAMES = [
  "SINT",
  "INT",
  "DINT",
  "LINT",
  "USINT",
  "UINT",
  "UDINT",
  "ULINT",
].flatMap((t) => [`TRUNC_${t}`, `REAL_TRUNC_${t}`, `LREAL_TRUNC_${t}`]);

const RUNTIME_INCLUDE = path.resolve(__dirname, "../../src/runtime/include");

describe.skipIf(!hasGpp)("global named like a runtime name — g++", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-gname-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("lists exactly the names g++ rejects as a global", () => {
    const candidates = [
      ...new Set([
        ...RUNTIME_CALLABLE_NAMES,
        ...new StdFunctionRegistry().getAll().map((f) => f.name.toUpperCase()),
        ...TYPED_TRUNC_NAMES,
      ]),
    ].filter((n) => /^[A-Z_][A-Z0-9_]*$/.test(n));
    // Every header the generated header includes, then one global per line.
    const header = compile("PROGRAM Main END_PROGRAM", {
      headerFileName: "generated.hpp",
    }).headerCode;
    const lines = header.split("\n").filter((l) => l.startsWith("#include"));
    lines.push("namespace strucpp {");
    const lineOf = new Map<number, string>();
    for (const name of candidates) {
      lines.push(`inline IEC_INT ${name}{};`);
      lineOf.set(lines.length, name);
    }
    lines.push("}");
    const file = path.join(tempDir, "globals.cpp");
    fs.writeFileSync(file, lines.join("\n") + "\n");
    let output = "";
    try {
      execSync(
        `g++ -std=c++14 -fsyntax-only -fmax-errors=0 -I${RUNTIME_INCLUDE} ${file}`,
        { encoding: "utf-8", stdio: "pipe" },
      );
    } catch (e) {
      output = String((e as { stderr?: unknown }).stderr ?? "");
    }
    const rejected = new Set<string>();
    for (const m of output.matchAll(/globals\.cpp:(\d+):\d+: error/g)) {
      const name = lineOf.get(Number(m[1]));
      if (name !== undefined) rejected.add(name);
    }
    expect([...rejected].sort()).toEqual([...RUNTIME_NAMESPACE_NAMES].sort());
  });

  it("builds and runs a file-level global and a local of such names", () => {
    const result = compile(
      `
      VAR_GLOBAL EQ_TIME : INT := 3; TIME_TO_US : DINT := 7; END_VAR
      FUNCTION_BLOCK FB
      VAR_EXTERNAL EQ_TIME : INT; END_VAR
      VAR_OUTPUT o : INT; END_VAR
        EQ_TIME := EQ_TIME + 10;
        o := EQ_TIME;
      END_FUNCTION_BLOCK
      FUNCTION F : INT
      VAR TIME_TO_US : INT := 2; END_VAR
        F := TIME_TO_US + EQ_TIME;
      END_FUNCTION
      PROGRAM Main
      VAR_EXTERNAL TIME_TO_US : DINT; END_VAR
      VAR r : INT; f1 : FB; r2 : INT; r3 : DINT; END_VAR
        f1();
        r := f1.o;
        r2 := F();
        r3 := TIME_TO_US + TIME_TO_US(T#1ms);
      END_PROGRAM
    `,
      { headerFileName: "generated.hpp" },
    );
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "global_named_like_runtime",
      mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN prog;
    prog.run();
    std::cout << prog.R.get() << " " << prog.R2.get() << " " << prog.R3.get() << " "
              << strucpp::EQ_TIME_.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("13 15 1007 13");
  });

  it("builds and runs a CONFIGURATION global of such a name", () => {
    const result = compile(
      `
      FUNCTION_BLOCK FBX
      VAR_EXTERNAL DIVTIME : INT; END_VAR
      VAR_OUTPUT o : INT; END_VAR
        o := DIVTIME * 100;
      END_FUNCTION_BLOCK
      PROGRAM Main
      VAR_EXTERNAL DIVTIME : INT; END_VAR
      VAR r : INT; f : FBX; END_VAR
        DIVTIME := DIVTIME + 1;
        f();
        r := f.o + DIVTIME;
      END_PROGRAM
      CONFIGURATION Cfg
      VAR_GLOBAL DIVTIME : INT := 3; END_VAR
      RESOURCE Res ON PLC
      TASK T(INTERVAL := T#10ms, PRIORITY := 1);
      PROGRAM P WITH T : Main;
      END_RESOURCE
      END_CONFIGURATION
    `,
      { headerFileName: "generated.hpp" },
    );
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "config_global_named_like_runtime",
      mainCode: `
#include <iostream>
int main() {
    strucpp::Configuration_CFG cfg;
    cfg.P.run();
    std::cout << cfg.P.R.get() << " " << strucpp::DIVTIME_.read() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("404 4");
  });
});
