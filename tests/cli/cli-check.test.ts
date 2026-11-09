// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * `--check` and `--check --json` end to end: the CLI runs analysis only,
 * writes nothing, and exits 0 (clean), 1 (errors) or 2 (usage, unreadable
 * file, dialect problem). Also: warnings are printed when a compile fails.
 *
 * Runs `dist/node/cli.js` by default; set STRUCPP_CLI to run another entry
 * point, e.g. `STRUCPP_CLI=dist/strucpp-bundle.cjs`.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, copyFileSync, rmSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";

const CLI_PATH = resolve(
  process.env.STRUCPP_CLI ?? resolve(__dirname, "../../dist/node/cli.js"),
);
const FIX = resolve(__dirname, "../fixtures/check");
const GOOD_DIALECTS = resolve(__dirname, "../fixtures/dialects/good");
const BAD_DIALECTS = resolve(__dirname, "../fixtures/dialects/bad");

interface JsonDiagnostic {
  file: string | null;
  line: number;
  column: number;
  severity: string;
  message: string;
  pouName?: string;
}
interface CheckReport {
  dialect: string | null;
  files: string[];
  diagnostics: JsonDiagnostic[];
  summary: { errors: number; warnings: number };
}

/** Run the CLI from `cwd`; returns exit status and both streams. */
function run(
  args: string[],
  cwd: string = FIX,
): { status: number; out: string; err: string } {
  try {
    const stdout = execFileSync("node", [CLI_PATH, ...args], {
      cwd,
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

/** Run `--check --json` and parse the one JSON document on stdout. */
function runJson(args: string[]): { status: number; report: CheckReport } {
  const r = run(["--check", "--json", ...args]);
  return { status: r.status, report: JSON.parse(r.out) as CheckReport };
}

beforeAll(() => {
  if (!existsSync(CLI_PATH)) {
    throw new Error(`CLI not built: ${CLI_PATH} not found.`);
  }
});

describe("--check --json", () => {
  it("clean file: exit 0, empty diagnostics", () => {
    const { status, report } = runJson(["clean.st"]);
    expect(status).toBe(0);
    expect(report).toEqual({
      dialect: null,
      files: ["clean.st"],
      diagnostics: [],
      summary: { errors: 0, warnings: 0 },
    });
  });

  it("semantic error: exit 1 with the right line and column", () => {
    const { status, report } = runJson(["semantic.st"]);
    expect(status).toBe(1);
    expect(report.summary.errors).toBe(1);
    expect(report.diagnostics).toHaveLength(1);
    expect(report.diagnostics[0]).toMatchObject({
      file: "semantic.st",
      line: 5,
      column: 6,
      severity: "error",
      pouName: "MAIN",
    });
    expect(report.diagnostics[0]!.message).toMatch(/MISSINGVAR/i);
  });

  it("lexer error: exit 1 with a real position, not 0:0", () => {
    const { status, report } = runJson(["lexer.st"]);
    expect(status).toBe(1);
    const lex = report.diagnostics.find((d) =>
      d.message.includes("unexpected character"),
    );
    expect(lex).toMatchObject({ file: "lexer.st", line: 5, column: 8 });
  });

  it("warnings are reported alongside errors", () => {
    const { status, report } = runJson(["warn-and-error.st"]);
    expect(status).toBe(1);
    expect(report.summary).toEqual({ errors: 1, warnings: 1 });
    expect(report.diagnostics.map((d) => [d.severity, d.line])).toEqual(
      expect.arrayContaining([
        ["warning", 6],
        ["error", 7],
      ]),
    );
  });

  it("warnings alone: exit 0", () => {
    const { status, report } = runJson(["warn-only.st"]);
    expect(status).toBe(0);
    expect(report.summary).toEqual({ errors: 0, warnings: 1 });
  });

  it("pragmas: exit 0, each listed as a warning with its position", () => {
    for (const dialect of [[], ["--dialect", "iec-3"]]) {
      const { status, report } = runJson([...dialect, "pragma.st"]);
      expect(status).toBe(0);
      expect(report.summary).toEqual({ errors: 0, warnings: 2 });
      expect(
        report.diagnostics.map((d) => [d.severity, d.line, d.column]),
      ).toEqual([
        ["warning", 1, 1],
        ["warning", 4, 3],
      ]);
      for (const d of report.diagnostics) {
        expect(d.file).toBe("pragma.st");
        expect(d.message).toMatch(/pragma ignored/i);
      }
    }
  });

  it("several files; the path is reported as given", () => {
    const r = run(["--check", "--json", "clean.st", join(FIX, "helper-bad.st")]);
    expect(r.status).toBe(1);
    const report = JSON.parse(r.out) as CheckReport;
    expect(report.files).toEqual(["clean.st", join(FIX, "helper-bad.st")]);
    expect(report.diagnostics).toHaveLength(1);
    expect(report.diagnostics[0]).toMatchObject({
      file: join(FIX, "helper-bad.st"),
      line: 5,
    });
  });

  it("several clean files: exit 0", () => {
    const { status, report } = runJson(["clean.st", "helper.st"]);
    expect(status).toBe(0);
    expect(report.diagnostics).toEqual([]);
  });

  it("writes no files", () => {
    const dir = join(tmpdir(), "strucpp-cli-check-nowrite");
    if (existsSync(dir)) rmSync(dir, { recursive: true });
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(FIX, "clean.st"), join(dir, "clean.st"));
    const r = run(["--check", "clean.st"], dir);
    expect(r.status).toBe(0);
    expect(readdirSync(dir)).toEqual(["clean.st"]);
  });
});

describe("--check honours the dialect flags", () => {
  it("default features accept POINTER TO", () => {
    const { status, report } = runJson(["pointer.st"]);
    expect(status).toBe(0);
    expect(report.dialect).toBeNull();
  });

  it("--dialect iec-3 refuses it with exit 1", () => {
    const { status, report } = runJson(["--dialect", "iec-3", "pointer.st"]);
    expect(status).toBe(1);
    expect(report.dialect).toBe("iec-3");
    expect(report.diagnostics[0]!.message).toMatch(/pointer_to/);
  });

  it("--feature +pointer_to after --dialect iec-3 accepts it", () => {
    const { status, report } = runJson([
      "--dialect",
      "iec-3",
      "--feature",
      "+pointer_to",
      "pointer.st",
    ]);
    expect(status).toBe(0);
    expect(report.dialect).toBe("iec-3");
  });

  it("--dialect-path selects a profile from a folder", () => {
    const { status, report } = runJson([
      "--dialect-path",
      GOOD_DIALECTS,
      "--dialect",
      "vendor-a",
      "pointer.st",
    ]);
    expect(status).toBe(0);
    expect(report.dialect).toBe("vendor-a");
  });

  it("--dialect-file selects the one file", () => {
    const { status, report } = runJson([
      "--dialect-file",
      join(GOOD_DIALECTS, "vendor-a.json"),
      "pointer.st",
    ]);
    expect(status).toBe(0);
    expect(report.dialect).toBe("vendor-a");
  });
});

describe("--check exit code 2", () => {
  it("unknown dialect", () => {
    const r = run(["--check", "--dialect", "no-such-dialect", "clean.st"]);
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/error:/);
  });

  it("unknown dialect with --json still prints one JSON document", () => {
    const r = run([
      "--check",
      "--json",
      "--dialect",
      "no-such-dialect",
      "clean.st",
    ]);
    expect(r.status).toBe(2);
    const report = JSON.parse(r.out) as CheckReport;
    expect(report.summary.errors).toBe(1);
    expect(report.diagnostics[0]!.severity).toBe("error");
  });

  it("--dialect iec exits 2 and names iec-3", () => {
    const r = run(["--check", "--json", "--dialect", "iec", "clean.st"]);
    expect(r.status).toBe(2);
    const report = JSON.parse(r.out) as CheckReport;
    expect(report.dialect).toBeNull();
    expect(report.diagnostics[0]!.message).toBe(
      "unknown dialect 'iec' (known: iec-3); the IEC 61131-3 Ed. 3 profile is 'iec-3'",
    );
  });

  it("a broken profile folder", () => {
    const bad = readdirSync(BAD_DIALECTS)[0]!;
    const r = run([
      "--check",
      "--dialect-file",
      join(BAD_DIALECTS, bad),
      "clean.st",
    ]);
    expect(r.status).toBe(2);
  });

  it("unreadable input file", () => {
    const r = run(["--check", "does-not-exist.st"]);
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/does-not-exist\.st/);
  });

  it("no input file", () => {
    expect(run(["--check"]).status).toBe(2);
  });

  it("combined with --build", () => {
    // Runs in a scratch dir: if the combination were accepted it would build there, not in fixtures.
    const dir = join(tmpdir(), "strucpp-cli-check-build");
    if (existsSync(dir)) rmSync(dir, { recursive: true });
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(FIX, "clean.st"), join(dir, "clean.st"));
    expect(run(["--check", "--build", "clean.st"], dir).status).toBe(2);
    expect(readdirSync(dir)).toEqual(["clean.st"]);
  });

  it("a dialect flag without a value", () => {
    expect(run(["--check", "clean.st", "--dialect"]).status).toBe(2);
  });
});

describe("--check human output", () => {
  it("prints file:line:col: severity: message for errors and warnings", () => {
    const r = run(["--check", "warn-and-error.st"]);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/^warn-and-error\.st:6:6: warning: /m);
    expect(r.err).toMatch(/^warn-and-error\.st:7:6: error: /m);
  });

  it("clean file: exit 0 and no diagnostics", () => {
    const r = run(["--check", "clean.st"]);
    expect(r.status).toBe(0);
    expect(r.err).toBe("");
  });
});

describe("warnings on failure in compile mode", () => {
  it("a failed compile still prints its warnings", () => {
    const dir = join(tmpdir(), "strucpp-cli-check-compile");
    if (existsSync(dir)) rmSync(dir, { recursive: true });
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(FIX, "warn-and-error.st"), join(dir, "w.st"));
    const r = run(["w.st", "-o", join(dir, "w.cpp")], dir);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/w\.st:7:6: error: /);
    expect(r.err).toMatch(/w\.st:6:6: warning: /);
  });
});
