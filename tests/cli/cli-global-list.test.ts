/**
 * `--global-list <file>=<name>` on the CLI: names the global variable list of
 * an input file (default: the file stem), in compile and --check mode.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "fs";
import { resolve, join } from "path";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";

const CLI_PATH = resolve(__dirname, "../../dist/node/cli.js");

/** Run the CLI in `cwd`; returns exit status and both streams. */
function run(
  args: string[],
  cwd: string,
): { status: number; out: string; err: string } {
  try {
    const stdout = execFileSync("node", [CLI_PATH, ...args], {
      cwd,
      encoding: "utf-8",
      timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, out: stdout, err: "" };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, out: e.stdout ?? "", err: e.stderr ?? "" };
  }
}

let dir: string;

beforeAll(() => {
  if (!existsSync(CLI_PATH)) {
    throw new Error(`CLI not built: ${CLI_PATH} not found.`);
  }
  dir = mkdtempSync(join(tmpdir(), "strucpp-cli-global-list-"));
  mkdirSync(join(dir, "lists"), { recursive: true });
  writeFileSync(
    join(dir, "lists", "GVL_A.st"),
    "VAR_GLOBAL\n  rate : INT := 3;\nEND_VAR\n",
  );
  writeFileSync(
    join(dir, "main.st"),
    "PROGRAM Main\nVAR v : INT; END_VAR\nv := Plant.rate;\nEND_PROGRAM\n",
  );
  writeFileSync(
    join(dir, "stem.st"),
    "PROGRAM Main\nVAR v : INT; END_VAR\nv := GVL_A.rate;\nEND_PROGRAM\n",
  );
});

const FEATURE = ["--feature", "+named_global_lists", "--no-default-libs"];

describe("--global-list", () => {
  it("--check: the file stem is the default list name", () => {
    const r = run(["--check", "stem.st", "lists/GVL_A.st", ...FEATURE], dir);
    expect(r.err).toBe("");
    expect(r.status).toBe(0);
  });

  it("--check: the given name replaces the stem", () => {
    const ok = run(
      [
        "--check",
        "main.st",
        "lists/GVL_A.st",
        "--global-list",
        "lists/GVL_A.st=Plant",
        ...FEATURE,
      ],
      dir,
    );
    expect(ok.status).toBe(0);
    const old = run(
      [
        "--check",
        "stem.st",
        "lists/GVL_A.st",
        "--global-list",
        "./lists/GVL_A.st=Plant",
        ...FEATURE,
      ],
      dir,
    );
    expect(old.status).toBe(1);
    expect(old.err).toContain("Undeclared variable 'GVL_A'");
  });

  it("--check without the feature names it", () => {
    const r = run(
      ["--check", "--json", "stem.st", "lists/GVL_A.st", "--no-default-libs"],
      dir,
    );
    expect(r.status).toBe(1);
    const report = JSON.parse(r.out) as {
      diagnostics: Array<{ message: string; line: number }>;
    };
    expect(report.diagnostics.map((d) => `${d.line} ${d.message}`)).toEqual([
      "3 Global variable list access 'GVL_A.RATE' needs the feature named_global_lists",
    ]);
  });

  it("compiles with the given name", () => {
    const r = run(
      [
        "main.st",
        "lists/GVL_A.st",
        "--global-list",
        "lists/GVL_A.st=Plant",
        "-o",
        "out.cpp",
        ...FEATURE,
      ],
      dir,
    );
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, "out.cpp"), "utf-8")).toContain("V = RATE;");
  });

  it("a malformed value is a usage error", () => {
    for (const spec of ["lists/GVL_A.st", "=Plant", "lists/GVL_A.st=1x"]) {
      const r = run(
        ["--check", "main.st", "lists/GVL_A.st", "--global-list", spec],
        dir,
      );
      expect(r.status).toBe(2);
      expect(r.err.trim()).toBe(
        `error: --global-list needs <file>=<name> with an identifier name, got '${spec}'`,
      );
    }
    const missing = run(["--check", "main.st", "--global-list"], dir);
    expect(missing.status).toBe(2);
  });

  it("a file that is not an input, or given twice, is a usage error", () => {
    const notInput = run(
      ["--check", "main.st", "--global-list", "other.st=Plant"],
      dir,
    );
    expect(notInput.status).toBe(2);
    expect(notInput.err.trim()).toBe(
      "error: --global-list file 'other.st' is not an input file",
    );
    const twice = run(
      [
        "main.st",
        "lists/GVL_A.st",
        "--global-list",
        "lists/GVL_A.st=A",
        "--global-list",
        "lists/GVL_A.st=B",
      ],
      dir,
    );
    expect(twice.status).toBe(1);
    expect(twice.err.trim()).toBe(
      "error: --global-list file 'lists/GVL_A.st' is given twice",
    );
  });
});
