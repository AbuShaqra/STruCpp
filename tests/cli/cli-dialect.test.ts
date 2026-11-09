/**
 * Dialect flags on the CLI: --print-dialect, --dialect, --dialect-path,
 * --dialect-file, --feature, and one plain error line for a bad profile.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { compile } from "../../src/index.js";
import { compileStlib } from "../../src/library/library-compiler.js";
import { nodeDialectIO } from "../../src/node/dialect-io.js";

const CLI_PATH = resolve(__dirname, "../../dist/node/cli.js");
const TMP_BASE = join(tmpdir(), "strucpp-cli-dialect-tests");
const GOOD = resolve(__dirname, "../fixtures/dialects/good");
const BAD = resolve(__dirname, "../fixtures/dialects/bad");

/** Run the CLI; returns exit status and both streams. */
function run(args: string[]): { status: number; out: string; err: string } {
  try {
    const stdout = execFileSync("node", [CLI_PATH, ...args], {
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

function freshDir(name: string): string {
  const dir = join(TMP_BASE, name);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeAll(() => {
  if (!existsSync(CLI_PATH)) {
    throw new Error(`CLI not built: ${CLI_PATH} not found.`);
  }
  mkdirSync(TMP_BASE, { recursive: true });
});

describe("--print-dialect", () => {
  it("--print-dialect without flags prints the default set", () => {
    const r = run(["--print-dialect"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      id: null,
      features: ["pointer_to", "ref_assign", "reference_to"],
    });
  });

  it("--dialect iec --print-dialect", () => {
    const r = run(["--dialect", "iec", "--print-dialect"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ id: "iec", features: [] });
  });

  it("--dialect-path tests/fixtures/dialects/good --dialect vendor-a --print-dialect", () => {
    const r = run([
      "--dialect-path",
      GOOD,
      "--dialect",
      "vendor-a",
      "--print-dialect",
    ]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      id: "vendor-a",
      features: ["pointer_to", "program_methods", "ref_assign", "reference_to"],
    });
  });

  it("--dialect-file selects the one file; --feature applies after it", () => {
    const r = run([
      "--dialect-file",
      join(GOOD, "vendor-a.json"),
      "--feature",
      "-pointer_to",
      "--feature",
      "-program_methods",
      "--print-dialect",
    ]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      id: "vendor-a",
      features: ["ref_assign", "reference_to"],
    });
  });
});

describe("bad dialect input", () => {
  const cases = readdirSync(BAD).sort();

  it("has one folder per bad case", () => {
    expect(cases).toEqual([
      "cycle",
      "json",
      "semantics",
      "unknown-feature",
      "wrong-id",
    ]);
  });

  it.each(cases)(
    "a bad profile exits 1 with one error line and no stack trace (%s)",
    (name) => {
      const r = run(["--dialect-path", join(BAD, name), "--print-dialect"]);
      expect(r.status).toBe(1);
      expect(r.out).toBe("");
      const lines = r.err.trimEnd().split("\n");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^error: /);
      expect(r.err).not.toMatch(/\n\s+at /);
    },
  );

  it("names the problem of each bad case", () => {
    const msg = (name: string): string =>
      run(["--dialect-path", join(BAD, name), "--print-dialect"]).err.trim();
    expect(msg("cycle")).toBe(
      "error: dialect 'bad-cycle-a': extends cycle bad-cycle-a -> bad-cycle-b -> bad-cycle-a",
    );
    expect(msg("json")).toMatch(/^error: dialect file .*bad-json\.json: .+/);
    expect(msg("semantics")).toMatch(
      /^error: dialect file .*bad-semantics\.json: semantics key 'trunc_result' is not known$/,
    );
    expect(msg("unknown-feature")).toMatch(
      /^error: unknown feature 'no_such_feature' in dialect file .*bad-feature\.json \(known: program_methods, pointer_to, reference_to, ref_assign\)$/,
    );
    expect(msg("wrong-id")).toMatch(
      /^error: dialect file .*bad-id\.json: id 'another-id' does not match the file name$/,
    );
  });

  it("an unknown dialect or feature exits 1", () => {
    const d = run(["--dialect", "nope", "--print-dialect"]);
    expect(d.status).toBe(1);
    expect(d.err.trim()).toBe("error: unknown dialect 'nope' (known: iec)");
    const f = run(["--feature", "+goto", "--print-dialect"]);
    expect(f.status).toBe(1);
    expect(f.err.trim()).toBe(
      "error: unknown feature 'goto' in --feature (known: program_methods, pointer_to, reference_to, ref_assign)",
    );
  });

  it("a bad profile stops --compile-lib before compiling", () => {
    const dir = freshDir("compile-lib");
    const st = join(dir, "lib.st");
    writeFileSync(
      st,
      "FUNCTION F : INT\n  VAR_INPUT a : INT; END_VAR\n  F := a;\nEND_FUNCTION\n",
    );
    const r = run([
      "--compile-lib",
      st,
      "-o",
      dir,
      "--lib-name",
      "f",
      "--dialect",
      "nope",
    ]);
    expect(r.status).toBe(1);
    expect(r.err.trim()).toBe("error: unknown dialect 'nope' (known: iec)");
    expect(existsSync(join(dir, "f.stlib"))).toBe(false);
  });
});

describe("compiling under a dialect", () => {
  it("--dialect iec compiles a plain program with the default libraries", () => {
    const dir = freshDir("plain");
    const st = join(dir, "main.st");
    writeFileSync(
      st,
      `PROGRAM Main
  VAR t : TON; done : BOOL; END_VAR
  t(IN := TRUE, PT := T#1s);
  done := t.Q;
END_PROGRAM
`,
    );
    const r = run([st, "-o", join(dir, "main.cpp"), "--dialect", "iec"]);
    expect(r.err).toBe("");
    expect(r.status).toBe(0);
    expect(existsSync(join(dir, "main.cpp"))).toBe(true);
  });

  it("compile() and compileStlib take the dialect options", () => {
    const src = "PROGRAM P\n  VAR x : INT; END_VAR\n  x := 1;\nEND_PROGRAM\n";
    expect(compile(src, { dialect: "iec" }).success).toBe(true);
    const bad = compile(src, { dialect: "nope" });
    expect(bad.success).toBe(false);
    expect(bad.errors.map((e) => e.message)).toEqual([
      "unknown dialect 'nope' (known: iec)",
    ]);
    expect(
      compile(src, {
        dialect: "vendor-a",
        dialectPath: [GOOD],
        dialectIO: nodeDialectIO,
      }).success,
    ).toBe(true);
    expect(compile(src, { dialectPath: [GOOD] }).errors[0]?.message).toBe(
      "dialect files need a file reader",
    );
    const lib = compileStlib(
      [
        {
          source: "FUNCTION F : INT\n  F := 1;\nEND_FUNCTION\n",
          fileName: "f.st",
        },
      ],
      { name: "f", version: "1.0.0", namespace: "f", dialect: "nope" },
    );
    expect(lib.success).toBe(false);
    expect(lib.errors.map((e) => e.message)).toEqual([
      "unknown dialect 'nope' (known: iec)",
    ]);
  });
});
