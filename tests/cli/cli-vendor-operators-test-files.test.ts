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
import { analyzeTestFile } from "../../src/semantic/analyzer.js";
import { compile } from "../../src/index.js";

/** The errors of a test file analyzed against `source`, with the operators on. */
function testErrors(source: string, tests: string): string[] {
  const opts = { features: ["+vendor_operators"] };
  const src = compile(source, opts);
  expect(src.errors).toEqual([]);
  const parsed = parseTestFile(tests, "t.st", opts);
  expect(parsed.errors).toEqual([]);
  return analyzeTestFile(parsed.testFile!, src.symbolTables!).errors.map(
    (e) => `${e.line}:${e.column}: ${e.message}`,
  );
}

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
    expect(
      testErrors(
        "PROGRAM P\nEND_PROGRAM\n",
        `TEST 't'
VAR s : STRING; d : DWORD; x : BOOL; END_VAR
  s := __POUNAME();
  d := BITADR(x);
  __POSITION();
END_TEST
`,
      ),
    ).toEqual([
      "3:8: __POUNAME is not supported in a test file",
      "4:8: BITADR is not supported in a test file",
      "5:3: __POSITION gives a value: use it in an expression, not as a statement",
    ]);
  });

  it("leaves a call to a source FUNCTION or a test variable of the name", () => {
    const source = `FUNCTION BITADR : DWORD
VAR_INPUT v : BOOL; END_VAR
BITADR := 42;
END_FUNCTION
FUNCTION __POUNAME : STRING
__POUNAME := 'mine';
END_FUNCTION
FUNCTION_BLOCK FB_Pos
VAR_OUTPUT o : STRING; END_VAR
END_FUNCTION_BLOCK
PROGRAM P
END_PROGRAM
`;
    const tests = `SETUP
VAR __position : FB_Pos; END_VAR
END_SETUP
TEST 't'
VAR s : STRING; d : DWORD; x : BOOL; END_VAR
  s := __POUNAME();
  d := BITADR(x);
  __POSITION();
  s := __POSITION.o;
END_TEST
`;
    expect(testErrors(source, tests)).toEqual([]);
    const parsed = parseTestFile(tests, "t.st", {
      features: ["+vendor_operators"],
    });
    analyzeTestFile(
      parsed.testFile!,
      compile(source, { features: ["+vendor_operators"] }).symbolTables!,
    );
    expect(JSON.stringify(parsed.testFile)).not.toContain("Line ");
  });

  it("lowers __POSITION although a source enumeration has a member of the name", () => {
    expect(
      testErrors(
        "TYPE E_K : (__POSITION, BITADR, OTHER); END_TYPE\nPROGRAM P\nEND_PROGRAM\n",
        `TEST 'enum'
VAR s : STRING; END_VAR
  s := __POSITION();
END_TEST
`,
      ),
    ).toEqual([]);
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
