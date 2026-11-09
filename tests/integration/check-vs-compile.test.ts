// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * `--check` runs analyze(); a build runs compile(). On the sample programs
 * both must agree: analyze() reports no errors exactly when compile()
 * succeeds. Known cases where the check passes but the build does not are
 * recorded below.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, resolve, relative } from "path";
import { analyze, compile } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";

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

describe("recorded: the check passes, the build does not", () => {
  // An interface-typed VAR_INPUT passes analyze() and compile(), but the
  // generated C++ declares a field of abstract type and g++ rejects it.
  // Listed as a known gap; this test pins today's behaviour.
  it("interface-typed VAR_INPUT", () => {
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
    const compiled = compile(source);
    expect(compiled.success).toBe(true);
    expect(compiled.headerCode).toMatch(/ICOUNTER\s+C\b/);
  });
});
