// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * FB_init through the CLI (feature fb_init): `--check` refuses init arguments
 * without the feature and warns at a METHOD FB_init; with it, the code checks
 * clean and compiles. Init arguments on a library FB check clean and are
 * refused by compile only, as not supported yet.
 *
 * Runs `dist/node/cli.js` by default; set STRUCPP_CLI to run another entry
 * point, e.g. `STRUCPP_CLI=dist/strucpp-bundle.cjs`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";

const CLI_PATH = resolve(
  process.env.STRUCPP_CLI ?? resolve(__dirname, "../../dist/node/cli.js"),
);
const DIR = mkdtempSync(join(tmpdir(), "strucpp-cli-fb-init-"));

const SOURCE = `FUNCTION_BLOCK FB_A
VAR v : INT; END_VAR
METHOD FB_init : BOOL
VAR_INPUT bInitRetains : BOOL; bInCopyCode : BOOL; p : INT; END_VAR
v := p;
END_METHOD
END_FUNCTION_BLOCK
VAR_GLOBAL g : FB_A(p := 1); END_VAR
PROGRAM Main
VAR f : FB_A(p := 2); arr : ARRAY[0..1] OF FB_A(p := 3); END_VAR
END_PROGRAM
`;

const WARN_ONLY = `FUNCTION_BLOCK FB_A
METHOD FB_init : BOOL
VAR_INPUT bInitRetains : BOOL; bInCopyCode : BOOL; END_VAR
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main
VAR f : FB_A; END_VAR
END_PROGRAM
`;

const LIBRARY_FB = `PROGRAM Main
VAR t : TON(PT := T#1S); END_VAR
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

/** `--check --json` diagnostics as `severity line:col message`. */
function checkJson(args: string[]): { status: number; diags: string[] } {
  const r = run(["--check", "--json", ...args]);
  const report = JSON.parse(r.out) as {
    diagnostics: {
      severity: string;
      line: number;
      column: number;
      message: string;
    }[];
  };
  return {
    status: r.status,
    diags: report.diagnostics.map(
      (d) => `${d.severity} ${d.line}:${d.column} ${d.message}`,
    ),
  };
}

beforeAll(() => {
  if (!existsSync(CLI_PATH)) {
    throw new Error(`CLI not built: ${CLI_PATH} not found.`);
  }
  writeFileSync(join(DIR, "init.st"), SOURCE);
  writeFileSync(join(DIR, "warn.st"), WARN_ONLY);
  writeFileSync(join(DIR, "libfb.st"), LIBRARY_FB);
});

afterAll(() => rmSync(DIR, { recursive: true, force: true }));

describe("--check with init arguments and FB_init", () => {
  for (const flags of [[], ["--dialect", "iec-3"]]) {
    it(`refuses init arguments and warns at FB_init without the feature (${flags.join(" ") || "no dialect"})`, () => {
      expect(checkJson(["init.st", ...flags])).toEqual({
        status: 1,
        diags: [
          "warning 3:8 FB_init is not run unless the feature fb_init is on",
          "error 8:20 The init argument list of 'G' needs the feature fb_init",
          "error 10:13 The init argument list of 'F' needs the feature fb_init",
          "error 10:48 The init argument list of 'ARR' needs the feature fb_init",
        ],
      });
    });

    it(`only warns for an FB_init with no init arguments (${flags.join(" ") || "no dialect"})`, () => {
      expect(checkJson(["warn.st", ...flags])).toEqual({
        status: 0,
        diags: [
          "warning 2:8 FB_init is not run unless the feature fb_init is on",
        ],
      });
    });
  }

  it("is clean with --feature +fb_init, also under iec-3", () => {
    for (const flags of [[], ["--dialect", "iec-3"]]) {
      expect(checkJson(["init.st", ...flags, "--feature", "+fb_init"])).toEqual(
        { status: 0, diags: [] },
      );
    }
  });
});

describe("compiling with fb_init", () => {
  it("writes the C++", () => {
    const out = join(DIR, "init.cpp");
    const r = run(["init.st", "--feature", "+fb_init", "-o", out]);
    expect(r.err).toBe("");
    expect(r.status).toBe(0);
    expect(existsSync(out)).toBe(true);
  });

  it("refuses init arguments on a library FB at compile only", () => {
    expect(checkJson(["libfb.st", "--feature", "+fb_init"])).toEqual({
      status: 0,
      diags: [],
    });
    const out = join(DIR, "libfb.cpp");
    const r = run(["libfb.st", "--feature", "+fb_init", "-o", out]);
    expect(r.status).toBe(1);
    expect(r.err + r.out).toContain(
      "libfb.st:2:5: error: FB_init of 'T' is not supported yet: 'TON' comes from a library",
    );
    expect(existsSync(out)).toBe(false);
  });
});
