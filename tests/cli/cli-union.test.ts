// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * UNION through the CLI (feature union): `--check` analyses valid UNION code
 * clean with the feature and refuses it without; a compile stops with the
 * code generation refusal and writes no C++; programs that use UNION and
 * END_UNION as names check and compile as before.
 *
 * Runs `dist/node/cli.js` by default; set STRUCPP_CLI to run another entry
 * point, e.g. `STRUCPP_CLI=dist/strucpp-bundle.cjs`.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";

const CLI_PATH = resolve(
  process.env.STRUCPP_CLI ?? resolve(__dirname, "../../dist/node/cli.js"),
);
const DIR = join(tmpdir(), "strucpp-cli-union-tests");

const UNION_SOURCE = `TYPE
  U_A : UNION f : REAL; d : DWORD; arr : ARRAY[0..3] OF BYTE; END_UNION;
  ST_W : STRUCT u : U_A; k : INT; END_STRUCT;
END_TYPE
FUNCTION_BLOCK FB_H
VAR_INPUT inp : U_A; END_VAR
VAR_IN_OUT io : U_A; END_VAR
VAR_OUTPUT o : DWORD; END_VAR
o := inp.d;
io.f := 2.0;
END_FUNCTION_BLOCK
PROGRAM Main
VAR u : U_A; w : ST_W; arr : ARRAY[1..2] OF U_A; fb : FB_H; r : REAL; END_VAR
u.f := 1.5; r := u.f; u.arr[1] := 2; w.u := u; arr[2] := w.u;
fb(inp := u, io := arr[1]);
END_PROGRAM
`;

const LIBRARY_FB_MEMBER = `TYPE U_T : UNION t : TON; d : DWORD; END_UNION; END_TYPE
PROGRAM Main
VAR u : U_T; END_VAR
u.d := 1;
END_PROGRAM
`;

const NAMES_SOURCE = `TYPE
  union : STRUCT x : INT; END_STRUCT;
  E : (Union, End_Union);
  T1 : Union;
END_TYPE
PROGRAM Main
VAR union : INT; end_union : INT; s : T1; e : E := End_Union; END_VAR
union := end_union + s.x;
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

beforeAll(() => {
  if (!existsSync(CLI_PATH)) {
    throw new Error(`CLI not built: ${CLI_PATH} not found.`);
  }
  if (existsSync(DIR)) rmSync(DIR, { recursive: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, "union.st"), UNION_SOURCE);
  writeFileSync(join(DIR, "libfb.st"), LIBRARY_FB_MEMBER);
  writeFileSync(join(DIR, "names.st"), NAMES_SOURCE);
});

describe("--check with UNION", () => {
  it("is clean with --feature +union", () => {
    expect(checkJson(["union.st", "--feature", "+union"])).toEqual({
      status: 0,
      diags: [],
    });
  });

  it("is clean with --dialect iec-3 --feature +union", () => {
    expect(
      checkJson(["union.st", "--dialect", "iec-3", "--feature", "+union"]),
    ).toEqual({ status: 0, diags: [] });
  });

  for (const flags of [[], ["--dialect", "iec-3"]]) {
    it(`refuses the UNION at UNION without the feature (${flags.join(" ") || "no dialect"})`, () => {
      expect(checkJson(["union.st", ...flags])).toEqual({
        status: 1,
        diags: ["2:9 UNION type 'U_A' needs the feature union"],
      });
    });
  }

  it("refuses a library function block as a member", () => {
    expect(checkJson(["libfb.st", "--feature", "+union"])).toEqual({
      status: 1,
      diags: [
        "1:22 Member 'T' of UNION 'U_T' is of FUNCTION_BLOCK type 'TON': a UNION member must be data, not a function block, interface or program instance",
      ],
    });
  });
});

describe("compiling UNION", () => {
  it("stops before code generation and writes no C++", () => {
    const out = join(DIR, "union.cpp");
    const r = run(["union.st", "--feature", "+union", "-o", out]);
    expect(r.status).toBe(1);
    expect(r.err + r.out).toContain(
      "union.st:2:3: error: code generation for UNION is not supported yet (UNION 'U_A')",
    );
    expect(existsSync(out)).toBe(false);
  });
});

describe("UNION and END_UNION as names", () => {
  for (const flags of [[], ["--dialect", "iec-3"], ["--feature", "+union"]]) {
    it(`check and compile as before (${flags.join(" ") || "no dialect"})`, () => {
      expect(checkJson(["names.st", ...flags])).toEqual({
        status: 0,
        diags: [],
      });
      const out = join(DIR, `names${flags.length}.cpp`);
      expect(run(["names.st", ...flags, "-o", out]).status).toBe(0);
      expect(existsSync(out)).toBe(true);
    });
  }
});
