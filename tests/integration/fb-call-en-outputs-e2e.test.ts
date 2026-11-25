// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: a function block call with EN = FALSE does not run, so its `=>`
 * targets keep their values (and an in-out passed by copy is not copied
 * back); with EN = TRUE or no EN the outputs are captured as before.
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
const libraries = () =>
  discoverStlibs(LIBS_DIR).filter((a) => a.manifest.name !== "oscat-basic");

const SOURCE = `
FUNCTION_BLOCK FB
VAR_INPUT i : INT; END_VAR
VAR_OUTPUT o : INT; END_VAR
VAR_IN_OUT io : DINT; END_VAR
o := i + 1;
io := io + 1;
END_FUNCTION_BLOCK
FUNCTION_BLOCK FBE
VAR_INPUT i : INT; END_VAR
VAR_OUTPUT o : INT; ENO : BOOL; END_VAR
o := i * 2;
END_FUNCTION_BLOCK
PROGRAM Main
VAR
  fb : FB; fbe : FBE; t : TON; yes : BOOL := TRUE; off : BOOL;
  a : INT := 100; b : INT := 100; c : INT := 100; d : INT := 100;
  q : BOOL := TRUE; et : TIME := T#5s; ok : BOOL := TRUE; k : INT := 7;
END_VAR
fb(EN := off, i := 5, o => a, io := k);
fb(EN := yes, i := 5, o => b, io := k);
fbe(EN := off, i := 4, o => c, ENO => ok);
fbe(i := 4, o => d);
t(EN := off, IN := TRUE, PT := T#1s, Q => q, ET => et);
END_PROGRAM
`;

const MAIN = `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.A.get() << " " << p.B.get() << " " << p.C.get() << " "
              << p.D.get() << " " << p.Q.get() << " " << p.ET.get().raw << " "
              << p.OK.get() << " " << p.K.get() << std::endl;
    return 0;
}
`;

describe.skipIf(!libsAvailable)("FB call with EN — codegen", () => {
  it("captures the outputs inside the EN branch", () => {
    const result = compile(SOURCE, { libraries: libraries() });
    expect(result.errors).toEqual([]);
    const body = result.cppCode.slice(
      result.cppCode.indexOf("void Program_MAIN::run()"),
    );
    const gated = body.slice(0, body.indexOf("} else {"));
    expect(gated).toContain("if (OFF) {");
    expect(gated).toContain("A = FB_.O;");
  });
});

describe.skipIf(!hasGpp || !libsAvailable)("FB call with EN — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-fben-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const options of [{}, { strict: true }]) {
    it(`leaves the targets of a call that did not run (${JSON.stringify(options)})`, () => {
      const result = compile(SOURCE, {
        ...options,
        headerFileName: "generated.hpp",
        libraries: libraries(),
      });
      expect(result.errors).toEqual([]);
      const out = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: `fb_en_outputs_${Object.keys(options).length}`,
        mainCode: MAIN,
      });
      // a, c, q, et untouched; b and d captured; ok FALSE; k incremented once
      expect(out).toBe("100 6 100 8 1 5000 0 8");
    });
  }
});
