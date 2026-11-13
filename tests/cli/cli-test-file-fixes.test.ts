/**
 * Test files: SETUP variables start from their initial values, a TEST name may
 * be in double quotes, the run's features reach the test file (XSIZEOF), and
 * two STRUCTs compare memberwise in `=`, `<>`, ASSERT_EQ and ASSERT_NEQ (g++).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { hasGpp } from "../integration/test-helpers.js";

const CLI_PATH = resolve(__dirname, "../../dist/node/cli.js");
let DIR = "";

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

const SOURCE = `TYPE ST : STRUCT a : BOOL; b : BOOL := FALSE; n : INT; END_STRUCT END_TYPE
FUNCTION_BLOCK Counter VAR_OUTPUT count : INT; END_VAR count := count + 1; END_FUNCTION_BLOCK
`;

describe.skipIf(!hasGpp)("test file fixes", () => {
  beforeAll(() => {
    if (!existsSync(CLI_PATH)) throw new Error(`CLI not built: ${CLI_PATH}`);
    DIR = mkdtempSync(join(tmpdir(), "strucpp-cli-test-file-fixes-"));
    writeFileSync(join(DIR, "src.st"), SOURCE);
  });
  afterAll(() => rmSync(DIR, { recursive: true, force: true }));

  it("starts SETUP variables from their initial values", () => {
    writeFileSync(
      join(DIR, "setup.st"),
      `SETUP
VAR p : STRING := 'abc'; k : INT := 7; s : ST := (a := TRUE, n := 5); arr : ARRAY[0..1] OF INT := [3, 4]; END_VAR
  k := k + 1;
END_SETUP
TEST 'k' ASSERT_EQ(k, 8); END_TEST
TEST 'p' ASSERT_EQ(p, 'abc'); END_TEST
TEST 's' ASSERT_TRUE(s.a); ASSERT_FALSE(s.b); ASSERT_EQ(s.n, 5); ASSERT_EQ(arr[1], 4); END_TEST
`,
    );
    const r = run([join(DIR, "src.st"), "--test", join(DIR, "setup.st")]);
    expect(r.out).toContain("3 tests, 3 passed, 0 failed");
  });

  it("takes a TEST name in double or single quotes", () => {
    writeFileSync(
      join(DIR, "names.st"),
      `TEST "increments on each call"
VAR c : Counter; END_VAR
  c();
  ASSERT_EQ(c.count, 1);
END_TEST
TEST 'single'
  ASSERT_TRUE(TRUE);
END_TEST
`,
    );
    const r = run([join(DIR, "src.st"), "--test", join(DIR, "names.st")]);
    expect(r.out).toContain("[PASS] increments on each call");
    expect(r.out).toContain("2 tests, 2 passed, 0 failed");
  });

  it("applies the run's features in the test file", () => {
    writeFileSync(
      join(DIR, "xsizeof.st"),
      `TEST 'x'
VAR s : ST; n : ULINT; m : UDINT; END_VAR
  n := XSIZEOF(s); m := SIZEOF(s);
  ASSERT_EQ(n, UDINT_TO_ULINT(m));
END_TEST
`,
    );
    const on = run([
      join(DIR, "src.st"),
      "--test",
      join(DIR, "xsizeof.st"),
      "--feature",
      "+vendor_operators",
    ]);
    expect(on.out).toContain("1 test, 1 passed, 0 failed");
    const off = run([join(DIR, "src.st"), "--test", join(DIR, "xsizeof.st")]);
    expect(off.err).toContain("XSIZEOF needs the feature vendor_operators");
  });

  it("compares two STRUCTs memberwise", () => {
    writeFileSync(
      join(DIR, "structs.st"),
      `SETUP
VAR sq : ST; END_VAR
END_SETUP
TEST 'equal'
VAR q : ST; r : ST; e : BOOL; END_VAR
  e := q = r;
  ASSERT_TRUE(e);
  ASSERT_EQ(q, r);
  ASSERT_EQ(sq, r);
  r.n := 1;
  ASSERT_FALSE(q = r);
  ASSERT_TRUE(q <> r);
  ASSERT_NEQ(q, r);
END_TEST
TEST 'differ'
VAR q : ST; r : ST; END_VAR
  r.a := TRUE;
  ASSERT_EQ(q, r);
END_TEST
`,
    );
    const r = run([join(DIR, "src.st"), "--test", join(DIR, "structs.st")]);
    expect(r.out).toContain("[PASS] equal");
    expect(r.out).toContain("[FAIL] differ");
  });
});
