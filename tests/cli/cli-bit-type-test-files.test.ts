/**
 * A STRUCT with BIT members (feature bit_type) used from a --test file (g++).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { hasGpp } from "../integration/test-helpers.js";

const CLI_PATH = resolve(__dirname, "../../dist/node/cli.js");
const DIR = join(tmpdir(), "strucpp-cli-bit-type-tests");

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

describe.skipIf(!hasGpp)("BIT members in a --test run", () => {
  beforeAll(() => {
    if (!existsSync(CLI_PATH)) throw new Error(`CLI not built: ${CLI_PATH}`);
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    writeFileSync(
      join(DIR, "src.st"),
      "TYPE ST_B : STRUCT a : BIT; b : BIT; n : INT; END_STRUCT; END_TYPE\nPROGRAM P\nVAR s : ST_B; END_VAR\ns.b := s.a;\nEND_PROGRAM\n",
    );
    writeFileSync(
      join(DIR, "tests.st"),
      "TEST 'bits'\nVAR s : ST_B; p : P; END_VAR\n  s.a := TRUE;\n  ASSERT_TRUE(s.a);\n  ASSERT_FALSE(s.b);\n  p.s.a := TRUE;\n  p();\n  ASSERT_TRUE(p.s.b);\nEND_TEST\n",
    );
  });

  it("reads and writes BIT members from a TEST", () => {
    const r = run([
      join(DIR, "src.st"),
      "--test",
      join(DIR, "tests.st"),
      "--feature",
      "+bit_type",
    ]);
    expect(r.out).toContain("1 test, 1 passed, 0 failed");
    expect(r.status).toBe(0);
  });
});
