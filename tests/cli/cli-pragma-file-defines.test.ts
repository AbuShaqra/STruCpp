// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * `--pragma-define` (a conditional-pragma define only, never a global
 * constant) and `--file-define <file>=NAME[=VALUE]` (a define of one input
 * file) on the CLI.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";

const CLI_PATH = resolve(__dirname, "../../dist/node/cli.js");
const TMP = join(tmpdir(), "strucpp-cli-file-defines-tests");

function run(args: string[]): { status: number; err: string } {
  try {
    execFileSync("node", [CLI_PATH, ...args], {
      encoding: "utf-8",
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, err: "" };
  } catch (err: unknown) {
    const e = err as { status?: number; stderr?: string };
    return { status: e.status ?? -1, err: e.stderr ?? "" };
  }
}

const MAIN = `VAR_GLOBAL CONSTANT LEVEL : INT := 7; END_VAR
PROGRAM Main
VAR a : INT; c : INT; d : INT; END_VAR
{IF defined(FEAT)} a := 1; {ELSE} a := 2; {END_IF}
{IF hasvalue(LEVEL, '3')} c := 30; {ELSE} c := 40; {END_IF}
{IF project_defined(FEAT)} d := 5; {ELSE} d := 6; {END_IF}
END_PROGRAM
`;
const OTHER = `FUNCTION Other : INT
{IF defined(FEAT)} Other := 10; {ELSE} Other := 20; {END_IF}
END_FUNCTION
`;

let main = "";
let other = "";
beforeAll(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true });
  mkdirSync(TMP, { recursive: true });
  main = join(TMP, "main.st");
  other = join(TMP, "other.st");
  writeFileSync(main, MAIN);
  writeFileSync(other, OTHER);
});

describe("--pragma-define and --file-define", () => {
  it("applies a file define to its file only, and a pragma-only value", () => {
    const out = join(TMP, "out.cpp");
    const r = run([
      main,
      other,
      "-o",
      out,
      "--feature",
      "+conditional_pragmas",
      "--file-define",
      `${main}=FEAT`,
      "--pragma-define",
      "LEVEL=3",
    ]);
    expect(r.err).toBe("");
    expect(r.status).toBe(0);
    const cpp = readFileSync(out, "utf-8");
    expect(cpp).toContain("A = 1;");
    expect(cpp).toContain("C = 30;");
    expect(cpp).toContain("D = 6;");
    expect(cpp).toContain("OTHER_result = 20;");
  });

  it("refuses a file that is no input, a bad name and --compile-lib", () => {
    expect(
      run([main, "-o", join(TMP, "x.cpp"), "--file-define", "nope.st=FEAT"])
        .err,
    ).toContain("--file-define file 'nope.st' is not an input file");
    expect(
      run([main, "-o", join(TMP, "x.cpp"), "--file-define", `${main}=1BAD`])
        .err,
    ).toContain(
      "--file-define needs NAME or NAME=VALUE with an identifier name",
    );
    expect(
      run([main, "-o", join(TMP, "x.cpp"), "--pragma-define", "2X"]).err,
    ).toContain("--pragma-define needs NAME or NAME=VALUE");
    expect(
      run([
        main,
        "--compile-lib",
        "--lib-name",
        "x",
        "-o",
        TMP,
        "--file-define",
        `${main}=FEAT`,
      ]).err,
    ).toContain("cannot be used with --compile-lib");
  });
});
