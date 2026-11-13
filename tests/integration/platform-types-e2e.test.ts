/**
 * platform_types end to end (g++): the platform types hold 64-bit values,
 * and a PVOID holds an address a POINTER TO reads through.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile, type CompileOptions } from "../../src/index.js";
import type { DialectProfile } from "../../src/dialect.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const PROFILE: DialectProfile = {
  id: "codesys3",
  name: "codesys3",
  extends: "iec-3",
  features: ["pointer_to", "platform_types"],
  semantics: {},
};

const SOURCE = `PROGRAM MAIN
VAR
  x : DINT := 42;
  xi : XINT := -3000000000;
  ux : __UXINT := 16#FFFFFFFFFF;
  xw : XWORD;
  pv : PVOID;
  pd : POINTER TO DINT;
  got : DINT;
  sizes : ULINT;
END_VAR
xi := xi * 2;
ux := ux + 1;
xw := 1;
xw := SHL(xw, 40);
pv := ADR(x);
pd := pv;
got := pd^;
sizes := SIZEOF(xi) + SIZEOF(ux) + SIZEOF(xw) + SIZEOF(pv);
END_PROGRAM
`;

describeIfGpp("platform_types — generated C++", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-platform-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function run(opts: Partial<CompileOptions>, name: string): string[] {
    const result = compile(SOURCE, {
      headerFileName: "generated.hpp",
      ...opts,
    });
    expect(result.errors.map((e) => `${e.line}: ${e.message}`)).toEqual([]);
    return compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: name,
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p; p.run();\n std::cout << (long long)p.XI.get() << " " << (unsigned long long)p.UX.get() << " " << (unsigned long long)p.XW.get() << " " << (long long)p.GOT.get() << " " << (unsigned long long)p.SIZES.get();\n return 0;\n}\n`,
    })
      .trim()
      .split(/\s+/);
  }

  const EXPECTED = [
    "-6000000000",
    "1099511627776",
    "1099511627776",
    "42",
    "32",
  ];

  it("runs under a profile with the feature", () => {
    expect(run({ dialect: PROFILE }, "platform_profile")).toEqual(EXPECTED);
  });

  it("runs with --feature, under --strict too", () => {
    const features = ["+platform_types"];
    expect(run({ features }, "platform_flag")).toEqual(EXPECTED);
    expect(run({ features, strict: true }, "platform_strict")).toEqual(
      EXPECTED,
    );
  });

  it("is refused without the feature", () => {
    const r = compile(SOURCE, { dialect: "iec-3", features: ["+pointer_to"] });
    const messages = r.errors.map((e) => e.message);
    for (const name of ["XINT", "__UXINT", "XWORD", "PVOID"]) {
      expect(messages).toContain(`${name} needs the feature platform_types`);
    }
  });
});
