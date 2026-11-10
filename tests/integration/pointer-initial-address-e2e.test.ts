/**
 * E2E: `p : POINTER TO T := ADR(x);` as an initial value under pointer_to,
 * for a PROGRAM or FB member, a FUNCTION or METHOD local and a global. The
 * pointer is bound when its holder is created. A target that would not exist
 * yet where the pointer is created (a later local of the same FUNCTION or
 * METHOD, a later global) is refused.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `
TYPE ST_A : STRUCT x : INT; END_STRUCT END_TYPE
VAR_GLOBAL
  gx : INT := 5;
  gp : POINTER TO INT := ADR(gx);
  ga : ARRAY[0..2] OF INT := [10, 20, 30];
  gpa : POINTER TO INT := ADR(ga[2]);
END_VAR
FUNCTION_BLOCK FB_M
VAR_INPUT pin : POINTER TO INT := ADR(gx); END_VAR
VAR
  pv : POINTER TO INT := ADR(v);
  v : INT := 3;
  pg : POINTER TO INT := ADR(gx);
END_VAR
VAR_OUTPUT o : INT; END_VAR
METHOD M : INT
VAR t : INT := 4; pt : POINTER TO INT := ADR(t); pm : POINTER TO INT := ADR(v); END_VAR
  pt^ := pt^ + 1;
  M := pt^ + pm^;
END_METHOD
  pv^ := pv^ + 1;
  o := v + pg^ + pin^;
END_FUNCTION_BLOCK
FUNCTION F : INT
VAR_INPUT a : INT; END_VAR
VAR l : INT := 9; pl : POINTER TO INT := ADR(l); pa : POINTER TO INT := ADR(a); END_VAR
  pl^ := pl^ + 1;
  F := pl^ + pa^;
END_FUNCTION
PROGRAM Main
VAR
  p : POINTER TO INT := ADR(x);
  x : INT := 7; s : ST_A; str : STRING := 'abc';
  ps : POINTER TO ST_A := ADR(s);
  pf : POINTER TO INT := ADR(s.x);
  pstr : POINTER TO STRING := ADR(str);
  pfb : POINTER TO FB_M := ADR(fb);
  fb : FB_M; fbs : ARRAY[0..1] OF FB_M;
  n1, n2, n3, n4, n5, n6, n7 : INT;
END_VAR
VAR_EXTERNAL gp : POINTER TO INT; gpa : POINTER TO INT; END_VAR
  p^ := p^ + 1;
  n1 := x;
  ps^.x := 11; pf^ := pf^ + 1;
  n2 := s.x;
  pstr^ := 'abcdef';
  n3 := LEN(str);
  fb();
  n4 := pfb^.o;
  n5 := fb.M() + F(100);
  gp^ := gp^ + 1;
  n6 := gp^ + gpa^;
  fbs[1]();
  fbs[1]();
  n7 := fbs[1].o + fbs[0].o;
END_PROGRAM
`;

const MODES: Array<[string, Parameters<typeof compile>[1]]> = [
  ["no flags", {}],
  ["strict", { strict: true }],
  [
    "strict vendor profile",
    {
      strict: true,
      dialect: {
        id: "vendor-x",
        name: "Vendor X",
        extends: "iec-3",
        features: ["pointer_to"],
        semantics: {},
      },
    },
  ],
];

function errorsFor(source: string): string[] {
  return compile(source, {}).errors.map((e) => e.message);
}

describe("POINTER TO initial address", () => {
  it.each(MODES)("is accepted (%s)", (_name, options) => {
    expect(compile(SOURCE, options).errors.map((e) => e.message)).toEqual([]);
  });

  it("is refused under iec-3 with POINTER TO itself", () => {
    const messages = new Set(
      compile(SOURCE, { dialect: "iec-3" }).errors.map((e) => e.message),
    );
    expect(messages).toEqual(
      new Set([
        "POINTER TO needs the feature pointer_to",
        "ADR needs the feature pointer_to",
      ]),
    );
  });

  it("refuses a later local of the same FUNCTION or METHOD", () => {
    expect(
      errorsFor(`FUNCTION F : INT
VAR pl : POINTER TO INT := ADR(l); l : INT; END_VAR
  F := pl^;
END_FUNCTION`),
    ).toEqual([
      "The initial value of 'PL' takes the address of 'L', which is declared after it; declare 'L' first or assign 'PL' in the body",
    ]);
    expect(
      errorsFor(`FUNCTION_BLOCK FB
METHOD M : INT
VAR pm : POINTER TO INT := ADR(t.x); t : ST; END_VAR
  M := pm^;
END_METHOD
END_FUNCTION_BLOCK
TYPE ST : STRUCT x : INT; END_STRUCT END_TYPE`),
    ).toEqual([
      "The initial value of 'PM' takes the address of 'T', which is declared after it; declare 'T' first or assign 'PM' in the body",
    ]);
  });

  it("refuses a later global", () => {
    expect(
      errorsFor(`VAR_GLOBAL
  gq : POINTER TO INT := ADR(glater);
  glater : INT;
END_VAR
PROGRAM Main END_PROGRAM`),
    ).toEqual([
      "The initial value of 'GQ' takes the address of 'GLATER', which is declared after it; declare 'GLATER' first or assign 'GQ' in the body",
    ]);
  });

  it("refuses the address of the pointer itself", () => {
    expect(
      errorsFor(`FUNCTION F : INT
VAR pp : POINTER TO POINTER TO INT := ADR(pp); END_VAR
END_FUNCTION`),
    ).toEqual([
      "The initial value of 'PP' takes the address of 'PP', which is declared after it; declare 'PP' first or assign 'PP' in the body",
    ]);
  });

  it("still refuses a REF_TO initial value and a non-address pointer value", () => {
    const decl = (d: string): string[] =>
      errorsFor(
        `PROGRAM Main\nVAR x : INT; q : POINTER TO INT; ${d} END_VAR\nEND_PROGRAM`,
      );
    expect(decl("r : REF_TO INT := REF(x);")).toEqual([
      "REF_TO initializers are not supported; assign 'R' in the body instead",
    ]);
    expect(decl("p : POINTER TO INT := q;")).toEqual([
      "POINTER TO initializers are not supported; assign 'P' in the body instead",
    ]);
  });

  it("reports an unknown target", () => {
    expect(
      errorsFor(
        `PROGRAM Main\nVAR p : POINTER TO INT := ADR(nope); END_VAR\nEND_PROGRAM`,
      ),
    ).toEqual(["Undeclared variable 'NOPE'"]);
  });
});

describe.skipIf(!hasGpp)("POINTER TO initial address end to end", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-ptrinit-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it.each(MODES)("builds and runs (%s)", (name, options) => {
    const r = compile(SOURCE, { ...options, headerFileName: "generated.hpp" });
    expect(r.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: r.headerCode,
      cppCode: r.cppCode,
      testName: `pointer_init_${name.replace(/ /g, "_")}`,
      mainCode: `#include <iostream>
int main() {
  strucpp::Program_MAIN p;
  p.run();
  std::cout << (int)p.N1 << " " << (int)p.N2 << " " << (int)p.N3 << " "
            << (int)p.N4 << " " << (int)p.N5 << " " << (int)p.N6 << " "
            << (int)p.N7 << std::endl;
  return 0;
}
`,
    });
    expect(out).toBe("8 12 6 14 119 36 17");
  });
});
