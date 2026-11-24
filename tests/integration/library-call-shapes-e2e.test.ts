// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: call forms that passed the check and then failed in g++, each run the
 * same way declared in the program, from a library archive and from an older
 * archive (written before parameterShapes and stringLengthsRecorded):
 * pointer outputs captured positionally or from a library METHOD into an
 * LWORD, unbound inline-array and pointer outputs, METHOD ARRAY[*] in/outs,
 * ADR into a pointer alias, STRING(n) and REFERENCE TO STRING(n) arguments
 * to STRING in/outs of another length. g++ and run.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile, compileStlib } from "../../src/index.js";
import { loadStlibArchive } from "../../src/library/library-loader.js";
import type { StlibArchive } from "../../src/library/library-manifest.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const LIB = `TYPE PINT : POINTER TO INT; END_TYPE

FUNCTION F_One : INT
VAR_INPUT x : INT; END_VAR
VAR_OUTPUT o : POINTER TO INT; ps : POINTER TO STRING(20); END_VAR
o := ADR(x);
ps := 0;
F_One := x + 1;
END_FUNCTION

FUNCTION F_Arr : INT
VAR_INPUT x : INT; END_VAR
VAR_OUTPUT a : ARRAY[0..2] OF INT; ap : ARRAY[0..1] OF POINTER TO INT; END_VAR
a[1] := 5;
F_Arr := x + a[1];
END_FUNCTION

FUNCTION F_PI : INT
VAR_INPUT p : PINT; END_VAR
F_PI := p^ + 1;
END_FUNCTION

FUNCTION F_S : INT
VAR_IN_OUT s : STRING; END_VAR
s := CONCAT(s, 'z');
F_S := LEN(s);
END_FUNCTION

FUNCTION F_S254 : INT
VAR_IN_OUT s : STRING(254); END_VAR
s := CONCAT(s, 'z');
F_S254 := LEN(s);
END_FUNCTION

FUNCTION_BLOCK FB_M
METHOD M : DINT
VAR_IN_OUT arr : ARRAY[*] OF STRING; END_VAR
arr[0] := CONCAT(arr[0], 'q');
M := LEN(arr[0]);
END_METHOD
METHOD MI : DINT
VAR_IN_OUT arr : ARRAY[*] OF INT; END_VAR
arr[0] := arr[0] + 1;
MI := arr[0];
END_METHOD
METHOD MP : INT
VAR_INPUT x : INT; END_VAR
VAR_OUTPUT o : POINTER TO INT; ps : POINTER TO STRING(20); END_VAR
o := ADR(x);
MP := x;
END_METHOD
METHOD MS : INT
VAR_IN_OUT s : STRING(254); END_VAR
s := CONCAT(s, 'y');
MS := LEN(s);
END_METHOD
END_FUNCTION_BLOCK
`;

const PROGRAM = `PROGRAM Main
VAR
  x : INT := 4; lw, lw2, lw3, lw4 : LWORD; ul : ULINT; fb : FB_M;
  sa : ARRAY[0..1] OF STRING := ['ab', 'c']; ia : ARRAY[0..1] OF INT := [5, 6];
  s20 : STRING(20) := 'ab'; s80 : STRING(80) := 'cd'; r20 : REFERENCE TO STRING(20);
  n1, n2, n3, n4, n5, n6 : DINT;
END_VAR
n1 := F_One(x, lw, lw2);
n1 := n1 + F_One(x := x, o => ul);
n2 := F_Arr(x := x) + F_One(x := 1);
n2 := n2 * 10 + fb.MP(x, lw3, lw4) + fb.MP(x := x, o => ul);
n3 := fb.M(sa);
n3 := n3 + fb.MI(ia) * 10;
n3 := n3 + LEN(sa[0]) * 1000;
n4 := F_PI(ADR(x)) + F_PI(p := ADR(x));
r20 REF= s20;
n5 := F_S(r20);
n5 := n5 * 10 + F_S254(s80);
n5 := n5 * 10 + fb.MS(s80);
n6 := LEN(s20) * 100 + LEN(s80);
IF lw <> 0 AND lw3 <> 0 AND ul <> 0 AND lw2 = 0 THEN n6 := n6 + 10000; END_IF
END_PROGRAM
`;

const MAIN = `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.N1 << " " << p.N2 << " " << p.N3 << " " << p.N4 << " "
              << p.N5 << " " << p.N6 << std::endl;
    return 0;
}
`;

const EXPECTED = "10 118 3063 10 334 10304";

/**
 * The archive as one written before parameterShapes and stringLengthsRecorded
 * records it: pointer and array parameters of a FUNCTION by their target or
 * synthetic name, and no length of an input, a pointer target or an element.
 */
function olderArchive(archive: StlibArchive): StlibArchive {
  const old = JSON.parse(JSON.stringify(archive)) as StlibArchive;
  delete old.manifest.parameterShapes;
  delete old.manifest.stringLengthsRecorded;
  for (const fn of old.manifest.functions) {
    for (const p of fn.parameters) {
      const pointer =
        p.referenceKind === "pointer_to" || p.referenceKind === "ref_to";
      if (p.referenceKind !== "reference_to") delete p.referenceKind;
      delete p.referenceChain;
      delete p.arrayDimensions;
      delete p.elementTypeName;
      delete p.elementReferenceChain;
      delete p.elementMaxLength;
      if (p.direction === "input" || pointer) delete p.maxLength;
    }
  }
  for (const fb of old.manifest.functionBlocks) {
    for (const m of fb.methods ?? []) {
      for (const p of m.parameters) {
        if (p.referenceKind !== undefined || p.direction === "input") {
          delete p.maxLength;
        }
        delete p.elementMaxLength;
      }
    }
  }
  return old;
}

describe.skipIf(!hasGpp)("library call shapes — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  let archive: StlibArchive;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-libcalls-"));
    pchPath = createPCH(tempDir);
    const lib = compileStlib([{ source: LIB, fileName: "lib.st" }], {
      name: "calls",
      version: "1.0.0",
      namespace: "calls",
    });
    expect(lib.errors).toEqual([]);
    archive = JSON.parse(JSON.stringify(lib.archive)) as StlibArchive;
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const run = (
    source: string,
    libraries: StlibArchive[],
    name: string,
  ): string => {
    const result = compile(source, {
      headerFileName: "generated.hpp",
      libraries,
    });
    expect(result.errors).toEqual([]);
    return compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: name,
      mainCode: MAIN,
    });
  };

  it("runs the calls declared in the program", () => {
    expect(run(`${LIB}\n${PROGRAM}`, [], "libcalls_local")).toBe(EXPECTED);
  });

  it("runs the calls from a library archive", () => {
    expect(run(PROGRAM, [loadStlibArchive(archive)], "libcalls_lib")).toBe(
      EXPECTED,
    );
  });

  it("runs the calls from an older archive, its shapes read from the prototypes", () => {
    expect(
      run(PROGRAM, [loadStlibArchive(olderArchive(archive))], "libcalls_older"),
    ).toBe(EXPECTED);
  });
  it("reads, writes and offsets through a POINTER TO alias as through a POINTER TO", () => {
    const result = compile(
      `TYPE PINT : POINTER TO INT; END_TYPE
TYPE ST : STRUCT p : PINT; END_STRUCT END_TYPE
PROGRAM Main
VAR a : ARRAY[0..3] OF INT := [1, 2, 3, 4]; p : PINT; q : POINTER TO INT;
  st : ST; n1, n2, n3, n4, n5, n6 : DINT; END_VAR
p := ADR(a[0]);
p := p + 4;
n1 := p^;
p^ := 9;
q := p;
n2 := q^;
st.p := ADR(a[1]);
n3 := st.p^;
n4 := a[2];
END_PROGRAM
`,
      { headerFileName: "generated.hpp" },
    );
    expect(result.errors).toEqual([]);
    expect(
      compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: "libcalls_alias",
        mainCode: MAIN,
      }),
    ).toBe("3 9 2 9 0 0");
  });
});

const LIB2 = `TYPE PINT : POINTER TO INT; END_TYPE
FUNCTION FX : DINT
VAR_IN_OUT a : ARRAY[0..1] OF UINT; END_VAR
a[1] := a[1] + 1;
FX := a[1];
END_FUNCTION
FUNCTION FV : DINT
VAR_IN_OUT a : ARRAY[*] OF BYTE; END_VAR
a[0] := 7;
FV := 2;
END_FUNCTION
FUNCTION FO : DINT
VAR_OUTPUT o : ARRAY[0..1] OF DWORD; END_VAR
o[1] := 30;
FO := 3;
END_FUNCTION
FUNCTION FP : DINT
VAR_IN_OUT a : ARRAY[0..1] OF PINT; END_VAR
FP := a[0]^;
END_FUNCTION
FUNCTION FZ : PINT
VAR_INPUT p : PINT; END_VAR
FZ := 0;
IF p <> 0 THEN FZ := p; END_IF;
END_FUNCTION
FUNCTION_BLOCK FBO
VAR_OUTPUT o : ARRAY[0..1] OF ULINT; END_VAR
o[0] := 400;
END_FUNCTION_BLOCK
FUNCTION_BLOCK FM
METHOD MP : INT
VAR_INPUT x : INT; END_VAR
VAR_OUTPUT o : POINTER TO INT; i : INT; END_VAR
o := 0;
i := x * 2;
MP := x;
END_METHOD
END_FUNCTION_BLOCK
`;

const PROGRAM2 = `PROGRAM Main
VAR
  w : ARRAY[0..1] OF WORD := [1, 2]; u : ARRAY[0..3] OF USINT;
  d : ARRAY[0..1] OF UDINT; l : ARRAY[0..1] OF LWORD; fb : FBO;
  x : INT := 9; pa : ARRAY[0..1] OF POINTER TO INT;
  p : PINT; pz : PINT := 0; fa : ARRAY[0..1] OF FM; lw : LWORD; i : INT;
  n1, n2, n3, n4, n5, n6 : DINT;
END_VAR
n1 := FX(w) * 100 + w[1];
n2 := FV(u) + u[0] * 10;
n2 := n2 + FO(o => d) * 100 + d[1] * 1000;
fb(o => l);
n3 := l[0];
pa[0] := ADR(x);
n4 := FP(pa);
p := 0;
IF p = 0 AND pz = 0 THEN n5 := 1; END_IF;
p := FZ(0);
IF p = 0 THEN n5 := n5 + 10; END_IF;
p := FZ(ADR(x));
IF p <> 0 THEN n5 := n5 + 100; END_IF;
lw := 1;
n6 := fa[1].MP(3, lw, i) + i * 10;
IF lw = 0 THEN n6 := n6 + 1000; END_IF;
END_PROGRAM
`;

describe.skipIf(!hasGpp)(
  "array element names, pointer aliases and indexed METHOD outputs — g++ e2e",
  () => {
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-libcalls2-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    const MAIN2 = `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.N1 << " " << p.N2 << " " << p.N3 << " " << p.N4 << " "
              << p.N5 << " " << p.N6 << std::endl;
    return 0;
}
`;
    const EXPECTED2 = "303 30372 400 9 111 1063";

    const run = (
      source: string,
      libraries: StlibArchive[],
      name: string,
    ): string => {
      const result = compile(source, {
        headerFileName: "generated.hpp",
        libraries,
      });
      expect(result.errors).toEqual([]);
      return compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: name,
        mainCode: MAIN2,
      });
    };

    it("runs them declared in the program", () => {
      expect(run(`${LIB2}\n${PROGRAM2}`, [], "libcalls2_local")).toBe(
        EXPECTED2,
      );
    });

    it("runs them from a library archive", () => {
      const lib = compileStlib([{ source: LIB2, fileName: "l2.st" }], {
        name: "l2",
        version: "1.0.0",
        namespace: "l2",
      });
      expect(lib.errors).toEqual([]);
      const archive = JSON.parse(JSON.stringify(lib.archive)) as StlibArchive;
      expect(run(PROGRAM2, [loadStlibArchive(archive)], "libcalls2_lib")).toBe(
        EXPECTED2,
      );
    });
  },
);

describe.skipIf(!hasGpp)(
  "a library ARRAY[*] OF a POINTER TO alias the program never names — g++ e2e",
  () => {
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-libcalls3-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    it("builds the alias the prototype names and runs", () => {
      const lib = compileStlib(
        [
          {
            source: `TYPE PINT : POINTER TO INT; END_TYPE
FUNCTION FV : DINT
VAR_IN_OUT a : ARRAY[*] OF PINT; END_VAR
FV := a[0]^;
END_FUNCTION
`,
            fileName: "v.st",
          },
        ],
        { name: "v", version: "1.0.0", namespace: "v" },
      );
      expect(lib.errors).toEqual([]);
      const result = compile(
        `PROGRAM Main
VAR n : DINT; x : INT := 7; arr : ARRAY[0..1] OF POINTER TO INT; END_VAR
arr[0] := ADR(x);
n := FV(arr);
END_PROGRAM
`,
        {
          headerFileName: "generated.hpp",
          libraries: [
            loadStlibArchive(JSON.parse(JSON.stringify(lib.archive))),
          ],
        },
      );
      expect(result.errors).toEqual([]);
      expect(
        compileAndRunStandalone({
          tempDir,
          pchPath,
          headerCode: result.headerCode,
          cppCode: result.cppCode,
          testName: "libcalls3_vla",
          mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.N << std::endl;
    return 0;
}
`,
        }),
      ).toBe("7");
    });
  },
);
