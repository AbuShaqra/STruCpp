// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: a program compiles and runs under a profile selected from a dialect
 * folder that also holds a broken profile, which is only warned about, in
 * every mode.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const FILES: Record<string, string> = {
  "dir/vendor-a.json": JSON.stringify({
    id: "vendor-a",
    extends: "iec-3",
    features: ["pointer_to"],
  }),
  "dir/broken.json": "{oops",
};
const dialectIO = {
  readFile: (p: string): string => {
    const t = FILES[p];
    if (t === undefined) throw new Error(`ENOENT: ${p}`);
    return t;
  },
  listDir: (): string[] => ["broken.json", "vendor-a.json"],
};

const SOURCE = `PROGRAM Main
VAR x : INT := 20; p : POINTER TO INT; r : INT; END_VAR
p := ADR(x);
r := p^ + 1;
END_PROGRAM
`;

describe.skipIf(!hasGpp)("profile handling — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-profiles-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const [label, options] of [
    ["no dialect flag", {}],
    ["with --feature overrides", { features: ["-pointer_to", "+pointer_to"] }],
    ["strict", { strict: true }],
  ] as const) {
    it(`builds under the selected profile and warns about the broken one (${label})`, () => {
      const result = compile(SOURCE, {
        ...options,
        dialect: "vendor-a",
        dialectPath: ["dir"],
        dialectIO,
        headerFileName: "generated.hpp",
      });
      expect(result.errors).toEqual([]);
      expect(
        result.warnings.filter((w) => w.message.includes("dir/broken.json")),
      ).toHaveLength(1);
      const stdout = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: `profiles_${label.replace(/\W/g, "_")}`,
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.R.get() << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe("21");
    });
  }
});
