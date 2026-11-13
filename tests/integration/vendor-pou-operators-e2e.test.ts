/**
 * __POUNAME, __POSITION and BITADR end to end (g++): the program runs and
 * prints the names, positions and bit addresses it was given.
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
  features: ["vendor_operators"],
  semantics: {},
};

const SOURCE = `FUNCTION_BLOCK Fb_Motor
VAR_OUTPUT own, viaMethod, viaAction : STRING; END_VAR
METHOD Name : STRING
Name := __POUNAME();
END_METHOD
own := __POUNAME();
viaMethod := Name();
Spin();
ACTION Spin:
viaAction := __POUNAME();
END_ACTION
END_FUNCTION_BLOCK
PROGRAM Main
VAR
  inBit AT %IX2.3 : BOOL;
  outWord AT %QW4 : WORD;
  mem AT %MB7 : BYTE;
  decl : STRING := __POSITION();
  impl, prog : STRING;
  a1, a2, a3 : DWORD;
  fb : Fb_Motor;
END_VAR
impl := __POSITION();
prog := __POUNAME();
a1 := BITADR(inBit);
a2 := BITADR(outWord);
a3 := BITADR(mem);
fb();
END_PROGRAM
`;

describeIfGpp("__POUNAME, __POSITION and BITADR — generated C++", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-pouops-"));
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
    const s = (v: string): string =>
      `std::cout << p.${v}.get().c_str() << "|";`;
    const h = (v: string): string =>
      `std::cout << std::hex << (unsigned long)p.${v}.get() << "|";`;
    return compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: name,
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p; p.run();\n ${[s("DECL"), s("IMPL"), s("PROG"), s("FB.OWN"), s("FB.VIAMETHOD"), s("FB.VIAACTION"), h("A1"), h("A2"), h("A3")].join(" ")}\n return 0;\n}\n`,
    })
      .trim()
      .split("|")
      .filter((x) => x !== "");
  }

  const EXPECTED = [
    "Line 18 (Decl)",
    "Line 23, Column 9 (Impl)",
    "Main",
    "Fb_Motor",
    "Fb_Motor.Name",
    "Fb_Motor.Spin",
    "80000013",
    "c0000020",
    "40000038",
  ];

  it("runs under a profile with the feature", () => {
    expect(run({ dialect: PROFILE }, "pouops_profile")).toEqual(EXPECTED);
  });

  it("runs with --feature, under --strict too", () => {
    const features = ["+vendor_operators"];
    expect(run({ features }, "pouops_flag")).toEqual(EXPECTED);
    expect(run({ features, strict: true }, "pouops_strict")).toEqual(EXPECTED);
  });

  it("is refused without the feature", () => {
    const r = compile(SOURCE, { dialect: "iec-3" });
    expect(r.errors.map((e) => e.message)).toContain(
      "BITADR needs the feature vendor_operators",
    );
    expect(r.errors.map((e) => e.message)).toContain(
      "__POUNAME needs the feature vendor_operators",
    );
  });
});
