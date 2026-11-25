// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Through the CLI, with the bundled libraries loaded: a type error and the
 * out-of-range typed literals of the same file are reported together; the
 * errors later passes find are reported with an earlier one, by a build and by
 * --check; and --check gives the shared-global in-out warning a build gives.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";

const CLI_PATH = resolve(__dirname, "../../dist/node/cli.js");
let dir = "";

function run(args: string[]): { status: number; out: string } {
  try {
    const stdout = execFileSync("node", [CLI_PATH, ...args], {
      encoding: "utf-8",
      timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
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

beforeAll(() => {
  if (!existsSync(CLI_PATH)) throw new Error(`CLI not built: ${CLI_PATH}`);
  dir = mkdtempSync(join(tmpdir(), "strucpp-cli-one-pass-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("one-pass diagnostics through the CLI", () => {
  for (const flags of [[], ["--dialect", "iec-3"], ["--strict"]]) {
    it(`lists every error at once (${flags.join(" ") || "no dialect"})`, () => {
      const src = join(dir, "a.st");
      writeFileSync(
        src,
        "PROGRAM Main\nVAR i : INT; n : INT; s : SINT; b : BYTE; END_VAR\nn := LEN(i);\ns := SINT#200;\nb := BYTE#256;\nEND_PROGRAM\n",
      );
      const r = run([src, "-o", join(dir, "a.cpp"), ...flags]);
      expect(r.status).toBe(1);
      expect(r.out).toContain(
        "a.st:3:10: error: Argument 'IN' of 'LEN' expects ANY_STRING, got INT",
      );
      expect(r.out).toContain(
        "a.st:4:6: error: Typed literal 'SINT#200' is outside the range of SINT",
      );
      expect(r.out).toContain(
        "a.st:5:6: error: Typed literal 'BYTE#256' is outside the range of BYTE",
      );
    });
  }

  it("reports an error a later pass finds with an earlier one (build and --check)", () => {
    const src = join(dir, "b.st");
    writeFileSync(
      src,
      "PROGRAM Main\nVAR i : INT; r : REAL; p : DWORD; END_VAR\ni := r MOD 2;\np := ADR(i);\nEND_PROGRAM\n",
    );
    for (const args of [
      [src, "-o", join(dir, "b.cpp"), "--dialect", "iec-3"],
      ["--check", src, "--dialect", "iec-3"],
    ]) {
      const r = run(args);
      expect(r.status).toBe(1);
      expect(r.out).toContain("b.st:3:6: error: MOD takes integers");
      expect(r.out).toContain(
        "b.st:4:6: error: ADR needs the feature pointer_to",
      );
    }
    expect(existsSync(join(dir, "b.cpp"))).toBe(false);
  });

  it("--check gives the shared-global in-out warning when tasks may race", () => {
    const body = (tasks: string): string =>
      `FUNCTION Bump : INT\nVAR_IN_OUT x : INT; END_VAR\nx := x + 1; Bump := x;\nEND_FUNCTION\nPROGRAM P1\nVAR_EXTERNAL g : INT; END_VAR\nVAR r : INT; END_VAR\nr := Bump(x := g);\nEND_PROGRAM\nCONFIGURATION C\nVAR_GLOBAL g : INT; END_VAR\nRESOURCE R ON PLC\n${tasks}END_RESOURCE\nEND_CONFIGURATION\n`;
    const one = join(dir, "one.st");
    const two = join(dir, "two.st");
    writeFileSync(
      one,
      body(
        "TASK T1(INTERVAL := T#10ms, PRIORITY := 1);\nPROGRAM I1 WITH T1 : P1;\n",
      ),
    );
    writeFileSync(
      two,
      body(
        "TASK T1(INTERVAL := T#10ms, PRIORITY := 1);\nTASK T2(INTERVAL := T#20ms, PRIORITY := 2);\nPROGRAM I1 WITH T1 : P1;\nPROGRAM I2 WITH T2 : P1;\n",
      ),
    );
    // The --json report is on stdout: one diagnostic per finding
    const shared = (args: string[]): string[] => {
      const r = run(["--check", "--json", ...args]);
      expect(r.status).toBe(0);
      const report = JSON.parse(r.out) as {
        diagnostics: { line: number; severity: string; message: string }[];
      };
      return report.diagnostics
        .filter((d) => d.message.includes("the shared global 'G'"))
        .map((d) => `${d.line}:${d.severity}`);
    };
    expect(shared([two])).toEqual(["8:warning"]);
    expect(shared([one])).toEqual([]);
    expect(shared([one, "--cxx-flags", "-DSTRUCPP_THREADED"])).toEqual([
      "8:warning",
    ]);
  });
});
