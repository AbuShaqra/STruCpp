// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * `--check` runs analyze(); a build runs compile(). On the sample programs
 * both must agree: analyze() reports no errors exactly when compile()
 * succeeds. A case that once passed the check but not the build is run
 * through g++ below.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, relative } from "path";
import { analyze, compile } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const ROOT = resolve(__dirname, "../..");
const LIBS = discoverStlibs(join(ROOT, "libs"));

/** Program sources (not test files) under `dir`, recursively. */
function samples(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...samples(p));
    else if (name.endsWith(".st") && !name.startsWith("test_")) out.push(p);
  }
  return out.sort();
}

const FILES = [
  ...samples(join(ROOT, "examples")),
  ...samples(join(ROOT, "tests/st-validation")),
];

describe("analyze() agrees with compile() on the samples", () => {
  it("finds samples", () => {
    expect(FILES.length).toBeGreaterThan(10);
  });

  it.each(FILES.map((f) => [relative(ROOT, f), f]))("%s", (_name, file) => {
    const source = readFileSync(file, "utf-8");
    const opts = { fileName: file, libraries: LIBS };
    const analyzed = analyze(source, opts);
    const compiled = compile(source, opts);
    expect(analyzed.errors).toEqual([]);
    expect(compiled.success).toBe(true);
  });
});

describeIfGpp(
  "interface-typed VAR_INPUT: the check and the build agree",
  () => {
    // Was a recorded gap: the field had the abstract interface type and g++
    // rejected it. It is now a nullable reference to the instance and builds.
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = mkdtempSync(join(tmpdir(), "strucpp-checkvscompile-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("builds and runs", () => {
      const source = `
INTERFACE ICounter
  METHOD Value : INT
  END_METHOD
END_INTERFACE

FUNCTION_BLOCK FB_Counter IMPLEMENTS ICounter
  VAR n : INT; END_VAR
  METHOD Value : INT
    Value := n;
  END_METHOD
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_User
  VAR_INPUT
    c : ICounter;
  END_VAR
  VAR v : INT; END_VAR
  v := c.Value();
END_FUNCTION_BLOCK

PROGRAM Main
  VAR
    cnt : FB_Counter;
    u : FB_User;
  END_VAR
  u(c := cnt);
END_PROGRAM
`;
      expect(analyze(source).errors).toEqual([]);
      const compiled = compile(source, { headerFileName: "generated.hpp" });
      expect(compiled.success).toBe(true);
      const out = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: compiled.headerCode,
        cppCode: compiled.cppCode,
        testName: "itf_input",
        mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p;\n p.CNT.N = 7;\n p.run();\n std::cout << p.U.V.get() << std::endl;\n return 0;\n}\n`,
      });
      expect(out).toBe("7");
    });
  },
);
