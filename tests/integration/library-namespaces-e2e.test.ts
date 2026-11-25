// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Library namespaces (feature library_namespaces): a library's FUNCTIONs,
 * FBs, types, globals and enumeration values named through its namespace,
 * the feature off (refused, naming it) and under iec-3, the names it refuses,
 * and an archive without `stNamespace` (namespace from its name). g++ and run.
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
TYPE S_P : STRUCT a : INT; END_STRUCT END_TYPE
VAR_GLOBAL G : INT := 7; END_VAR
FUNCTION F_R : INT VAR_INPUT x : INT; END_VAR F_R := x * 2; END_FUNCTION
FUNCTION_BLOCK FB_C
VAR_INPUT i : INT; END_VAR
VAR_OUTPUT o : INT; END_VAR
METHOD M : INT M := o * 10; END_METHOD
o := i + 1;
END_FUNCTION_BLOCK
`;

function library(stNamespace?: string): StlibArchive {
  const lib = compileStlib([{ source: LIB, fileName: "lib.st" }], {
    name: "my-lib",
    version: "1.0.0",
    namespace: "my_lib",
    ...(stNamespace !== undefined ? { stNamespace } : {}),
  });
  expect(lib.errors).toEqual([]);
  return JSON.parse(JSON.stringify(lib.archive)) as StlibArchive;
}

const USE = (ns: string): string => `PROGRAM Main
VAR fb : ${ns}.FB_C; s : ${ns}.S_P; e : ${ns}.E_C; t : iec_standard_fb.TON;
  a : ARRAY[1..2] OF ${ns}.S_P; r : INT; END_VAR
fb(i := ${ns}.F_R(2));
s.a := ${ns}.G;
e := ${ns}.E_C.Green;
a[2].a := 1;
${ns}.G := ${ns}.G + 1;
IF e = ${ns}.E_C.Green THEN r := fb.o * 100 + s.a + fb.M() + a[2].a + ${ns}.G; END_IF
t(IN := TRUE, PT := T#1s);
END_PROGRAM
`;

const errorsOf = (
  src: string,
  archive: StlibArchive,
  options: Parameters<typeof compile>[1] = {},
): string[] =>
  compile(src, {
    headerFileName: "g.hpp",
    libraries: [...LIBS, loadStlibArchive(archive)],
    ...options,
  }).errors.map((e) => `${e.line}: ${e.message}`);

const ON = { features: ["+library_namespaces"] };

describe("library namespaces", () => {
  it("records the namespace in the manifest: given, or from the library's name", () => {
    expect(library().manifest.stNamespace).toBe("my_lib");
    expect(library("MyLib").manifest.stNamespace).toBe("MyLib");
  });

  it("refuses a qualified name without the feature, by default and under iec-3", () => {
    const src = `PROGRAM Main VAR r : INT; END_VAR
r := my_lib.F_R(1);
END_PROGRAM
`;
    const message =
      "2: Qualifying 'F_R' by the namespace of library my-lib needs the feature library_namespaces";
    expect(errorsOf(src, library())).toEqual([message]);
    expect(errorsOf(src, library(), { dialect: "iec-3" })).toEqual([message]);
  });

  it("refuses a name the library does not declare, one the sources hide and another library's", () => {
    expect(
      errorsOf(
        `FUNCTION F_R : INT VAR_INPUT x : INT; END_VAR F_R := x; END_FUNCTION
PROGRAM Main VAR r : INT; END_VAR
r := my_lib.F_X(1);
r := my_lib.F_R(1);
r := oscat_basic.F_R(1);
END_PROGRAM
`,
        library(),
        ON,
      ),
    ).toEqual([
      "3: Library my-lib (namespace 'my_lib') declares no 'F_X'",
      "4: 'my_lib.F_R' names the 'F_R' of library my-lib, which a declaration of the same name hides here",
      "5: Library oscat-basic (namespace 'oscat_basic') declares no 'F_R'",
    ]);
  });

  it("never takes an inherited member, a property or a library global for a namespace", () => {
    const named = (name: string): StlibArchive => {
      const lib = compileStlib(
        [
          {
            source: `TYPE ST : STRUCT x : INT; END_STRUCT END_TYPE
VAR_GLOBAL gst : ST; END_VAR
FUNCTION F_R : INT VAR_INPUT x : INT; END_VAR F_R := x; END_FUNCTION`,
            fileName: "l.st",
          },
        ],
        { name, version: "1.0.0", namespace: name },
      );
      expect(lib.errors).toEqual([]);
      return JSON.parse(JSON.stringify(lib.archive)) as StlibArchive;
    };
    const src = `FUNCTION_BLOCK FB_A
VAR cfg : ST; END_VAR
PROPERTY pp : ST GET pp := cfg; END_GET END_PROPERTY
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_B EXTENDS FB_A
VAR_OUTPUT o : INT; END_VAR
cfg.x := 4;
o := cfg.x;
END_FUNCTION_BLOCK
PROGRAM Main VAR r : INT; END_VAR
gst.x := 3;
r := gst.x;
END_PROGRAM
`;
    for (const options of [{}, ON]) {
      for (const lib of [named("cfg"), named("gst"), named("pp")]) {
        expect(
          compile(src, {
            headerFileName: "g.hpp",
            libraries: [...LIBS, loadStlibArchive(lib)],
            ...options,
          }).errors,
        ).toEqual([]);
      }
    }
  });

  it("leaves a variable named like a namespace alone", () => {
    expect(
      errorsOf(
        `TYPE S_N : STRUCT F_R : INT; END_STRUCT END_TYPE
PROGRAM Main VAR my_lib : S_N; r : INT; END_VAR
r := my_lib.F_R;
END_PROGRAM
`,
        library(),
        ON,
      ),
    ).toEqual([]);
  });
});

describe.skipIf(!hasGpp)("library namespaces — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-libns-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const run = (archive: StlibArchive, ns: string, name: string): string => {
    const result = compile(USE(ns), {
      headerFileName: "generated.hpp",
      libraries: [...LIBS, loadStlibArchive(archive)],
      ...ON,
    });
    expect(result.errors).toEqual([]);
    return compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: name,
      mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.R << std::endl;
    return 0;
}
`,
    });
  };

  it("calls FUNCTIONs and FBs, declares types and reads globals and enumeration values through the namespace", () => {
    expect(run(library(), "my_lib", "libns_default")).toBe("566");
  });

  it("takes a namespace in any letter case, and the one given at compile", () => {
    expect(run(library("MyLib"), "MYLIB", "libns_given")).toBe("566");
  });

  it("derives the namespace of an archive written before stNamespace from its name", () => {
    const old = library();
    delete old.manifest.stNamespace;
    expect(run(old, "My_Lib", "libns_old")).toBe("566");
  });

  /** Two libraries that declare the same type names, under NA and NB. */
  const twoLibraries = (): StlibArchive[] =>
    [
      `TYPE E_C : (Red, Green, Blue); END_TYPE
TYPE S_P : STRUCT a : INT := 5; c : E_C := Blue; END_STRUCT END_TYPE
TYPE A_P : ARRAY[0..1] OF S_P; END_TYPE`,
      `TYPE S_P : STRUCT z : LINT := 99; END_STRUCT END_TYPE
TYPE E_C : (Cyan, Magenta); END_TYPE
FUNCTION FZ : LINT VAR s : S_P; END_VAR FZ := s.z; END_FUNCTION`,
    ].map((source, i) => {
      const lib = compileStlib([{ source, fileName: `n${i}.st` }], {
        name: `nlib${i}`,
        version: "1.0.0",
        namespace: `nlib${i}`,
        stNamespace: i === 0 ? "NA" : "NB",
      });
      expect(lib.errors).toEqual([]);
      return JSON.parse(JSON.stringify(lib.archive)) as StlibArchive;
    });

  it("emits only the reachable one of two libraries' types of one name", () => {
    const result = compile(
      `TYPE UW : STRUCT l : NA.S_P; e : NA.E_C := NA.E_C.Green; ar : NA.A_P; END_STRUCT END_TYPE
TYPE UAl : NA.E_C; END_TYPE
VAR_GLOBAL g : NA.S_P; END_VAR
PROGRAM Main VAR w : UW; x : UAl := NA.E_C.Blue; r : LINT; END_VAR
r := w.l.a + w.ar[1].a * 10 + g.a * 100;
IF w.e = NA.E_C.Green AND x = NA.E_C.Blue AND w.l.c = NA.E_C.Blue THEN r := r + 1000; END_IF;
END_PROGRAM
`,
      {
        headerFileName: "generated.hpp",
        libraries: [...LIBS, ...twoLibraries().map((a) => loadStlibArchive(a))],
        ...ON,
      },
    );
    expect(result.errors).toEqual([]);
    expect(
      compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: "libns_same_type_names",
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.R << std::endl;
    return 0;
}
`,
      }),
    ).toBe("1555");
  });

  it("refuses a program that needs both libraries' types of one name", () => {
    const result = compile(
      `PROGRAM Main VAR l : NA.S_P; r : LINT; END_VAR
r := NB.FZ() + l.a;
END_PROGRAM
`,
      {
        headerFileName: "generated.hpp",
        libraries: [...LIBS, ...twoLibraries().map((a) => loadStlibArchive(a))],
        ...ON,
      },
    );
    expect(result.errors.map((e) => e.message)).toEqual([
      "'S_P' is declared by the libraries 'nlib0' and 'nlib1', and this program needs each one's: they cannot share one C++ name",
    ]);
  });
});
