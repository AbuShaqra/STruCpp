/**
 * __ISVALIDREF and XSIZEOF end to end (g++): the program runs and reports
 * whether its references are bound and the sizes XSIZEOF gives.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile, type CompileOptions } from "../../src/index.js";
import type { DialectProfile } from "../../src/dialect.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const VENDOR: DialectProfile = {
  id: "twincat3",
  name: "twincat3",
  extends: "iec-3",
  features: ["pointer_to", "reference_to", "ref_assign", "vendor_operators"],
  semantics: {},
};

describeIfGpp("__ISVALIDREF and XSIZEOF — generated C++", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-vendorops-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const ISVALIDREF = `TYPE ST_P : STRUCT a : INT; b : LREAL; END_STRUCT; END_TYPE
FUNCTION_BLOCK FB_R
VAR_INPUT rIn : REFERENCE TO INT; END_VAR
VAR_OUTPUT ok : BOOL; END_VAR
ok := __ISVALIDREF(rIn);
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR
  x : INT := 5;
  r : REFERENCE TO INT;
  rs : REFERENCE TO ST_P;
  s : ST_P;
  b1, b2, b3, b4, b5 : BOOL;
  fb : FB_R;
END_VAR
b1 := __ISVALIDREF(r);
r REF= x;
b2 := __ISVALIDREF(r);
b3 := __ISVALIDREF(rs);
rs REF= s;
b4 := __ISVALIDREF(rs) AND b2;
b5 := fb.ok;
fb(rIn := x);
END_PROGRAM
`;

  const XSIZEOF = `TYPE ST_P : STRUCT a : LINT; b : LREAL; END_STRUCT; END_TYPE
PROGRAM MAIN
VAR
  arr : ARRAY[0..4] OF INT;
  s : ST_P;
  l : LREAL;
  n1 : ULINT := XSIZEOF(arr);
  n2, n3 : ULINT;
END_VAR
n2 := XSIZEOF(l);
n3 := XSIZEOF(s.a) + SIZEOF(s.b);
END_PROGRAM
`;

  function run(
    source: string,
    opts: Partial<CompileOptions>,
    vars: string[],
    name: string,
  ): string[] {
    const result = compile(source, {
      headerFileName: "generated.hpp",
      ...opts,
    });
    expect(result.errors.map((e) => `${e.line}: ${e.message}`)).toEqual([]);
    const prints = vars
      .map((v) => `std::cout << (unsigned long long)p.${v}.get() << " ";`)
      .join(" ");
    return compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: name,
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p; p.run(); p.run();\n ${prints}\n return 0;\n}\n`,
    })
      .trim()
      .split(/\s+/);
  }

  it("__ISVALIDREF tells a bound reference from an unbound one", () => {
    // Second cycle: r and rs stay bound from the first.
    const expected = ["1", "1", "1", "1", "1"];
    const vars = ["B1", "B2", "B3", "B4", "B5"];
    expect(run(ISVALIDREF, {}, vars, "isvalidref_default")).toEqual(expected);
    expect(run(ISVALIDREF, { dialect: VENDOR }, vars, "isvalidref_v")).toEqual(
      expected,
    );
  });

  it("__ISVALIDREF is FALSE before the first binding", () => {
    const once = ISVALIDREF.replace(
      "b1 := __ISVALIDREF(r);",
      "b1 := __ISVALIDREF(r) OR b1;",
    );
    const result = compile(once, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "isvalidref_first",
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p; p.run();\n std::cout << (int)p.B1.get() << " " << (int)p.B3.get() << " " << (int)p.B2.get() << " " << (int)p.B5.get();\n return 0;\n}\n`,
    });
    // b5 reads fb.ok before fb's first call.
    expect(out.trim().split(/\s+/)).toEqual(["0", "0", "1", "0"]);
  });

  it("XSIZEOF gives SIZEOF's byte count as a ULINT", () => {
    for (const [opts, name] of [
      [{ features: ["+vendor_operators"] }, "xsizeof_default"],
      [{ features: ["+vendor_operators"], strict: true }, "xsizeof_strict"],
      [{ dialect: VENDOR }, "xsizeof_vendor"],
    ] as [Partial<CompileOptions>, string][]) {
      expect(run(XSIZEOF, opts, ["N1", "N2", "N3"], name)).toEqual([
        "10",
        "8",
        "16",
      ]);
    }
  });

  it("works in global initial values and on THIS members", () => {
    const src = `VAR_GLOBAL g : LREAL; gn : ULINT := XSIZEOF(g); x : INT; r : REFERENCE TO INT; gb : BOOL := __ISVALIDREF(r); END_VAR
VAR_GLOBAL CONSTANT C : ULINT := XSIZEOF(g); END_VAR
FUNCTION_BLOCK FB_A
VAR rr : REFERENCE TO INT; y : INT; END_VAR
VAR_OUTPUT q0, q1, q2 : BOOL; END_VAR
q0 := __ISVALIDREF(THIS.rr);
rr REF= y;
q1 := __ISVALIDREF(THIS.rr);
q2 := __ISVALIDREF(THIS^.rr);
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR f : FB_A; n : ULINT; b : BOOL; END_VAR
n := gn + C;
b := gb;
f();
END_PROGRAM
`;
    const result = compile(src, {
      headerFileName: "generated.hpp",
      features: ["+vendor_operators", "+self_caret"],
    });
    expect(result.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "vendorops_globals_this",
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p; p.run();\n std::cout << (unsigned long long)p.N.get() << " " << (int)p.B.get() << " " << (int)p.F.Q0.get() << " " << (int)p.F.Q1.get() << " " << (int)p.F.Q2.get();\n return 0;\n}\n`,
    });
    expect(out.trim().split(/\s+/)).toEqual(["16", "0", "0", "1", "1"]);
  });

  it("XSIZEOF is refused without the feature", () => {
    const result = compile(XSIZEOF, { dialect: "iec-3" });
    expect(result.errors.map((e) => e.message)).toContain(
      "XSIZEOF needs the feature vendor_operators",
    );
  });
});
