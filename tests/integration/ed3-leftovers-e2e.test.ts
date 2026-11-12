// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: a STRUCT OVERLAP shares its storage, the Table 46 typed timers run, and
 * a TON takes an LTIME preset, under g++.
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

const SOURCE = `TYPE T : STRUCT OVERLAP a : DINT; b : ARRAY[0..3] OF BYTE; END_STRUCT END_TYPE
PROGRAM Main
VAR
  v : T; low : DINT;
  tl : TON_LTIME; tt : TP_TIME; t : TON; p : LTIME := LT#0s;
  q1 : BOOL; q2 : BOOL; q3 : BOOL; et : LTIME; ta : ARRAY[0..1] OF TON; q4 : BOOL;
END_VAR
v.a := 16#01020304;
low := BYTE_TO_DINT(v.b[0]);
tl(IN := TRUE, PT := LT#0s);
tl(IN := TRUE, PT := LT#0s);
q1 := tl.Q;
tt(IN := TRUE, PT := T#1h);
q2 := tt.Q;
t.PT := p;
t(IN := TRUE);
t(IN := TRUE);
q3 := t.Q;
et := t.ET;
ta[1].PT := p;
ta[1](IN := TRUE);
ta[1](IN := TRUE);
q4 := ta[1].Q;
END_PROGRAM
`;

describe.skipIf(!hasGpp || !libsAvailable)("Ed. 3 leftovers — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-ed3-"));
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
        testName: `ed3_${label.replace(/\W/g, "_")}`,
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.LOW.get() << " " << p.Q1.get() << " " << p.Q2.get() << " "
              << p.Q3.get() << " " << p.ET.get() << " " << p.Q4.get() << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe("4 1 1 1 0 1");
    });
  }
});
