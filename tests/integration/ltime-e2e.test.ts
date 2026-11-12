// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: LTIME values, literals, TIME mixing and conversions build and run under
 * g++, an LTON from the IEC library runs, and an LTIME leaf is read on the
 * debug wire as a TIME-tagged 8-byte nanosecond count.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const LIBS_DIR = path.resolve(__dirname, "../../libs");
const libsAvailable = fs.existsSync(
  path.join(LIBS_DIR, "iec-standard-fb.stlib"),
);

const SOURCE = `PROGRAM Main
VAR
  a : LTIME := LTIME#1d2h3m4s5ms6us7ns;
  b : LTIME := LT#-1_500ms;
  big : LTIME := LTIME#106751d;
  t : TIME := T#2s;
  c : LTIME; d : LTIME; t2 : TIME; n : LINT; x : BOOL;
  tm : LTON; q1 : BOOL; q2 : BOOL;
END_VAR
c := a + b;
d := t + a;
x := t < a;
t2 := LTIME_TO_TIME(b * 2);
n := LTIME_TO_LINT(big);
tm(IN := TRUE, PT := LTIME#0s);
q1 := tm.Q;
tm(IN := TRUE, PT := LTIME#0s);
q2 := tm.Q;
END_PROGRAM
`;

describe.skipIf(!hasGpp || !libsAvailable)("LTIME — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-ltime-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const [label, options] of [
    ["no dialect", {}],
    ["iec-3", { dialect: "iec-3" }],
    ["strict", { strict: true }],
  ] as const) {
    it(`builds and runs (${label})`, () => {
      const result = compile(SOURCE, {
        ...options,
        headerFileName: "generated.hpp",
        libraries: discoverStlibs(LIBS_DIR),
      });
      expect(result.errors).toEqual([]);
      const stdout = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: `ltime_${label.replace(/\W/g, "_")}`,
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.C.get() << " " << p.D.get() << " " << p.X.get() << " "
              << p.T2.get() << " " << p.N.get() << " " << p.Q1.get() << " "
              << p.Q2.get() << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe(
        "93782505006007 93786005006007 1 -3000000000 9223286400000000000 0 1",
      );
    });
  }

  it("describes an LTIME leaf to the debugger as TIME, 8 bytes", () => {
    const result = compile(
      `${SOURCE}
CONFIGURATION C
RESOURCE R ON PLC
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM inst WITH T : Main;
END_RESOURCE
END_CONFIGURATION`,
      { headerFileName: "generated.hpp", libraries: discoverStlibs(LIBS_DIR) },
    );
    expect(result.errors).toEqual([]);
    const leaf = result.debugMap!.leaves.find((l) => l.path === "INST.A");
    expect(leaf).toMatchObject({ type: "TIME", size: 8 });
    expect(result.debugTableCpp).toContain("TAG_TIME, 0 },  // INST.A");
  });
});
