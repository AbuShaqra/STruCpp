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
import {
  loadStlibArchive,
  registerLibrarySymbols,
} from "../../src/library/library-loader.js";
import { SymbolTables } from "../../src/semantic/symbol-table.js";
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

describe("library enumeration values in the symbol table", () => {
  it("record each value, one after an explicit value counting on from it", () => {
    const lib = compileStlib(
      [
        {
          source: "TYPE E_X : (X1 := 5, X2, X3 := 10, X4); END_TYPE",
          fileName: "e.st",
        },
      ],
      { name: "lval", version: "1.0.0", namespace: "lval" },
    );
    expect(lib.errors).toEqual([]);
    const tables = new SymbolTables();
    registerLibrarySymbols(
      loadStlibArchive(JSON.parse(JSON.stringify(lib.archive))).manifest,
      tables,
    );
    const value = (n: string): number | undefined => {
      const sym = tables.globalScope.lookup(n);
      return sym?.kind === "enumValue" ? sym.value : undefined;
    };
    expect(["X1", "X2", "X3", "X4"].map(value)).toEqual([5, 6, 10, 11]);
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

  it("lets the sources' globals, constants and enumeration values win over a library's enumeration values", () => {
    // plcopen-softmotion's SMC_AXIS_STATE has STOPPING, HOMING, POWER_OFF, STANDSTILL
    const { stdout } = run(
      `VAR_GLOBAL STOPPING : BOOL := TRUE; Red : INT := 3; END_VAR
VAR_GLOBAL CONSTANT HOMING : INT := 7; END_VAR
TYPE E_State : (IDLE, POWER_OFF, RUNNING); END_TYPE
PROGRAM Main
VAR r : INT; e : E_State; ax : SMC_AXIS_STATE; c : E_C; END_VAR
IF STOPPING THEN r := HOMING + Red; END_IF
e := POWER_OFF;
IF e = E_State#POWER_OFF THEN r := r + 10; END_IF
ax := STANDSTILL;
IF ax = SMC_AXIS_STATE#STANDSTILL THEN r := r + 100; END_IF
c := Green;
IF c = E_C#Green THEN r := r + 1000; END_IF
END_PROGRAM
`,
      "p.R",
      "libtypes_names_win",
    );
    expect(stdout).toBe("1120");
  });

  it("starts a library enumeration at its declared default or first value, in every kind of variable", () => {
    const lib = compileStlib(
      [
        {
          source: `TYPE E_T : INT (T1 := 1, T2 := 4) := T2; END_TYPE
TYPE E_X : (X1 := 5, X2, X3 := 10, X4); END_TYPE
TYPE S_L : STRUCT x : E_X; END_STRUCT END_TYPE
FUNCTION_BLOCK FB_L VAR_OUTPUT o : E_X; t : E_T; END_VAR END_FUNCTION_BLOCK
`,
          fileName: "e.st",
        },
      ],
      { name: "ldef", version: "1.0.0", namespace: "ldef" },
    );
    expect(lib.errors).toEqual([]);
    const archive = JSON.parse(JSON.stringify(lib.archive)) as StlibArchive;
    expect(
      archive.manifest.types.find((t) => t.name === "E_T")?.defaultMember,
    ).toBe("T2");
    const { stdout } = run(
      `TYPE S_U : STRUCT x : E_X; t : E_T; END_STRUCT END_TYPE
PROGRAM Main
VAR r : DINT; t : E_T; x : E_X; sl : S_L; su : S_U; a : ARRAY[1..2] OF E_X; fb : FB_L; END_VAR
IF t = E_T#T2 THEN r := 1; END_IF
IF x = E_X#X1 THEN r := r + 10; END_IF
IF sl.x = E_X#X1 THEN r := r + 100; END_IF
IF su.x = E_X#X1 THEN r := r + 1000; END_IF
IF su.t = E_T#T2 THEN r := r + 10000; END_IF
IF a[2] = E_X#X1 THEN r := r + 100000; END_IF
IF fb.o = E_X#X1 THEN r := r + 1000000; END_IF
IF fb.t = E_T#T2 THEN r := r + 10000000; END_IF
x := X4;
IF x = E_X#X4 THEN r := r + 100000000; END_IF
END_PROGRAM
`,
      "p.R",
      "libtypes_enum_default",
      [archive],
    );
    expect(stdout).toBe("111111111");
  });

  it("binds a VAR_IN_OUT a library block inherits from its library base", () => {
    const lib = compileStlib(
      [
        {
          source: `FUNCTION_BLOCK FB_BASE
VAR_INPUT a : INT; END_VAR
VAR_OUTPUT q : INT; END_VAR
VAR_IN_OUT io : INT; END_VAR
q := a + io;
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_DER EXTENDS FB_BASE
VAR_INPUT b : INT; END_VAR
q := a + b + io;
io := io + 1;
END_FUNCTION_BLOCK
`,
          fileName: "fb.st",
        },
      ],
      { name: "linh", version: "1.0.0", namespace: "linh" },
    );
    expect(lib.errors).toEqual([]);
    const { stdout } = run(
      `FUNCTION_BLOCK FB_U EXTENDS FB_DER
VAR_INPUT u : INT; END_VAR
q := a + b + u + io;
END_FUNCTION_BLOCK
PROGRAM Main
VAR f : FB_DER; g : FB_U; q1 : INT; s : INT; x : INT := 100; r : DINT; END_VAR
f(a := 1, b := 2, io := x, q => q1);
g(a := 1, b := 2, u := 3, io := x, q => s);
r := q1 * 1000 + s + x;
END_PROGRAM
`,
      "p.R",
      "libtypes_inherited_inout",
      [JSON.parse(JSON.stringify(lib.archive)) as StlibArchive],
    );
    expect(stdout).toBe(String(103 * 1000 + 107 + 101));
  });

  it("starts a variable of a library alias TYPE at its default", () => {
    const lib = compileStlib(
      [
        {
          source: `TYPE LTA : TIME := LTIME#2s; END_TYPE
TYPE LTB : TIME := T#3s; END_TYPE
TYPE LIA : INT := 5; END_TYPE
TYPE LEA : (Q1, Q2, Q3) := Q3; END_TYPE
TYPE LEB : LEA := Q2; END_TYPE
`,
          fileName: "a.st",
        },
      ],
      { name: "lalias", version: "1.0.0", namespace: "lalias" },
    );
    expect(lib.errors).toEqual([]);
    const archive = JSON.parse(JSON.stringify(lib.archive)) as StlibArchive;
    const type = (n: string) =>
      archive.manifest.types.find((t) => t.name === n);
    expect(type("LIA")?.defaultValue).toBe("5");
    expect(type("LEB")?.defaultValue).toBe("LEA#Q2");
    expect(type("LTA")?.defaultValue).toBe("LTIME_TO_TIME(LTIME#2S)");
    const { stdout, warnings } = run(
      `TYPE S_U : STRUCT b : LTB; i : LIA; f : LEB; END_STRUCT END_TYPE
PROGRAM Main
VAR x : LTA; y : LTB; z : LIA; e : LEA; f : LEB; s : S_U; a : ARRAY[0..1] OF LIA; r : DINT; END_VAR
r := TIME_TO_DINT(x) + TIME_TO_DINT(y) + z * 100000;
IF e = LEA#Q3 THEN r := r + 1000000; END_IF
IF f = LEA#Q2 THEN r := r + 10000000; END_IF
IF s.f = LEA#Q2 AND s.i = 5 AND TIME_TO_DINT(s.b) = 3000 AND a[1] = 5 THEN r := r + 100000000; END_IF
END_PROGRAM
`,
      "p.R",
      "libtypes_alias_defaults",
      [archive],
    );
    expect(stdout).toBe("111505000");
    expect(warnings).toEqual([]);
  });

  it("picks a library enumeration's value by its typed context when the sources have one of the name", () => {
    const lib = compileStlib(
      [
        {
          source: "TYPE LColor : (Red, Green, Blue); END_TYPE",
          fileName: "c.st",
        },
      ],
      { name: "lcolor", version: "1.0.0", namespace: "lcolor" },
    );
    expect(lib.errors).toEqual([]);
    const { stdout } = run(
      `TYPE U1 : (Red := 20, Pink); END_TYPE
PROGRAM Main
VAR c : LColor := Red; u : U1; r : INT; END_VAR
u := Red;
IF c = LColor#Red THEN r := 1; END_IF
IF u = U1#Red THEN r := r + 10; END_IF
c := Blue;
c := Red;
IF c = LColor#Red THEN r := r + 100; END_IF
END_PROGRAM
`,
      "p.R",
      "libtypes_enum_context",
      [JSON.parse(JSON.stringify(lib.archive)) as StlibArchive],
    );
    expect(stdout).toBe("111");
  });

  it("reports a VAR_IN_OUT inherited from a library block that a call leaves unassigned", () => {
    const lib = compileStlib(
      [
        {
          source: `FUNCTION_BLOCK LBase
VAR_IN_OUT io : INT; END_VAR
VAR_INPUT k : INT; END_VAR
io := io + k;
END_FUNCTION_BLOCK
`,
          fileName: "b.st",
        },
      ],
      { name: "lbase", version: "1.0.0", namespace: "lbase" },
    );
    expect(lib.errors).toEqual([]);
    const src = `FUNCTION_BLOCK D EXTENDS LBase END_FUNCTION_BLOCK
PROGRAM Main VAR d : D; END_VAR
d(k := 2);
END_PROGRAM
`;
    const libraries = [
      ...LIBS,
      loadStlibArchive(JSON.parse(JSON.stringify(lib.archive))),
    ];
    expect(compile(src, { libraries }).warnings.map((w) => w.message)).toEqual([
      "VAR_IN_OUT 'IO' is not assigned in this call; the call keeps the binding of the previous call",
    ]);
    expect(
      compile(src, { libraries, dialect: "iec-3" }).errors.map(
        (e) => e.message,
      ),
    ).toEqual(["VAR_IN_OUT 'IO' is not assigned in this call"]);
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
