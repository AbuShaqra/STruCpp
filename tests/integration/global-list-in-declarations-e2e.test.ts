/**
 * E2E: a list-qualified global (`GVL_A.x`, feature named_global_lists) in a
 * declaration: an initial value, an array literal, and the init argument
 * list of an FB instance (feature fb_init), in a PROGRAM, an FB, a METHOD, a
 * FUNCTION and a VAR_GLOBAL. It resolves as it does in a POU body.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const GVL_IO = `VAR_GLOBAL
  bOut : BOOL;
  bOut2 : BOOL;
  level : INT := 3;
END_VAR
VAR_GLOBAL CONSTANT
  K : INT := 7;
END_VAR
`;

const GVL_B = `VAR_GLOBAL
  level : INT := 40;
END_VAR
`;

const MAIN = `FUNCTION_BLOCK FB_Cylinder
VAR r : REFERENCE TO BOOL; END_VAR
VAR_OUTPUT start : INT; END_VAR
METHOD FB_init : BOOL
VAR_INPUT bInitRetains : BOOL; bInCopyCode : BOOL; refOut : REFERENCE TO BOOL; n : INT; END_VAR
  r REF= refOut;
  start := n;
END_METHOD
  r := TRUE;
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Holder
VAR
  inner : FB_Cylinder(refOut := GVL_Io.bOut2, n := GVL_Io.K + 1);
  seed : INT := GVL_Io.K * 2;
END_VAR
METHOD M : INT
VAR t : INT := GVL_B.level; END_VAR
  M := t + seed;
END_METHOD
  inner();
END_FUNCTION_BLOCK
FUNCTION F : INT
VAR t : INT := GVL_Io.K; END_VAR
  F := t + 1;
END_FUNCTION
VAR_GLOBAL
  gCyl : FB_Cylinder(refOut := GVL_Io.bOut, n := GVL_Io.K);
  gSeed : INT := 107;
END_VAR
PROGRAM Main
VAR
  level : INT := 500;
  fbCyl : FB_Cylinder(refOut := GVL_Io.bOut, n := GVL_Io.K + GVL_Io.level);
  h : FB_Holder;
  n1 : INT := GVL_Io.K;
  n2 : INT := GVL_Io.level + GVL_B.level;
  a : ARRAY[0..1] OF INT := [GVL_Io.K, 2];
  n3, n4, n5, n6 : INT;
  b1, b2 : BOOL;
END_VAR
VAR_EXTERNAL gCyl : FB_Cylinder; gSeed : INT; END_VAR
  b1 := GVL_Io.bOut;
  fbCyl();
  b2 := GVL_Io.bOut;
  h();
  n3 := h.M();
  n4 := F() + a[0];
  n5 := fbCyl.start + gCyl.start;
  n6 := gSeed + level;
END_PROGRAM
`;

const SOURCES = {
  fileName: "main.st",
  additionalSources: [
    { source: GVL_IO, fileName: "GVL_Io.st" },
    { source: GVL_B, fileName: "GVL_B.st" },
  ],
};

const VENDOR = {
  id: "vendor-x",
  name: "Vendor X",
  extends: "iec-3",
  features: [
    "named_global_lists" as const,
    "fb_init" as const,
    "reference_to" as const,
    "ref_assign" as const,
  ],
  semantics: {},
};

const MODES: Array<[string, Parameters<typeof compile>[1]]> = [
  ["features", { features: ["+named_global_lists", "+fb_init"] }],
  ["strict", { strict: true, features: ["+named_global_lists", "+fb_init"] }],
  ["strict vendor profile", { strict: true, dialect: VENDOR }],
];

describe("a list-qualified global in a declaration", () => {
  it.each(MODES)("is resolved (%s)", (_name, options) => {
    const r = compile(MAIN, { ...SOURCES, ...options });
    expect(r.errors.map((e) => e.message)).toEqual([]);
  });

  it("needs named_global_lists, as in a body", () => {
    const r = compile(MAIN, { ...SOURCES, features: ["+fb_init"] });
    const messages = new Set(r.errors.map((e) => e.message));
    expect(messages).toContain(
      "Global variable list access 'GVL_Io.K' needs the feature named_global_lists",
    );
    expect([...messages].some((m) => m.startsWith("Undeclared"))).toBe(false);
  });

  it("reports a name the list does not declare", () => {
    const r = compile(
      `PROGRAM Main\nVAR n : INT := GVL_Io.nope; END_VAR\nEND_PROGRAM\n`,
      { ...SOURCES, features: ["+named_global_lists"] },
    );
    expect(r.errors.map((e) => e.message)).toEqual([
      "'NOPE' is not a variable of global variable list 'GVL_Io'",
    ]);
  });
});

describe.skipIf(!hasGpp)(
  "a list-qualified global in a declaration, run",
  () => {
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-gvldecl-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    it.each(MODES)("builds and runs (%s)", (name, options) => {
      const r = compile(MAIN, {
        ...SOURCES,
        ...options,
        headerFileName: "generated.hpp",
      });
      expect(r.errors).toEqual([]);
      const out = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: r.headerCode,
        cppCode: r.cppCode,
        testName: `gvl_decl_${name.replace(/ /g, "_")}`,
        mainCode: `#include <iostream>
int main() {
  strucpp::Program_MAIN p;
  p.run();
  std::cout << (int)p.N1 << " " << (int)p.N2 << " " << (int)p.N3 << " "
            << (int)p.N4 << " " << (int)p.N5 << " " << (int)p.N6 << " "
            << (bool)p.B1 << (bool)p.B2 << std::endl;
  return 0;
}
`,
      });
      expect(out).toBe("7 43 54 15 17 607 01");
    });
  },
);
