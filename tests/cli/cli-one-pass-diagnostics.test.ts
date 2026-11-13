// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Through the CLI, with the bundled libraries loaded: a type error and the
 * out-of-range typed literals of the same file are reported together.
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
});
