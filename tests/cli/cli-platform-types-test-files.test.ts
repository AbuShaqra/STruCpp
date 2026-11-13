/**
 * Platform types in a --test file follow the run's dialect: lowered with the
 * feature platform_types, refused without it, and a TYPE of the same name
 * declared in the sources wins (g++).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync, mkdtempSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { hasGpp } from "../integration/test-helpers.js";
import { parseTestFile } from "../../src/testing/test-parser.js";
import { analyzeTestFile, compile } from "../../src/index.js";

const CLI_PATH = resolve(__dirname, "../../dist/node/cli.js");
// Per-run folder, so concurrent runs do not share files.
const DIR = mkdtempSync(join(tmpdir(), "strucpp-cli-platform-types-tests-"));

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

const TESTS = `TEST 'v'
VAR q : XINT := 5000000000; a : ARRAY[0..1] OF UXINT; END_VAR
  a[1] := 7;
  ASSERT_EQ(q, 5000000000);
  ASSERT_EQ(a[1], 7);
END_TEST
`;

describe("platform types in a test file", () => {
  it("are lowered by parseTestFile only with the feature", () => {
    const on = parseTestFile(TESTS, "t.st", {
      features: ["+platform_types"],
    });
    const decl = on.testFile!.testCases[0]!.varBlocks[0]!.declarations;
    expect(decl[0]!.type.name).toBe("LINT");
    expect(decl[0]!.type.platformTypeName).toBe("XINT");
    const off = parseTestFile(TESTS, "t.st");
    expect(
      off.testFile!.testCases[0]!.varBlocks[0]!.declarations[0]!.type.name,
    ).toBe("XINT");
  });

  it("names the loaded profiles that have the feature when it is off", () => {
    const src = compile(
      "PROGRAM P\nVAR x : INT; END_VAR\nx := 1;\nEND_PROGRAM\n",
      {},
    );
    const parsed = parseTestFile(TESTS, "t.st", {
      dialect: {
        id: "twincat3",
        name: "twincat3",
        extends: "iec-3",
        features: ["platform_types"],
        semantics: {},
      },
      features: ["-platform_types"],
    });
    const r = analyzeTestFile(parsed.testFile!, src.symbolTables!, src.ast);
    expect(r.errors.map((e) => e.message)).toContain(
      "XINT needs the feature platform_types (profiles: twincat3)",
    );
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
      writeFileSync(
        join(DIR, "own.st"),
        "TYPE XINT : STRUCT a : INT; END_STRUCT; END_TYPE\nPROGRAM P\nVAR x : XINT; END_VAR\nx.a := 1;\nEND_PROGRAM\n",
      );
      writeFileSync(
        join(DIR, "own_tests.st"),
        "TEST 'v'\nVAR q : XINT; END_VAR\n  q.a := 3;\n  ASSERT_EQ(q.a, 3);\nEND_TEST\n",
      );
    });

    it("run with the feature and are refused without it", () => {
      const src = join(DIR, "src.st");
      const tests = join(DIR, "tests.st");
      const on = run([src, "--test", tests, "--feature", "+platform_types"]);
      expect(on.out).toContain("1 test, 1 passed, 0 failed");
      const off = run([src, "--test", tests]);
      expect(off.status).not.toBe(0);
      expect(off.err + off.out).toContain(
        "XINT needs the feature platform_types",
      );
    });

    it("leave a TYPE the sources declare to the sources", () => {
      const r = run([
        join(DIR, "own.st"),
        "--test",
        join(DIR, "own_tests.st"),
        "--feature",
        "+platform_types",
      ]);
      expect(r.out).toContain("1 test, 1 passed, 0 failed");
    });
  });
});

afterAll(() => rmSync(DIR, { recursive: true, force: true }));
