// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * The runtime-callable name list covers every upper-case name the runtime
 * headers call or define with a parameter list (the standard functions are
 * covered by the registry).
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { RUNTIME_CALLABLE_NAMES } from "../../src/semantic/runtime-functions.js";
import { StdFunctionRegistry } from "../../src/semantic/std-function-registry.js";

describe("RUNTIME_CALLABLE_NAMES", () => {
  it("lists every upper-case callable of the runtime headers", () => {
    const registry = new StdFunctionRegistry();
    const dir = path.resolve(__dirname, "../../src/runtime/include");
    const missing = new Set<string>();
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".hpp")) continue;
      const text = fs.readFileSync(path.join(dir, file), "utf-8");
      for (const m of text.matchAll(/\b([A-Z][A-Z0-9_]*)\s*\(/g)) {
        const name = m[1]!;
        if (registry.isStandardFunction(name)) continue;
        if (!RUNTIME_CALLABLE_NAMES.has(name)) missing.add(name);
      }
    }
    expect([...missing]).toEqual([]);
  });
});
