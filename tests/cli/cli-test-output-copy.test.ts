// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * An output bound in a TEST block follows the assignment rules and is copied
 * out through a temporary where its C++ type differs, as in a POU body; a
 * FUNCTION with a VAR_OUTPUT runs through the test build's dispatch.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { hasGpp } from "../integration/test-helpers.js";

const CLI_PATH = resolve(__dirname, "../../dist/node/cli.js");
let dir = "";

/** Run the CLI; returns exit status and both streams. */
function run(args: string[]): { status: number; out: string } {
  try {
    const stdout = execFileSync("node", [CLI_PATH, ...args], {
      encoding: "utf-8",
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, out: stdout };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: e.status ?? -1,
      out: `${e.stdout ?? ""}${e.stderr ?? ""}`,
    };
  }
}

const SOURCE = `FUNCTION FOut : BOOL
VAR_INPUT a : INT; END_VAR
VAR_OUTPUT o : USINT; END_VAR
o := 200; FOut := TRUE;
END_FUNCTION
PROGRAM Main VAR x : UINT; ok : BOOL; END_VAR ok := FOut(a := 1, o => x); END_PROGRAM
`;

const TESTS = `TEST 'copy out'
VAR ok : BOOL; z : UINT; y : UDINT; mu : MyU; END_VAR
ok := FOut(a := 1, o => z);
ok := SPLIT_DATE(IN := D#2024-03-05, YEAR => y);
ok := FOut(1, mu);
ASSERT_EQ(z, 200);
ASSERT_EQ(y, 2024);
ASSERT_EQ(UINT_TO_INT(mu), 200);
END_TEST
`;

beforeAll(() => {
  if (!existsSync(CLI_PATH)) {
    throw new Error(`CLI not built: ${CLI_PATH} not found.`);
  }
  dir = mkdtempSync(join(tmpdir(), "strucpp-cli-test-output-copy-"));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!hasGpp)("output bindings in TEST blocks", () => {
  for (const flags of [[], ["--dialect", "iec-3"], ["--strict"]]) {
    it(`copies an output of another type out (${flags.join(" ") || "no dialect"})`, () => {
      const src = join(dir, "src.st");
      const test = join(dir, "test_src.st");
      writeFileSync(src, `TYPE MyU : UINT; END_TYPE\n${SOURCE}`);
      writeFileSync(test, TESTS);
      const r = run([src, "--test", test, ...flags]);
      expect(r.out).toContain("1 test, 1 passed, 0 failed");
      expect(r.status).toBe(0);
    });
  }

  it("refuses an output its variable cannot be assigned", () => {
    const src = join(dir, "bad.st");
    const test = join(dir, "test_bad.st");
    writeFileSync(src, SOURCE);
    writeFileSync(
      test,
      `TEST 'refused'
VAR ok : BOOL; t : TIME; END_VAR
ok := FOut(a := 1, o => t);
END_TEST
`,
    );
    const r = run([src, "--test", test]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("Cannot assign USINT to TIME");
  });
});
