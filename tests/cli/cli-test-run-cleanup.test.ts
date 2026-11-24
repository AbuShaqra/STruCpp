/**
 * `strucpp --test` removes its build directory whether the tests pass, fail
 * or do not build, and `--test` and `--compile-lib` print the source warnings
 * a plain compile prints (g++ for the test runs).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { hasGpp } from "../integration/test-helpers.js";

const CLI_PATH = resolve(__dirname, "../../dist/node/cli.js");
let dir: string;
/** The TMPDIR the CLI runs with: only its own directories land there. */
let cliTmp: string;

function run(args: string[]): { status: number; out: string; err: string } {
  const r = spawnSync("node", [CLI_PATH, ...args], {
    encoding: "utf-8",
    timeout: 120000,
    env: { ...process.env, TMPDIR: cliTmp, TMP: cliTmp, TEMP: cliTmp },
  });
  return { status: r.status ?? -1, out: r.stdout, err: r.stderr };
}

const SOURCE = `FUNCTION_BLOCK FbX
VAR_INPUT a : INT; END_VAR
METHOD FB_exit : BOOL
VAR_INPUT bInCopyCode : BOOL; END_VAR
FB_exit := TRUE;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION Twice : INT
VAR_INPUT x : INT; END_VAR
Twice := x * 2;
END_FUNCTION
`;
const FB_EXIT_WARNING = "is never called: an instance is not torn down";

beforeAll(() => {
  if (!existsSync(CLI_PATH)) throw new Error(`CLI not built: ${CLI_PATH}`);
  dir = mkdtempSync(join(tmpdir(), "strucpp-cli-test-cleanup-"));
  cliTmp = join(dir, "tmp");
  mkdirSync(cliTmp);
  writeFileSync(join(dir, "src.st"), SOURCE);
  writeFileSync(
    join(dir, "pass.st"),
    "TEST 'p'\n  ASSERT_EQ(Twice(2), 4);\nEND_TEST\n",
  );
  writeFileSync(
    join(dir, "fail.st"),
    "TEST 'f'\n  ASSERT_EQ(Twice(2), 5);\nEND_TEST\n",
  );
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!hasGpp)("--test removes its build directory", () => {
  it.each([
    ["passing", "pass.st", 0],
    ["failing", "fail.st", 1],
  ])("after a %s run", (_label, file, status) => {
    const r = run([join(dir, "src.st"), "--test", join(dir, file)]);
    expect(r.status).toBe(status);
    expect(readdirSync(cliTmp)).toEqual([]);
  });

  it("after g++ refuses the runner", () => {
    const r = run([
      join(dir, "src.st"),
      "--test",
      join(dir, "pass.st"),
      "--cxx-flags",
      "-include no_such_header_for_this_test.h",
    ]);
    expect(r.status).toBe(1);
    expect(r.err).toContain("C++ compilation failed");
    expect(readdirSync(cliTmp)).toEqual([]);
  });

  it("prints the source warnings", () => {
    const r = run([join(dir, "src.st"), "--test", join(dir, "pass.st")]);
    expect(r.status).toBe(0);
    expect(r.err).toContain(FB_EXIT_WARNING);
  });
});

describe("--compile-lib prints the source warnings", () => {
  it("on success", () => {
    const out = join(dir, "lib");
    const r = run([
      "--compile-lib",
      join(dir, "src.st"),
      "--lib-name",
      "fxl",
      "-o",
      out,
    ]);
    expect(r.status).toBe(0);
    expect(r.err).toContain(FB_EXIT_WARNING);
  });
});
