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
});
