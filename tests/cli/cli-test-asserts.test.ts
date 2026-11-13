/**
 * An ASSERT_* nested in IF, CASE or a loop of a TEST is checked (a failing
 * one fails the TEST), and a TEARDOWN runs in a file with no SETUP (g++).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { hasGpp } from "../integration/test-helpers.js";

const CLI_PATH = resolve(__dirname, "../../dist/node/cli.js");
let DIR = "";

function run(args: string[]): { status: number; out: string } {
  try {
    const stdout = execFileSync("node", [CLI_PATH, ...args], {
      encoding: "utf-8",
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, out: stdout };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string };
    return { status: e.status ?? -1, out: e.stdout ?? "" };
  }
}

function runErr(args: string[]): { status: number; err: string } {
  try {
    execFileSync("node", [CLI_PATH, ...args], {
      encoding: "utf-8",
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, err: "" };
  } catch (err: unknown) {
    const e = err as { status?: number; stderr?: string };
    return { status: e.status ?? -1, err: e.stderr ?? "" };
  }
}

const SOURCE = `VAR_GLOBAL g : INT; END_VAR
FUNCTION_BLOCK FB
VAR_OUTPUT n : INT; END_VAR
n := n + 1;
END_FUNCTION_BLOCK
`;

const NESTED = `TEST 'if'
  IF TRUE THEN ASSERT_EQ(1, 2); END_IF;
END_TEST
TEST 'for'
VAR i : INT; END_VAR
  FOR i := 1 TO 3 DO ASSERT_TRUE(i < 3); END_FOR;
END_TEST
TEST 'case'
VAR k : INT := 2; END_VAR
  CASE k OF 2: ASSERT_FALSE(TRUE); END_CASE;
END_TEST
TEST 'while'
VAR k : INT := 2; END_VAR
  WHILE k > 0 DO k := k - 1; ASSERT_NEQ(k, 0); END_WHILE;
END_TEST
TEST 'repeat'
VAR k : INT; END_VAR
  REPEAT k := k + 1; ASSERT_LT(k, 2); UNTIL k >= 3 END_REPEAT;
END_TEST
TEST 'passing'
VAR k : INT := 2; END_VAR
  IF k = 2 THEN ASSERT_EQ(k, 2); ELSE ASSERT_TRUE(FALSE); END_IF;
END_TEST
`;

describe.skipIf(!hasGpp)("ASSERT nested in a TEST, TEARDOWN without SETUP", () => {
  beforeAll(() => {
    if (!existsSync(CLI_PATH)) throw new Error(`CLI not built: ${CLI_PATH}`);
    DIR = mkdtempSync(join(tmpdir(), "strucpp-cli-test-asserts-"));
    writeFileSync(join(DIR, "src.st"), SOURCE);
  });
  afterAll(() => rmSync(DIR, { recursive: true, force: true }));

  it("fails a TEST whose nested assertion fails", () => {
    writeFileSync(join(DIR, "nested.st"), NESTED);
    const r = run([join(DIR, "src.st"), "--test", join(DIR, "nested.st")]);
    expect(r.out).toContain("[FAIL] if");
    expect(r.out).toContain("[FAIL] for");
    expect(r.out).toContain("[FAIL] case");
    expect(r.out).toContain("[FAIL] while");
    expect(r.out).toContain("[FAIL] repeat");
    expect(r.out).toContain("[PASS] passing");
    expect(r.out).toContain("6 tests, 1 passed, 5 failed");
    expect(r.status).not.toBe(0);
  });

  it("fails a TEST whose SETUP or TEARDOWN assertion fails, nested or not", () => {
    writeFileSync(
      join(DIR, "blocks.st"),
      `SETUP
VAR x : INT; END_VAR
  x := 1;
  IF x = 1 THEN ASSERT_EQ(x, 1); END_IF;
  ASSERT_TRUE(g < 2);
  IF x = 1 THEN RETURN; END_IF;
END_SETUP
TEARDOWN
  g := g + 1;
  IF g = 2 THEN ASSERT_EQ(g, 99); END_IF;
END_TEARDOWN
TEST 'a'
  ASSERT_EQ(x, 1);
END_TEST
TEST 'teardown fails'
  ASSERT_EQ(x, 1);
END_TEST
TEST 'setup fails'
  ASSERT_EQ(x, 1);
END_TEST
`,
    );
    const r = run([join(DIR, "src.st"), "--test", join(DIR, "blocks.st")]);
    expect(r.out).toContain("[PASS] a");
    expect(r.out).toContain("[FAIL] teardown fails");
    expect(r.out).toContain("[FAIL] setup fails");
    expect(r.out).toContain("3 tests, 1 passed, 2 failed");
  });

  it("runs TEARDOWN after each TEST with no SETUP, also after a failure or a RETURN", () => {
    writeFileSync(
      join(DIR, "teardown.st"),
      `TEARDOWN
  g := g + 100;
END_TEARDOWN
TEST 'first'
  g := 0;
END_TEST
TEST 'fails'
  ASSERT_EQ(g, 0);
END_TEST
TEST 'returns'
  IF g = 200 THEN RETURN; END_IF;
  ASSERT_TRUE(FALSE);
END_TEST
TEST 'check'
  ASSERT_EQ(g, 300);
END_TEST
`,
    );
    const r = run([join(DIR, "src.st"), "--test", join(DIR, "teardown.st")]);
    expect(r.out).toContain("[PASS] first");
    expect(r.out).toContain("[FAIL] fails");
    expect(r.out).toContain("[PASS] returns");
    expect(r.out).toContain("[PASS] check");
  });

  it("reports a bad nested assertion as a diagnostic in the test file", () => {
    writeFileSync(
      join(DIR, "badnested.st"),
      `TEST 'bad'
  IF TRUE THEN ASSERT_EQ(1); END_IF;
  CASE g OF 0: ASSERT_TRUE(zz); END_CASE;
END_TEST
`,
    );
    const r = runErr([join(DIR, "src.st"), "--test", join(DIR, "badnested.st"), "-o", join(DIR, "out-badnested")]);
    expect(r.status).toBe(1);
    expect(r.err).toContain("badnested.st:2:16: error: ASSERT_EQ expects 2 arguments, got 1");
    expect(r.err).toContain("badnested.st:3:28: error: Undeclared variable 'ZZ'");
    expect(r.err).not.toContain("<input>");
    expect(r.err).not.toMatch(/^\s+at /m);
  });
});
