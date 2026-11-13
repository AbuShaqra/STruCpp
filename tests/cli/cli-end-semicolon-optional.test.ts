/**
 * The feature end_semicolon_optional relaxes the --strict check that END_IF,
 * END_FOR, END_WHILE, END_CASE and END_REPEAT end with a `;`. It is off by
 * default and under iec-3, and changes nothing without --strict.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync, mkdtempSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { compile } from "../../src/index.js";

const CLI_PATH = resolve(__dirname, "../../dist/node/cli.js");
// Per-run folder, so concurrent runs do not share files.
const TMP = mkdtempSync(join(tmpdir(), "strucpp-cli-end-semicolon-tests-"));

const SOURCE = `FUNCTION_BLOCK FB
VAR n, i : INT; END_VAR
METHOD M : INT
  FOR i := 1 TO 3 DO M := M + 1; END_FOR
END_METHOD
  WHILE n < 3 DO n := n + 1; END_WHILE
END_FUNCTION_BLOCK
PROGRAM Main
VAR i, n : INT; b : BOOL; END_VAR
  IF b THEN n := 1; END_IF
  CASE n OF 1: n := 2; END_CASE
  REPEAT n := n + 1; UNTIL n > 20 END_REPEAT
  IF b THEN
    FOR i := 1 TO 2 DO n := n + 1; END_FOR
  END_IF
END_PROGRAM
`;

const MISSING = [
  "Missing ';' after END_FOR",
  "Missing ';' after END_WHILE",
  "Missing ';' after END_IF",
  "Missing ';' after END_CASE",
  "Missing ';' after END_REPEAT",
  "Missing ';' after END_IF",
  "Missing ';' after END_FOR",
];

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

function messages(options: Parameters<typeof compile>[1]): string[] {
  return compile(SOURCE, options).errors.map((e) => e.message);
}

describe("end_semicolon_optional through compile()", () => {
  it("changes nothing without --strict", () => {
    expect(messages({})).toEqual([]);
    expect(messages({ dialect: "iec-3" })).toEqual([]);
    expect(messages({ features: ["+end_semicolon_optional"] })).toEqual([]);
  });

  it("is off by default and under iec-3, so --strict keeps the error", () => {
    expect(messages({ strict: true }).sort()).toEqual([...MISSING].sort());
    expect(messages({ strict: true, dialect: "iec-3" }).sort()).toEqual(
      [...MISSING].sort(),
    );
  });

  it("relaxes the --strict check when on", () => {
    expect(
      messages({ strict: true, features: ["+end_semicolon_optional"] }),
    ).toEqual([]);
    expect(
      messages({
        strict: true,
        dialect: "iec-3",
        features: ["+end_semicolon_optional"],
      }),
    ).toEqual([]);
  });

  it("is turned on by a profile that extends iec-3", () => {
    const profile = {
      id: "vendor-x",
      name: "Vendor X",
      extends: "iec-3",
      features: ["end_semicolon_optional" as const],
      semantics: {},
    };
    expect(messages({ strict: true, dialect: profile })).toEqual([]);
    expect(
      messages({
        strict: true,
        dialect: profile,
        features: ["-end_semicolon_optional"],
      }),
    ).toHaveLength(MISSING.length);
  });

  it("generates the same C++ with and without the feature", () => {
    const plain = compile(SOURCE, {});
    const relaxed = compile(SOURCE, {
      strict: true,
      features: ["+end_semicolon_optional"],
    });
    expect(relaxed.cppCode).toBe(plain.cppCode);
    expect(relaxed.headerCode).toBe(plain.headerCode);
  });
});

describe("end_semicolon_optional on the CLI", () => {
  let st: string;
  let profileFile: string;
  beforeAll(() => {
    if (!existsSync(CLI_PATH)) {
      throw new Error(`CLI not built: ${CLI_PATH} not found.`);
    }
    if (existsSync(TMP)) rmSync(TMP, { recursive: true });
    mkdirSync(TMP, { recursive: true });
    st = join(TMP, "main.st");
    writeFileSync(st, SOURCE);
    profileFile = join(TMP, "vendor-x.json");
    writeFileSync(
      profileFile,
      JSON.stringify({
        id: "vendor-x",
        name: "Vendor X",
        extends: "iec-3",
        features: ["end_semicolon_optional"],
        semantics: {},
      }),
    );
  });

  it("--strict alone and with iec-3 refuse the missing semicolons", () => {
    for (const extra of [[], ["--dialect", "iec-3"]]) {
      const r = run(["--check", "--strict", ...extra, st]);
      expect(r.status).toBe(1);
      expect(r.out + r.err).toContain("Missing ';' after END_IF");
    }
  });

  it("--strict --feature end_semicolon_optional accepts them", () => {
    const r = run([
      "--check",
      "--strict",
      "--feature",
      "end_semicolon_optional",
      st,
    ]);
    expect(r.out + r.err).not.toContain("Missing ';'");
    expect(r.status).toBe(0);
  });

  it("--strict with a profile file that extends iec-3 accepts them", () => {
    const r = run(["--check", "--strict", "--dialect-file", profileFile, st]);
    expect(r.out + r.err).not.toContain("Missing ';'");
    expect(r.status).toBe(0);
    const p = run(["--dialect-file", profileFile, "--print-dialect"]);
    expect(p.out).toContain("end_semicolon_optional");
  });

  it("the --feature help names the feature", () => {
    expect(run(["--help"]).out).toContain("end_semicolon_optional");
  });
});

afterAll(() => rmSync(TMP, { recursive: true, force: true }));
