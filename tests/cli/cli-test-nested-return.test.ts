/**
 * A RETURN nested in a TEST body (in an IF or a loop) ends the TEST, which
 * passes, as a top-level RETURN does, with and without SETUP/TEARDOWN (g++).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { hasGpp } from "../integration/test-helpers.js";

const CLI_PATH = resolve(__dirname, "../../dist/node/cli.js");
const DIR = join(tmpdir(), "strucpp-cli-test-nested-return");

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
const BODIES = `TEST 'if'
  f();
  IF f.n > 0 THEN RETURN; END_IF;
  ASSERT_EQ(f.n, 99);
END_TEST
TEST 'loop'
  WHILE TRUE DO
    f();
    IF f.n > 2 THEN RETURN; END_IF;
  END_WHILE;
  ASSERT_EQ(f.n, 99);
END_TEST
TEST 'not taken'
  f();
  IF f.n > 5 THEN RETURN; END_IF;
  ASSERT_EQ(f.n, 1);
END_TEST
`;

describe.skipIf(!hasGpp)("RETURN nested in a TEST body", () => {
  beforeAll(() => {
    if (!existsSync(CLI_PATH)) throw new Error(`CLI not built: ${CLI_PATH}`);
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    writeFileSync(join(DIR, "src.st"), SOURCE);
    writeFileSync(
      join(DIR, "setup.st"),
      `SETUP\nVAR f : FB; END_VAR\nEND_SETUP\nTEARDOWN\nEND_TEARDOWN\n${BODIES}`,
    );
    writeFileSync(
      join(DIR, "plain.st"),
      BODIES.replace(/TEST '([^']+)'\n/g, "TEST '$1'\nVAR f : FB; END_VAR\n"),
    );
  });

  it("ends the TEST, with SETUP and TEARDOWN", () => {
    const r = run([join(DIR, "src.st"), "--test", join(DIR, "setup.st")]);
    expect(r.out).toContain("3 tests, 3 passed, 0 failed");
    expect(r.status).toBe(0);
  });

  it("ends SETUP and TEARDOWN at a RETURN, and RETURN (cond) nested in a TEST", () => {
    writeFileSync(
      join(DIR, "blocks.st"),
      `SETUP
VAR f : FB; k : INT; END_VAR
  k := 1;
  RETURN (k > 0);
  k := 99;
END_SETUP
TEARDOWN
  RETURN;
END_TEARDOWN
TEST 'r'
  ASSERT_EQ(k, 1);
  IF k = 1 THEN RETURN (TRUE); END_IF;
  ASSERT_EQ(k, 99);
END_TEST
`,
    );
    const r = run([
      join(DIR, "src.st"),
      "--test",
      join(DIR, "blocks.st"),
      "--feature",
      "+conditional_return",
    ]);
    expect(r.out).toContain("1 test, 1 passed, 0 failed");
    expect(r.status).toBe(0);
  });

  it("ends the TEST, without SETUP", () => {
    const r = run([join(DIR, "src.st"), "--test", join(DIR, "plain.st")]);
    expect(r.out).toContain("3 tests, 3 passed, 0 failed");
    expect(r.status).toBe(0);
  });
});
