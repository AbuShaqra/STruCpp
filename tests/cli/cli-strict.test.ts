/**
 * --strict reaches every CLI mode that compiles ST: the test runner
 * (--test) and library compilation (--compile-lib), not only plain builds.
 * Each case also pins the non-strict result.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync, mkdtempSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { compileStlib } from "../../src/library/library-compiler.js";
import { hasGpp } from "../integration/test-helpers.js";

const CLI_PATH = resolve(__dirname, "../../dist/node/cli.js");
// Per-run folder, so concurrent runs do not share files.
const TMP_BASE = mkdtempSync(join(tmpdir(), "strucpp-cli-strict-tests-"));

/** Run the CLI; returns exit status and both streams. */
function run(args: string[]): { status: number; out: string } {
  try {
    const stdout = execFileSync("node", [CLI_PATH, ...args], {
      encoding: "utf-8",
      timeout: 60000,
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

function freshDir(name: string): string {
  const dir = join(TMP_BASE, name);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

const NARROWING = `FUNCTION Narrow : INT
  VAR_INPUT d : DINT; END_VAR
  Narrow := d;
END_FUNCTION
`;
const MSG =
  "Implicit conversion from DINT to INT is not allowed; use DINT_TO_INT";

beforeAll(() => {
  if (!existsSync(CLI_PATH)) {
    throw new Error(`CLI not built: ${CLI_PATH} not found.`);
  }
  mkdirSync(TMP_BASE, { recursive: true });
});

describe("--strict with --compile-lib", () => {
  it("rejects a narrowing library function; non-strict builds it", () => {
    const dir = freshDir("compile-lib");
    const st = join(dir, "lib.st");
    writeFileSync(st, NARROWING);
    const strict = run([
      "--compile-lib",
      st,
      "-o",
      join(dir, "strict"),
      "--lib-name",
      "narrow",
      "--strict",
    ]);
    expect(strict.status).toBe(1);
    expect(strict.out).toContain(MSG);
    const lax = run([
      "--compile-lib",
      st,
      "-o",
      join(dir, "lax"),
      "--lib-name",
      "narrow",
    ]);
    expect(lax.status).toBe(0);
    expect(existsSync(join(dir, "lax", "narrow.stlib"))).toBe(true);
  });

  it("compileStlib forwards strict to the compiler", () => {
    const sources = [{ source: NARROWING, fileName: "lib.st" }];
    const opts = { name: "narrow", version: "1.0.0", namespace: "narrow" };
    const strict = compileStlib(sources, { ...opts, strict: true });
    expect(strict.success).toBe(false);
    expect(strict.errors.map((e) => e.message)).toEqual([MSG]);
    const lax = compileStlib(sources, opts);
    expect(lax.success).toBe(true);
  });
});

describe.skipIf(!hasGpp)("--strict with --test", () => {
  it("rejects the source under test; non-strict runs the tests", () => {
    const dir = freshDir("test-mode");
    const src = join(dir, "src.st");
    const test = join(dir, "test_src.st");
    writeFileSync(
      src,
      `PROGRAM Prog
  VAR d : DINT := 7; n : INT; END_VAR
  n := d;
END_PROGRAM
`,
    );
    writeFileSync(
      test,
      `TEST 'copies d'
  VAR uut : Prog; END_VAR
  uut();
  ASSERT_EQ(uut.n, 7);
END_TEST
`,
    );
    const strict = run([src, "--test", test, "--strict"]);
    expect(strict.status).toBe(1);
    expect(strict.out).toContain(
      "src.st:3:8: error: Implicit conversion from DINT to INT is not allowed; use DINT_TO_INT",
    );
    const lax = run([src, "--test", test]);
    expect(lax.out).toContain("1 test, 1 passed, 0 failed");
    expect(lax.status).toBe(0);
  });
});

afterAll(() => rmSync(TMP_BASE, { recursive: true, force: true }));
