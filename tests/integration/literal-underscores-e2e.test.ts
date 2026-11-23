// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Under `--dialect iec-3` and `--strict` an underscore in a numeric literal
 * must stand between two digits (IEC 61131-3 Ed. 3 Table 5): the CLI refuses
 * a misplaced one, and the valid forms still compile and run.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const CLI_PATH = path.resolve(__dirname, "../../dist/node/cli.js");

const REFUSED = `PROGRAM MAIN
VAR
  s : STRING[1__0];
  t : TIME;
  n : DINT;
END_VAR
t := T#1_ms;
n := 10_;
END_PROGRAM
`;

const VALID = `PROGRAM MAIN
VAR
  s : STRING[1_0];
  n : DINT;
  h : DINT;
  t : TIME;
  u : TIME;
  c : CHAR;
  l : UDINT;
  m : UDINT;
END_VAR
n := 1_000;
h := 16#FF_FF;
t := T#1d_2h;
u := T#1s_500ms;
c := CHAR#16#4_1;
s := '0123456789AB';
l := TIME_TO_UDINT(t);
m := TIME_TO_UDINT(u);
END_PROGRAM
`;

/** Run the CLI; returns exit status and both streams. */
function run(args: string[]): { status: number; out: string } {
  try {
    const stdout = execFileSync("node", [CLI_PATH, ...args], {
      encoding: "utf-8",
      timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
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

describe("underscores in numeric literals", () => {
  let tempDir: string;
  beforeAll(() => {
    if (!fs.existsSync(CLI_PATH)) {
      throw new Error(`CLI not built: ${CLI_PATH} not found.`);
    }
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-us-literals-"));
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("the CLI refuses misplaced ones under iec-3 and --strict, not otherwise", () => {
    const file = path.join(tempDir, "refused.st");
    fs.writeFileSync(file, REFUSED);
    const out = path.join(tempDir, "refused.cpp");
    const rule =
      "An underscore in a numeric literal must stand between two digits (IEC 61131-3 Ed. 3)";
    for (const flags of [["--dialect", "iec-3"], ["--strict"]]) {
      const r = run([file, "-o", out, ...flags]);
      expect(r.status).not.toBe(0);
      expect(r.out).toContain(`3:14`);
      expect(r.out).toContain(`${rule}: '1__0'`);
      expect(r.out).toContain(`${rule}: 'T#1_ms'`);
      expect(r.out).toContain(`${rule}: '10_'`);
    }
    const lax = run([file, "-o", out]);
    expect(lax.out).not.toContain(rule);
    expect(lax.status).toBe(0);
  });

  it("the CLI builds the valid forms under iec-3 and --strict", () => {
    const file = path.join(tempDir, "valid.st");
    fs.writeFileSync(file, VALID);
    for (const flags of [["--dialect", "iec-3"], ["--strict"], []]) {
      const r = run([file, "-o", path.join(tempDir, "valid.cpp"), ...flags]);
      expect(r.out).not.toContain("An underscore in a numeric literal");
      expect(r.status).toBe(0);
    }
  });

  describe.skipIf(!hasGpp)("at run time", () => {
    let pchPath: string;
    beforeAll(() => {
      pchPath = createPCH(tempDir);
    });

    it("the valid forms hold their values", () => {
      for (const opts of [{ dialect: "iec-3" }, { strict: true }]) {
        const r = compile(VALID, { headerFileName: "generated.hpp", ...opts });
        expect(r.errors).toEqual([]);
        const out = compileAndRunStandalone({
          tempDir,
          pchPath,
          headerCode: r.headerCode,
          cppCode: r.cppCode,
          testName: "literal_underscores",
          mainCode: `#include <iostream>
int main() {
  using namespace strucpp;
  static Program_MAIN p; p.run();
  std::cout << p.N.get() << " " << p.H.get() << " " << p.L.get() << " "
            << p.M.get() << " " << static_cast<int>(p.C.get()) << " "
            << p.S.get().c_str() << "\\n";
  return 0;
}
`,
        });
        expect(out.trim()).toBe("1000 65535 93600000 1500 65 0123456789");
      }
    });
  });
});
