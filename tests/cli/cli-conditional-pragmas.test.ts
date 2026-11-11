// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * Conditional pragmas on the CLI: refused without the feature, resolved
 * with it, defines from -D / --define, in compile, --check, --compile-lib
 * and --test.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { hasGpp } from "../integration/test-helpers.js";

const CLI_PATH = resolve(__dirname, "../../dist/node/cli.js");
const TMP_BASE = join(tmpdir(), "strucpp-cli-cond-pragma-tests");

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

function freshDir(name: string): string {
  const dir = join(TMP_BASE, name);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

const PROGRAM = `PROGRAM Main
VAR
{IF defined(SIM)}
  x : INT := 1;
{ELSIF hasvalue(MODE, 'fast')}
  x : INT := 2;
{ELSE}
  x : INT := 3;
{END_IF}
END_VAR
x := x + 0;
END_PROGRAM
`;

let dir = "";
let src = "";
let profile = "";

beforeAll(() => {
  if (!existsSync(CLI_PATH)) {
    throw new Error(`CLI not built: ${CLI_PATH} not found.`);
  }
  dir = freshDir("base");
  src = join(dir, "main.st");
  writeFileSync(src, PROGRAM);
  profile = join(dir, "vendor-cond.json");
  writeFileSync(
    profile,
    JSON.stringify({
      id: "vendor-cond",
      extends: "iec-3",
      features: ["conditional_pragmas"],
    }),
  );
});

/** Compile `src` to a fresh directory; returns the run and the generated C++. */
function compileWith(
  name: string,
  args: string[],
): {
  status: number;
  out: string;
  err: string;
  cpp: string;
} {
  const out = join(freshDir(name), "main.cpp");
  const r = run([src, "-o", out, ...args]);
  const cpp = existsSync(out)
    ? readFileSync(out, "utf-8") +
      readFileSync(out.replace(/\.cpp$/, ".hpp"), "utf-8")
    : "";
  return { ...r, cpp };
}

describe("refused without the feature", () => {
  it.each([
    ["no flags", [] as string[]],
    ["--dialect iec-3", ["--dialect", "iec-3"]],
    ["--strict", ["--strict"]],
  ])("%s: exit 1 with the position and the feature hint", (_n, flags) => {
    const r = compileWith(`refused-${flags.join("")}`, [...flags, "-D", "SIM"]);
    expect(r.status).toBe(1);
    expect(r.out + r.err).toContain(
      "main.st:3:1: error: Conditional compilation pragmas are not supported: {IF defined(SIM)}; they need the feature conditional_pragmas",
    );
  });

  it("--dialect iec-3 with the profile loaded names it", () => {
    const r = compileWith("refused-named", [
      "--dialect",
      "iec-3",
      "--dialect-file",
      profile,
    ]);
    expect(r.status).toBe(1);
    expect(r.out + r.err).toContain(
      "they need the feature conditional_pragmas (profiles: vendor-cond)",
    );
  });
});

describe("accepted with the feature", () => {
  it.each([
    ["no define", [] as string[], "X(3)"],
    ["-D SIM", ["-D", "SIM"], "X(1)"],
    ["-DSIM", ["-DSIM"], "X(1)"],
    ["--define SIM", ["--define", "SIM"], "X(1)"],
    ["-D MODE=fast", ["-D", "MODE=fast"], "X(2)"],
    ["-DMODE=slow", ["-DMODE=slow"], "X(3)"],
  ])("--strict + profile, %s", (_n, defines, init) => {
    const r = compileWith(`ok-${defines.join("")}`, [
      "--strict",
      "--dialect-file",
      profile,
      ...defines,
    ]);
    expect(r.err).toBe("");
    expect(r.status).toBe(0);
    expect(r.cpp).toContain(init);
  });

  it("--feature +conditional_pragmas enables it too", () => {
    const r = compileWith("feature", [
      "--feature",
      "+conditional_pragmas",
      "-D",
      "SIM",
    ]);
    expect(r.status).toBe(0);
    expect(r.cpp).toContain("X(1)");
  });

  it("-D N=5 still emits the global constant and also defines N", () => {
    const d = freshDir("const");
    const file = join(d, "n.st");
    writeFileSync(
      file,
      `PROGRAM Main
VAR
{IF hasvalue(N, '5')}
  x : INT := 1;
{ELSE}
  x : INT := 2;
{END_IF}
END_VAR
x := x + 0;
END_PROGRAM
`,
    );
    const out = join(d, "n.cpp");
    const r = run([
      file,
      "-o",
      out,
      "--feature",
      "+conditional_pragmas",
      "-D",
      "N=5",
    ]);
    expect(r.status).toBe(0);
    const cpp =
      readFileSync(out, "utf-8") + readFileSync(join(d, "n.hpp"), "utf-8");
    expect(cpp).toMatch(/constexpr\s+\S+\s+N\s*=\s*5/);
    expect(cpp).toContain("X(1)");
  });

  it("a dead-branch error is not reported; a pragma error has its position", () => {
    const d = freshDir("errors");
    const file = join(d, "e.st");
    writeFileSync(
      file,
      `PROGRAM Main
VAR x : INT; END_VAR
{IF defined(SIM)}
x := not valid st;
{END_IF}
x := 1;
{ELSE}
END_PROGRAM
`,
    );
    const r = run([
      file,
      "-o",
      join(d, "e.cpp"),
      "--feature",
      "+conditional_pragmas",
    ]);
    expect(r.status).toBe(1);
    const text = r.out + r.err;
    expect(text).toContain("e.st:7:1: error: {ELSE} without a matching {IF}");
    expect(text).not.toContain("e.st:4:");
  });
});

describe("-D usage errors", () => {
  it("a name that is not an identifier exits 1, or 2 under --check", () => {
    const r = run([src, "-o", join(freshDir("bad-d"), "x.cpp"), "-D", "1X"]);
    expect(r.status).toBe(1);
    expect(r.err).toContain(
      "error: -D needs NAME or NAME=VALUE with an identifier name, got '1X'",
    );
    const c = run(["--check", src, "-D", "1X=3"]);
    expect(c.status).toBe(2);
    expect(c.err).toContain("got '1X=3'");
  });
});

describe("--check and --print-dialect", () => {
  it("--check --json lists the refusal, or nothing with the profile", () => {
    const refused = run(["--check", "--json", src, "--strict"]);
    expect(refused.status).toBe(1);
    const report = JSON.parse(refused.out) as {
      dialect: string | null;
      diagnostics: Array<{ line: number; column: number; message: string }>;
    };
    expect(report.diagnostics[0]).toMatchObject({ line: 3, column: 1 });
    expect(report.diagnostics[0]!.message).toContain("conditional_pragmas");

    const ok = run([
      "--check",
      "--json",
      src,
      "--strict",
      "--dialect-file",
      profile,
      "-D",
      "SIM",
    ]);
    expect(ok.status).toBe(0);
    const okReport = JSON.parse(ok.out) as {
      dialect: string;
      diagnostics: unknown[];
    };
    expect(okReport.dialect).toBe("vendor-cond");
    expect(okReport.diagnostics).toEqual([]);
  });

  it("--check reports pragma errors at their line and column", () => {
    const d = freshDir("check-err");
    const file = join(d, "c.st");
    writeFileSync(
      file,
      "PROGRAM Main\n{IF hastype(variable:x, INT)}\n{END_IF}\nEND_PROGRAM\n",
    );
    const r = run([
      "--check",
      "--json",
      file,
      "--feature",
      "+conditional_pragmas",
    ]);
    expect(r.status).toBe(1);
    const report = JSON.parse(r.out) as {
      diagnostics: Array<{ line: number; column: number; message: string }>;
    };
    expect(report.diagnostics).toEqual([
      expect.objectContaining({
        line: 2,
        column: 5,
        message: "Conditional pragma operator 'hastype' is not supported",
      }),
    ]);
  });

  it("--print-dialect shows the feature from the profile only", () => {
    const plain = JSON.parse(run(["--print-dialect", "--strict"]).out) as {
      features: string[];
    };
    expect(plain.features).not.toContain("conditional_pragmas");
    const vendor = JSON.parse(
      run(["--print-dialect", "--strict", "--dialect-file", profile]).out,
    ) as { id: string; features: string[] };
    expect(vendor).toEqual({
      id: "vendor-cond",
      features: ["conditional_pragmas"],
    });
  });
});

describe("--compile-lib with -D", () => {
  it("compiles only the active branch and records the defines", () => {
    const d = freshDir("lib");
    const st = join(d, "lib.st");
    writeFileSync(
      st,
      `FUNCTION F : INT
VAR_INPUT a : INT; END_VAR
{IF defined(FAST)}
F := a + 100;
{ELSE}
F := a + 7;
{END_IF}
END_FUNCTION
`,
    );
    const r = run([
      "--compile-lib",
      st,
      "-o",
      d,
      "--lib-name",
      "f",
      "--feature",
      "+conditional_pragmas",
      "-D",
      "FAST",
    ]);
    expect(r.err).toBe("");
    expect(r.status).toBe(0);
    const archive = JSON.parse(readFileSync(join(d, "f.stlib"), "utf-8")) as {
      chunks: Array<{ cppCode?: string; headerCode?: string }>;
      pragmaDefines?: Record<string, string>;
    };
    const code = JSON.stringify(archive.chunks);
    expect(code).toContain("100");
    expect(code).not.toContain("+ 7");
    expect(archive.pragmaDefines).toEqual({ FAST: "" });

    const refused = run(["--compile-lib", st, "-o", d, "--lib-name", "g"]);
    expect(refused.status).toBe(1);
    expect(refused.out + refused.err).toContain(
      "they need the feature conditional_pragmas",
    );
  });
});

describe.skipIf(!hasGpp)("--test", () => {
  it("test files take the pass with the dialect flags and -D", () => {
    const d = freshDir("test-mode");
    const prog = join(d, "prog.st");
    const test = join(d, "test_prog.st");
    writeFileSync(prog, PROGRAM.replace("x := x + 0;", "x := x;"));
    writeFileSync(
      test,
      `TEST 'branch'
  VAR uut : Main; END_VAR
  uut();
{IF defined(SIM)}
  ASSERT_EQ(uut.x, 1);
{ELSE}
  ASSERT_EQ(uut.x, 3);
{END_IF}
END_TEST
`,
    );
    const sim = run([
      prog,
      "--test",
      test,
      "--dialect-file",
      profile,
      "-D",
      "SIM",
    ]);
    expect(sim.out).toContain("1 test, 1 passed, 0 failed");
    expect(sim.status).toBe(0);
    const plain = run([prog, "--test", test, "--dialect-file", profile]);
    expect(plain.out).toContain("1 test, 1 passed, 0 failed");
    expect(plain.status).toBe(0);
    const refused = run([prog, "--test", test]);
    expect(refused.status).toBe(1);
  });
});
