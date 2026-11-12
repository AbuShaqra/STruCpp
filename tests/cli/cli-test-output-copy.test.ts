// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * An output bound in a TEST block follows the assignment rules and is copied
 * out through a temporary where its C++ type differs, as in a POU body; a
 * FUNCTION with a VAR_OUTPUT runs through the test build's dispatch.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { hasGpp } from "../integration/test-helpers.js";

const CLI_PATH = resolve(__dirname, "../../dist/node/cli.js");
const LIBS = resolve(__dirname, "../../libs");
let dir = "";

/** Run the CLI; returns exit status and both streams. */
function run(args: string[]): { status: number; out: string } {
  try {
    const stdout = execFileSync("node", [CLI_PATH, ...args], {
      encoding: "utf-8",
      timeout: 120000,
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

const SOURCE = `FUNCTION FOut : BOOL
VAR_INPUT a : INT; END_VAR
VAR_OUTPUT o : USINT; END_VAR
o := 200; FOut := TRUE;
END_FUNCTION
PROGRAM Main VAR x : UINT; ok : BOOL; END_VAR ok := FOut(a := 1, o => x); END_PROGRAM
`;

const TESTS = `TEST 'copy out'
VAR ok : BOOL; z : UINT; y : UDINT; mu : MyU; END_VAR
ok := FOut(a := 1, o => z);
ok := SPLIT_DATE(IN := D#2024-03-05, YEAR => y);
ok := FOut(1, mu);
ASSERT_EQ(z, 200);
ASSERT_EQ(y, 2024);
ASSERT_EQ(UINT_TO_INT(mu), 200);
END_TEST
`;

beforeAll(() => {
  if (!existsSync(CLI_PATH)) {
    throw new Error(`CLI not built: ${CLI_PATH} not found.`);
  }
  dir = mkdtempSync(join(tmpdir(), "strucpp-cli-test-output-copy-"));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!hasGpp)("output bindings in TEST blocks", () => {
  for (const flags of [[], ["--dialect", "iec-3"], ["--strict"]]) {
    it(`copies an output of another type out (${flags.join(" ") || "no dialect"})`, () => {
      const src = join(dir, "src.st");
      const test = join(dir, "test_src.st");
      writeFileSync(src, `TYPE MyU : UINT; END_TYPE\n${SOURCE}`);
      writeFileSync(test, TESTS);
      const r = run([src, "--test", test, ...flags]);
      expect(r.out).toContain("1 test, 1 passed, 0 failed");
      expect(r.status).toBe(0);
    });
  }

  it("fills an output a TEST or SETUP call leaves out", () => {
    const src = join(dir, "omit.st");
    const test = join(dir, "test_omit.st");
    writeFileSync(
      src,
      "FUNCTION FU : BOOL VAR_INPUT a : INT; END_VAR VAR_OUTPUT o : USINT; t : TIME; END_VAR o := 9; t := T#3s; FU := TRUE; END_FUNCTION\nPROGRAM Main VAR ok : BOOL; END_VAR ok := TRUE; END_PROGRAM\n",
    );
    writeFileSync(
      test,
      `SETUP
VAR su : USINT; sok : BOOL; END_VAR
sok := FU(1, su);
END_SETUP
TEST 'omitted'
VAR ok : BOOL; x : USINT; END_VAR
ok := FU(a := 2, o => x);
ASSERT_EQ(x, 9);
ASSERT_EQ(su, 9);
END_TEST
`,
    );
    const r = run([src, "--test", test]);
    expect(r.out).toContain("1 test, 1 passed, 0 failed");
  });

  it("copies out an output of a library alias type", () => {
    const libSrc = join(dir, "lsrc");
    mkdirSync(libSrc, { recursive: true });
    writeFileSync(
      join(libSrc, "l.st"),
      "TYPE LU : USINT; END_TYPE\nFUNCTION LF : BOOL\nVAR_IN_OUT k : INT; END_VAR\nVAR_OUTPUT o : USINT; q : LU; END_VAR\nVAR_INPUT a : INT; END_VAR\nk := k + a; o := 5; q := 6; LF := TRUE;\nEND_FUNCTION\n",
    );
    const libOut = join(dir, "lib");
    const built = run([
      "--compile-lib",
      libSrc,
      "-o",
      libOut,
      "--lib-name",
      "zl",
      "-L",
      LIBS,
    ]);
    expect(built.status).toBe(0);
    const src = join(dir, "lp.st");
    const test = join(dir, "test_lp.st");
    writeFileSync(
      src,
      "FUNCTION TE : DINT VAR ok : BOOL; k : INT := 1; u : USINT; w : UINT; END_VAR\nok := LF(k := k, o => w, q => u, a := 3);\nTE := USINT_TO_DINT(u) * 1000 + UINT_TO_DINT(w) * 10 + k;\nEND_FUNCTION\nPROGRAM Main VAR r : DINT; END_VAR r := TE(); END_PROGRAM\n",
    );
    writeFileSync(test, "TEST 'lib alias'\nASSERT_EQ(TE(), 6054);\nEND_TEST\n");
    const r = run([src, "--test", test, "-L", libOut, "-L", LIBS]);
    expect(r.out).toContain("1 test, 1 passed, 0 failed");
  });

  it("refuses an output its variable cannot be assigned", () => {
    const src = join(dir, "bad.st");
    const test = join(dir, "test_bad.st");
    writeFileSync(src, SOURCE);
    writeFileSync(
      test,
      `TEST 'refused'
VAR ok : BOOL; t : TIME; END_VAR
ok := FOut(a := 1, o => t);
END_TEST
`,
    );
    const r = run([src, "--test", test]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("Cannot assign USINT to TIME");
  });
});
