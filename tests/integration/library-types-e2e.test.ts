// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: a library's types used from a consumer, the archive serialized and
 * loaded back. Enumeration values (`E#X`, `E.X`, bare), a STRUCT alias
 * result, a STRUCT field and a global of a library STRUCT, an ARRAY TYPE, a
 * REF_TO alias, STRUCT ARRAY and POINTER TO fields, a STRING(254) in/out
 * given a STRING(80), a STRING(n) result, an FB extending TON with an LTIME
 * preset, and an archive written before these were recorded. g++ and run.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile, compileStlib } from "../../src/index.js";
import { loadStlibArchive } from "../../src/library/library-loader.js";
import { discoverStlibs } from "../../src/node/library-loader.js";
import type { StlibArchive } from "../../src/library/library-manifest.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const LIBS = discoverStlibs(path.resolve(__dirname, "../../libs"));

const LIB = `TYPE E_C : (Red, Green, Blue); END_TYPE
TYPE E_V : DINT (V1 := 5, V2 := -7); END_TYPE
TYPE S_B : STRUCT a : INT; END_STRUCT END_TYPE
TYPE S_A : S_B; END_TYPE
TYPE A_I : ARRAY[1..3] OF INT; END_TYPE
TYPE R_I : REF_TO INT; END_TYPE
TYPE S_X : STRUCT arr : ARRAY[0..3] OF BYTE; p : POINTER TO INT; END_STRUCT END_TYPE

FUNCTION F_E : INT
VAR_INPUT e : E_C; END_VAR
CASE e OF Red: F_E := 1; Green: F_E := 2; Blue: F_E := 3; END_CASE
END_FUNCTION

FUNCTION F_A : S_A
VAR_INPUT x : INT; END_VAR
F_A.a := x;
END_FUNCTION

FUNCTION F_Sum : INT
VAR_INPUT a : A_I; END_VAR
F_Sum := a[1] + a[2] + a[3];
END_FUNCTION

FUNCTION F_S : INT
VAR_IN_OUT s : STRING(254); END_VAR
s := CONCAT(s, 'x');
F_S := LEN(s);
END_FUNCTION

FUNCTION_BLOCK FB_S
METHOD M : INT
VAR_IN_OUT s : STRING(254); END_VAR
s := CONCAT(s, 'y');
M := LEN(s);
END_METHOD
END_FUNCTION_BLOCK

FUNCTION F_R5 : STRING(5)
F_R5 := 'abcdefgh';
END_FUNCTION
`;

function library(): StlibArchive {
  const lib = compileStlib([{ source: LIB, fileName: "lib.st" }], {
    name: "ltypes",
    version: "1.0.0",
    namespace: "ltypes",
    dependencies: LIBS,
  });
  expect(lib.errors).toEqual([]);
  return JSON.parse(JSON.stringify(lib.archive)) as StlibArchive;
}

const MAIN = (expr: string): string => `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << ${expr} << std::endl;
    return 0;
}
`;

describe("library types from a consumer", () => {
  it("records enumeration values, shapes and result lengths in the manifest", () => {
    const m = library().manifest;
    const type = (n: string) => m.types.find((t) => t.name === n);
    expect(type("E_C")?.members).toEqual([
      { name: "RED" },
      { name: "GREEN" },
      { name: "BLUE" },
    ]);
    expect(type("E_V")).toMatchObject({
      baseType: "DINT",
      members: [
        { name: "V1", value: 5 },
        { name: "V2", value: -7 },
      ],
    });
    expect(type("A_I")).toMatchObject({
      arrayDimensions: [{ start: 1, end: 3 }],
      elementTypeName: "INT",
    });
    expect(type("R_I")).toMatchObject({ refTarget: "INT" });
    expect(type("S_X")?.fields).toEqual([
      {
        name: "ARR",
        type: "__INLINE_ARRAY_BYTE",
        arrayDimensions: [{ start: 0, end: 3 }],
        elementTypeName: "BYTE",
      },
      { name: "P", type: "INT", referenceKind: "pointer_to" },
    ]);
    expect(m.functions.find((f) => f.name === "F_R5")?.returnMaxLength).toBe(5);
    expect(m.stNamespace).toBe("ltypes");
  });
});

describe.skipIf(!hasGpp)("library types from a consumer — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-libtypes-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const run = (
    source: string,
    print: string,
    name: string,
    archives: StlibArchive[] = [library()],
  ): { stdout: string; warnings: string[] } => {
    const result = compile(source, {
      headerFileName: "generated.hpp",
      libraries: [...LIBS, ...archives.map((a) => loadStlibArchive(a))],
    });
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: name,
      mainCode: MAIN(print),
    });
    return { stdout, warnings: result.warnings.map((w) => w.message) };
  };

  it("uses a library's enumeration values: E#X, E.X and bare", () => {
    const { stdout } = run(
      `PROGRAM Main
VAR e : E_C; v : E_V := E_V#V1; r : DINT; END_VAR
e := E_C#Green;
r := F_E(e);
e := Blue;
r := r * 10 + F_E(e);
IF e = E_C.Blue THEN r := r * 10 + 1; END_IF
CASE e OF Red: r := 0; Blue: r := r * 10 + 4; END_CASE
IF v = V1 THEN r := r * 10 + 5; END_IF
v := V2;
IF v = E_V#V2 THEN r := r * 10 + 6; END_IF
END_PROGRAM
`,
      "p.R",
      "libtypes_enum",
    );
    expect(stdout).toBe("231456");
  });

  it("stores a STRUCT alias result in its STRUCT and in the alias", () => {
    const { stdout } = run(
      `PROGRAM Main
VAR s : S_B; t : S_A; r : INT; END_VAR
s := F_A(5);
t := F_A(2);
r := s.a * 10 + t.a;
END_PROGRAM
`,
      "p.R",
      "libtypes_alias",
    );
    expect(stdout).toBe("52");
  });

  it("builds a STRUCT field and a global of a library STRUCT (OSCAT COMPLEX)", () => {
    const { stdout } = run(
      `TYPE S_U : STRUCT c : COMPLEX; n : INT; END_STRUCT END_TYPE
VAR_GLOBAL g : COMPLEX; gu : S_U; END_VAR
PROGRAM Main
VAR u : S_U; r : REAL; END_VAR
u.c.RE := 1.5;
u.c := CADD(u.c, u.c);
g.RE := 2.0;
gu.c := CADD(g, g);
r := u.c.RE + gu.c.RE;
END_PROGRAM
`,
      "p.R",
      "libtypes_complex",
      [],
    );
    expect(stdout).toBe("7");
  });

  it("indexes an ARRAY TYPE, reads a REF_TO alias and STRUCT ARRAY and POINTER TO fields", () => {
    const { stdout } = run(
      `PROGRAM Main
VAR a : A_I; rr : R_I; i : INT := 4; x : S_X; r : INT; END_VAR
a[1] := 1; a[2] := 2; a[3] := 3;
rr := REF(i);
x.arr[2] := 9;
x.p := ADR(i);
r := F_Sum(a) * 1000 + rr^ * 100 + x.arr[2] * 10 + x.p^;
END_PROGRAM
`,
      "p.R",
      "libtypes_shapes",
    );
    expect(stdout).toBe("6494");
  });

  it("writes back a STRING(254) in/out given a STRING(80), and keeps a STRING(5) result's length", () => {
    const { stdout, warnings } = run(
      `PROGRAM Main
VAR s : STRING(80) := 'ab'; fb : FB_S; r : DINT; END_VAR
r := F_S(s);
r := r * 10 + fb.M(s);
r := r * 100 + LEN(s) * 10 + LEN(F_R5());
END_PROGRAM
`,
      "p.R",
      "libtypes_strings",
    );
    expect(stdout).toBe("3445");
    expect(warnings).toHaveLength(2);
  });

  it("runs an FB that extends TON with an LTIME preset, reading the inherited outputs", () => {
    const { stdout } = run(
      `FUNCTION_BLOCK FB_T EXTENDS TON
VAR_OUTPUT P : DINT; END_VAR
P := TIME_TO_DINT(PT);
END_FUNCTION_BLOCK
PROGRAM Main
VAR t : FB_T; q : BOOL; r : DINT; END_VAR
t(IN := FALSE, PT := LTIME#1500ms);
q := t.Q;
r := t.P + TIME_TO_DINT(t.ET);
IF q THEN r := -1; END_IF
END_PROGRAM
`,
      "p.R",
      "libtypes_ton",
    );
    expect(stdout).toBe("1500");
  });

  it("still loads an archive written before enumeration values and shapes were recorded", () => {
    const old = library();
    for (const t of old.manifest.types) {
      delete t.members;
      delete t.arrayDimensions;
      delete t.elementTypeName;
      delete t.refTarget;
      for (const f of t.fields ?? []) {
        delete f.arrayDimensions;
        delete f.elementTypeName;
        delete f.referenceKind;
      }
    }
    for (const f of old.manifest.functions) delete f.returnMaxLength;
    delete old.manifest.stNamespace;
    const { stdout } = run(
      `PROGRAM Main
VAR e : E_C; s : S_B; a : A_I; r : INT; END_VAR
s := F_A(4);
a[2] := 3;
r := F_E(e) * 100 + s.a * 10 + a[2];
END_PROGRAM
`,
      "p.R",
      "libtypes_old",
      [old],
    );
    expect(stdout).toBe("143");
  });
});
