/**
 * LOWER_BOUND / UPPER_BOUND in a --test file: a malformed call is refused
 * with a diagnostic and a nonzero exit, as in a source body, never run as a
 * bound of 0; a correct call passes (g++).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { writeFileSync, existsSync, rmSync, mkdtempSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { hasGpp } from "../integration/test-helpers.js";

const CLI_PATH = resolve(__dirname, "../../dist/node/cli.js");
const DIR = mkdtempSync(join(tmpdir(), "strucpp-cli-bound-tests-"));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

const VARS =
  "VAR a : ARRAY[2..7] OF INT; m : ARRAY[1..2, 3..9] OF INT; e : E_DIM; h : DINT; END_VAR";

let counter = 0;
/** `strucpp src.st --test <file>` of a TEST holding `body`. */
function runTest(body: string): { status: number; output: string } {
  const file = join(DIR, `t${counter++}.st`);
  writeFileSync(file, `TEST 'bounds'\n  ${VARS}\n${body}\nEND_TEST\n`);
  try {
    const out = execFileSync(
      "node",
      [CLI_PATH, join(DIR, "src.st"), "--test", file],
      { encoding: "utf-8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"] },
    );
    return { status: 0, output: out };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: e.status ?? -1,
      output: `${e.stdout ?? ""}${e.stderr ?? ""}`,
    };
  }
}

/** The error lines of `output`, without the file name. */
function errors(output: string): string[] {
  return output
    .split("\n")
    .filter((l) => / error: /.test(l))
    .map((l) => l.replace(/^.*?:(\d+:\d+): /, "$1: "));
}

beforeAll(() => {
  if (!existsSync(CLI_PATH)) throw new Error(`CLI not built: ${CLI_PATH}`);
  writeFileSync(
    join(DIR, "src.st"),
    "TYPE E_DIM : (ONE := 1, TWO := 2); END_TYPE\nPROGRAM Main\nVAR x : INT; END_VAR\nx := x + 1;\nEND_PROGRAM\n",
  );
});

describe("LOWER_BOUND / UPPER_BOUND in a --test file", () => {
  it("refuses a call short of its dimension", () => {
    const r = runTest("  h := UPPER_BOUND(a);\n  ASSERT_EQ(h, 7);");
    expect(errors(r.output)).toEqual([
      "3:8: error: 'UPPER_BOUND' requires 2 argument(s), got 1",
    ]);
    expect(r.status).not.toBe(0);
  });

  it("refuses an empty call and three arguments", () => {
    const r = runTest("  h := LOWER_BOUND();\n  h := UPPER_BOUND(a, 1, 1);");
    expect(errors(r.output)).toEqual([
      "3:8: error: 'LOWER_BOUND' requires 2 argument(s), got 0",
      "4:8: error: 'UPPER_BOUND' requires 2 argument(s), got 3",
    ]);
    expect(r.status).not.toBe(0);
  });

  it("refuses a call in an initial value of a TEST's VAR", () => {
    const r = runTest(
      "  VAR k : DINT := UPPER_BOUND(a); END_VAR\n  ASSERT_EQ(k, 7);",
    );
    expect(errors(r.output)).toEqual([
      "3:19: error: 'UPPER_BOUND' requires 2 argument(s), got 1",
    ]);
    expect(r.status).not.toBe(0);
  });

  it("refuses a call naming no DIM (reported by code generation)", () => {
    const r = runTest("  h := UPPER_BOUND(ARR := a, X := 1);");
    expect(errors(r.output)).toEqual([
      "3:8: error: UPPER_BOUND takes two arguments, the array and the dimension (ARR, DIM)",
    ]);
    expect(r.status).not.toBe(0);
  });

  it("refuses no array, a dimension it does not have and no integer", () => {
    const r = runTest(
      [
        "  h := UPPER_BOUND(5, 1);",
        "  h := UPPER_BOUND(m, 3);",
        "  h := UPPER_BOUND(a, 1.5);",
        "  h := UPPER_BOUND(a, e);",
        "  h := LOWER_BOUND(a, E_DIM#ONE);",
      ].join("\n"),
    );
    expect(errors(r.output)).toEqual([
      "3:20: error: ARR of UPPER_BOUND must be an array, got a literal",
      "4:23: error: UPPER_BOUND has no dimension 3: the array has 2",
      "5:23: error: Argument 'DIM' of 'UPPER_BOUND' expects ANY_INT, got REAL",
      "6:23: error: Argument 'DIM' of 'UPPER_BOUND' expects ANY_INT, got E_DIM",
      "7:23: error: Argument 'DIM' of 'LOWER_BOUND' expects ANY_INT, got E_DIM",
    ]);
    expect(r.status).not.toBe(0);
  });

  it.skipIf(!hasGpp)("runs a correct call, positional or named", () => {
    const r = runTest(
      [
        "  h := UPPER_BOUND(a, 1);",
        "  ASSERT_EQ(h, 7);",
        "  h := LOWER_BOUND(DIM := 1, ARR := a);",
        "  ASSERT_EQ(h, 2);",
        "  h := UPPER_BOUND(ARR := m, DIM := 2);",
        "  ASSERT_EQ(h, 9);",
      ].join("\n"),
    );
    expect(r.output).toContain("1 test, 1 passed, 0 failed");
    expect(r.status).toBe(0);
  });
});
