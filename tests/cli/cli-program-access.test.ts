// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * A PROGRAM reached by name from another POU through the CLI: `--check`
 * refuses it without the feature program_methods and accepts it with the
 * feature, and compiling with the feature emits the one shared instance.
 *
 * Runs `dist/node/cli.js` by default; set STRUCPP_CLI to run another entry
 * point, e.g. `STRUCPP_CLI=dist/strucpp-bundle.cjs`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";

const CLI_PATH = resolve(
  process.env.STRUCPP_CLI ?? resolve(__dirname, "../../dist/node/cli.js"),
);
// Per-run folder, so concurrent runs do not share files.
const DIR = mkdtempSync(join(tmpdir(), "strucpp-cli-program-access-tests-"));

const SOURCE = `PROGRAM PRG_A
VAR cnt : INT; END_VAR
  cnt := cnt + 1;
  ACTION Reset: cnt := 0; END_ACTION
END_PROGRAM
PROGRAM MAIN
VAR x : INT; END_VAR
  x := PRG_A.cnt;
  PRG_A.Reset();
  PRG_A();
END_PROGRAM
`;

/** Run the CLI in DIR; returns exit status and both streams. */
function run(args: string[]): { status: number; out: string; err: string } {
  try {
    const stdout = execFileSync("node", [CLI_PATH, ...args], {
      cwd: DIR,
      encoding: "utf-8",
      timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });
    return { status: 0, out: stdout, err: "" };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, out: e.stdout ?? "", err: e.stderr ?? "" };
  }
}

/** `--check --json` diagnostics as `line:col message`. */
function checkJson(args: string[]): { status: number; diags: string[] } {
  const r = run(["--check", "--json", ...args]);
  const report = JSON.parse(r.out) as {
    diagnostics: { line: number; column: number; message: string }[];
  };
  return {
    status: r.status,
    diags: report.diagnostics.map((d) => `${d.line}:${d.column} ${d.message}`),
  };
}

describe("CLI: a PROGRAM reached by name", () => {
  beforeAll(() => {
    if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    writeFileSync(join(DIR, "access.st"), SOURCE);
  });

  it("--check refuses it without program_methods", () => {
    const { status, diags } = checkJson(["access.st"]);
    expect(status).toBe(1);
    expect(diags).toEqual([
      "8:8 Cannot access members of program 'PRG_A' directly — declare a variable of type 'PRG_A' first.",
      "9:3 the methods and actions of PROGRAM PRG_A can be called only inside PRG_A",
      "10:3 a call of PROGRAM PRG_A from another POU needs the feature program_methods",
    ]);
  });

  it("--check accepts it with --feature +program_methods", () => {
    const { status, diags } = checkJson([
      "access.st",
      "--feature",
      "+program_methods",
    ]);
    expect(diags).toEqual([]);
    expect(status).toBe(0);
  });

  it("compiles it to the one shared instance", () => {
    const r = run([
      "access.st",
      "-o",
      "access.cpp",
      "--feature",
      "+program_methods",
    ]);
    expect(r.status).toBe(0);
    const header = readFileSync(join(DIR, "access.hpp"), "utf-8");
    const cpp = readFileSync(join(DIR, "access.cpp"), "utf-8");
    expect(header).toContain("inline Program_PRG_A __program_PRG_A;");
    expect(cpp).toContain("X = __program_PRG_A.CNT;");
    expect(cpp).toContain("__program_PRG_A.RESET();");
    expect(cpp).toContain("__program_PRG_A.run();");
  });
});

afterAll(() => rmSync(DIR, { recursive: true, force: true }));
