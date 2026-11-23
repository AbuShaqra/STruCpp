// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * The test runtime header ships with the other runtime headers: the npm
 * package and every release archive carry it in `runtime/include`, so a test
 * build needs no include directory beyond that one.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { hasGpp, CXX_STD, cxxEnv } from "./test-helpers.js";

const ROOT = path.resolve(__dirname, "../..");

/** Paths `npm pack` would put in the package, without running its scripts. */
function packedFiles(): string[] {
  const out = execFileSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
  );
  const report = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
  return report[0]!.files.map((f) => f.path);
}

describe("runtime headers in the shipped layout", () => {
  let files: string[];
  let tempDir: string;
  beforeAll(() => {
    files = packedFiles();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-layout-"));
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("packs iec_test.hpp beside the other runtime headers", () => {
    expect(files).toContain("src/runtime/include/iec_test.hpp");
    expect(files).toContain("src/runtime/include/iec_types.hpp");
    expect(files.filter((f) => f.startsWith("src/runtime/test/"))).toEqual([]);
  });

  it("copies runtime/include into every release archive", () => {
    const workflow = fs.readFileSync(
      path.join(ROOT, ".github/workflows/release.yml"),
      "utf-8",
    );
    const archives = workflow.match(/staging\/strucpp\/runtime\/include /g);
    const copies = workflow.match(
      /cp src\/runtime\/include\/\*\.hpp staging\/strucpp\/runtime\/include\//g,
    );
    expect(archives?.length ?? 0).toBeGreaterThan(0);
    expect(copies?.length).toBe(archives?.length);
    expect(workflow).not.toContain("runtime/test");
  });

  it.skipIf(!hasGpp)(
    "builds the test runtime from the packed include directory alone",
    () => {
      const include = path.join(tempDir, "include");
      fs.mkdirSync(include);
      for (const f of files.filter((p) =>
        p.startsWith("src/runtime/include/"),
      )) {
        fs.copyFileSync(
          path.join(ROOT, f),
          path.join(include, path.basename(f)),
        );
      }
      const main = path.join(tempDir, "main.cpp");
      fs.writeFileSync(
        main,
        '#include "iec_test.hpp"\nint main() { return 0; }\n',
      );
      execFileSync(
        "g++",
        [`-std=${CXX_STD}`, "-fsyntax-only", `-I${include}`, main],
        { stdio: ["ignore", "pipe", "pipe"], env: cxxEnv },
      );
    },
  );
});
