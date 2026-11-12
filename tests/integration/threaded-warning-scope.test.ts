// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * The warnings about a shared global reached by reference (a VAR_IN_OUT bound
 * to it, or its REF/ADR) apply only where another task can run at the same
 * time: a CONFIGURATION with more than one task, or a threaded build.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { compile } from "../../src/index.js";
import { hasGpp } from "./test-helpers.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];
const CLI_PATH = resolve(__dirname, "../../dist/node/cli.js");

const source = (tasks: 1 | 2): string => `FUNCTION Bump : INT
VAR_IN_OUT v : INT; END_VAR
v := v + 1; Bump := v;
END_FUNCTION
PROGRAM Main
VAR_EXTERNAL g : INT; END_VAR
VAR r : INT; p : REF_TO INT; END_VAR
r := Bump(v := g);
p := REF(g);
END_PROGRAM
PROGRAM Other
VAR n : INT; END_VAR
n := n + 1;
END_PROGRAM
CONFIGURATION Config0
VAR_GLOBAL g : INT; END_VAR
RESOURCE Res0 ON PLC
TASK t1(INTERVAL := T#20ms, PRIORITY := 1);
${tasks === 2 ? "TASK t2(INTERVAL := T#50ms, PRIORITY := 2);\n" : ""}PROGRAM p1 WITH t1 : Main;
${tasks === 2 ? "PROGRAM p2 WITH t2 : Other;\n" : ""}END_RESOURCE
END_CONFIGURATION
`;

const raceWarnings = (src: string, options: Options): string[] => {
  const r = compile(src, options);
  expect(r.errors).toEqual([]);
  return r.warnings
    .map((w) => w.message)
    .filter((m) => m.includes("STRUCPP_THREADED"));
};

describe("shared-global warnings only where tasks can race", () => {
  for (const [label, options] of MODES) {
    it(`gives none for one task in an unthreaded build (${label})`, () => {
      expect(raceWarnings(source(1), options)).toEqual([]);
    });

    it(`warns for more than one task (${label})`, () => {
      const found = raceWarnings(source(2), options);
      expect(found).toHaveLength(2);
      expect(found[0]).toContain(
        "VAR_IN_OUT 'V' refers to the shared global 'G' during the call",
      );
      expect(found[1]).toContain("REF of the shared global 'G'");
    });

    it(`warns for one task in a threaded build (${label})`, () => {
      expect(
        raceWarnings(source(1), { ...options, threaded: true }),
      ).toHaveLength(2);
    });
  }
});

describe.skipIf(!hasGpp)("through the CLI", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "strucpp-threaded-warning-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const run = (args: string[]): string => {
    const r = spawnSync("node", [CLI_PATH, ...args], {
      encoding: "utf-8",
      timeout: 300000,
      env: { ...process.env, NO_COLOR: "1" },
    });
    return `${r.stdout}${r.stderr}`;
  };

  for (const flags of [[], ["--dialect", "iec-3"], ["--strict"]]) {
    const label = flags.join(" ") || "no dialect";
    it(`warns only when --build defines STRUCPP_THREADED (${label})`, () => {
      const src = join(dir, `one_${flags.length}.st`);
      writeFileSync(src, source(1));
      const plain = run([
        src,
        "-o",
        join(dir, `plain_${flags.length}.cpp`),
        ...flags,
      ]);
      expect(plain).not.toContain("refers to the shared global");
      const threaded = run([
        src,
        "-o",
        join(dir, `thr_${flags.length}.cpp`),
        "--build",
        "--cxx-flags",
        "-DSTRUCPP_THREADED -pthread",
        ...flags,
      ]);
      expect(threaded).toContain(
        "VAR_IN_OUT 'V' refers to the shared global 'G'",
      );
      expect(threaded).toContain("REF of the shared global 'G'");
    });
  }
});
