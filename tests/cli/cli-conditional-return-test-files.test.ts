/**
 * `RETURN (cond);` in a --test file: refused without the feature
 * conditional_return, and with it a TEST ends early when cond holds (g++).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { hasGpp } from "../integration/test-helpers.js";
import { parseTestFile } from "../../src/testing/test-parser.js";

const CLI_PATH = resolve(__dirname, "../../dist/node/cli.js");
const DIR = join(tmpdir(), "strucpp-cli-conditional-return-tests");

function run(args: string[]): { status: number; out: string; err: string } {
  try {
    const stdout = execFileSync("node", [CLI_PATH, ...args], {
      encoding: "utf-8",
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, out: stdout, err: "" };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, out: e.stdout ?? "", err: e.stderr ?? "" };
  }
}

const SOURCE = `FUNCTION_BLOCK FB
VAR_OUTPUT n : INT; END_VAR
n := n + 1;
END_FUNCTION_BLOCK
`;
const TESTS = `SETUP
VAR f : FB; END_VAR
END_SETUP
TEST 'returns'
  f();
  RETURN (f.n > 0);
  ASSERT_EQ(f.n, 99);
END_TEST
TEST 'continues'
  f();
  RETURN (f.n > 5);
  ASSERT_EQ(f.n, 1);
END_TEST
`;

describe("RETURN (cond) in a test file", () => {
  it("is refused by parseTestFile without the feature", () => {
    for (const opts of [undefined, { dialect: "iec-3" }]) {
      expect(
        parseTestFile(TESTS, "t.st", opts).errors.map(
          (e) => `${e.line}:${e.column}: ${e.message}`,
        ),
      ).toEqual([
        "6:3: RETURN (condition) needs the feature conditional_return",
        "11:3: RETURN (condition) needs the feature conditional_return",
      ]);
    }
    expect(
      parseTestFile(TESTS, "t.st", { features: ["+conditional_return"] })
        .errors,
    ).toEqual([]);
  });

  describe.skipIf(!hasGpp)("--test", () => {
    beforeAll(() => {
      if (!existsSync(CLI_PATH)) throw new Error(`CLI not built: ${CLI_PATH}`);
      rmSync(DIR, { recursive: true, force: true });
      mkdirSync(DIR, { recursive: true });
      writeFileSync(join(DIR, "src.st"), SOURCE);
      writeFileSync(join(DIR, "tests.st"), TESTS);
    });

    it("ends a TEST early with the feature, and is refused without it", () => {
      const src = join(DIR, "src.st");
      const tests = join(DIR, "tests.st");
      const on = run([
        src,
        "--test",
        tests,
        "--feature",
        "+conditional_return",
      ]);
      expect(on.out).toContain("2 tests, 2 passed, 0 failed");
      expect(on.status).toBe(0);
      const off = run([src, "--test", tests, "--dialect", "iec-3"]);
      expect(off.status).not.toBe(0);
      expect(off.err + off.out).toContain(
        "RETURN (condition) needs the feature conditional_return",
      );
    });
  });
});
