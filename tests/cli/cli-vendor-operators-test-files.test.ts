/**
 * __POSITION, __POUNAME and BITADR in a --test file: __POSITION follows the
 * dialect flags of the run, the other two have no value in a test file (g++).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { hasGpp } from "../integration/test-helpers.js";
import { parseTestFile } from "../../src/testing/test-parser.js";

const CLI_PATH = resolve(__dirname, "../../dist/node/cli.js");
const DIR = join(tmpdir(), "strucpp-cli-vendor-operators-tests");

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

const TESTS = `TEST 'position'
VAR s : STRING; d : STRING := __POSITION(); END_VAR
  s := __POSITION();
  ASSERT_EQ(s, 'Line 3, Column 8 (Impl)');
  ASSERT_EQ(d, 'Line 2 (Decl)');
END_TEST
`;

describe("vendor operators in a test file", () => {
  it("refuses __POUNAME and BITADR there", () => {
    const r = parseTestFile(
      `TEST 't'
VAR s : STRING; d : DWORD; x : BOOL; END_VAR
  s := __POUNAME();
  d := BITADR(x);
END_TEST
`,
      "t.st",
      { features: ["+vendor_operators"] },
    );
    expect(r.errors.map((e) => `${e.line}:${e.column}: ${e.message}`)).toEqual([
      "3:8: __POUNAME is not supported in a test file",
      "4:8: BITADR is not supported in a test file",
    ]);
  });

  describe.skipIf(!hasGpp)("--test", () => {
    beforeAll(() => {
      if (!existsSync(CLI_PATH)) throw new Error(`CLI not built: ${CLI_PATH}`);
      rmSync(DIR, { recursive: true, force: true });
      mkdirSync(DIR, { recursive: true });
      writeFileSync(
        join(DIR, "src.st"),
        "PROGRAM P\nVAR x : INT; END_VAR\nx := 1;\nEND_PROGRAM\n",
      );
      writeFileSync(join(DIR, "tests.st"), TESTS);
    });

    it("lowers __POSITION with the feature and refuses it without", () => {
      const src = join(DIR, "src.st");
      const tests = join(DIR, "tests.st");
      const on = run([src, "--test", tests, "--feature", "+vendor_operators"]);
      expect(on.out).toContain("1 test, 1 passed, 0 failed");
      const off = run([src, "--test", tests]);
      expect(off.status).not.toBe(0);
      expect(off.err + off.out).toContain(
        "__POSITION needs the feature vendor_operators",
      );
    });
  });
});
