// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * A STRING or WSTRING VAR_IN_OUT written without a length has the default
 * length of the compilation (254, or 80 with string_default_80). A variable
 * of that length binds to it by reference, with no warning; one of another
 * length is passed by copy-in / copy-out with a warning, for a user FUNCTION,
 * FUNCTION_BLOCK and METHOD alike.
 */
import { describe, it, expect } from "vitest";
import { compile, compileStlib } from "../../src/index.js";
import { loadStlibArchive } from "../../src/library/library-loader.js";
import type { StlibArchive } from "../../src/library/library-manifest.js";

const SOURCE = (type: "STRING" | "WSTRING", length: number): string => `
FUNCTION F2 : INT
VAR_IN_OUT s1 : ${type}; s2 : ${type}; END_VAR
F2 := LEN(s2);
END_FUNCTION
FUNCTION_BLOCK FB2
VAR_IN_OUT s : ${type}; END_VAR
METHOD M : INT
VAR_IN_OUT t : ${type}; END_VAR
M := LEN(t);
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main
VAR a : ${type}(${length}); n : INT; fb : FB2; END_VAR
n := F2(s1 := a, s2 := a);
fb(s := a);
n := fb.M(t := a);
END_PROGRAM
`;

function copies(
  type: "STRING" | "WSTRING",
  length: number,
  features: string[],
): { warnings: string[]; copied: boolean } {
  const r = compile(SOURCE(type, length), {
    headerFileName: "generated.hpp",
    features,
  });
  expect(r.errors).toEqual([]);
  return {
    warnings: r.warnings
      .map((w) => w.message)
      .filter((m) => m.includes("copy-in / copy-out")),
    copied: r.cppCode.includes("__gio_"),
  };
}

describe("a plain STRING / WSTRING VAR_IN_OUT", () => {
  for (const type of ["STRING", "WSTRING"] as const) {
    for (const [mode, features, same, other] of [
      ["254", [], 254, 80],
      ["string_default_80", ["+string_default_80"], 80, 254],
    ] as const) {
      it(`binds a ${type}(${same}) by reference (${mode})`, () => {
        expect(copies(type, same, [...features])).toEqual({
          warnings: [],
          copied: false,
        });
      });

      it(`copies a ${type}(${other}) with a warning (${mode})`, () => {
        const c = copies(type, other, [...features]);
        expect(c.copied).toBe(true);
        expect(c.warnings).toHaveLength(4);
        for (const w of c.warnings) {
          expect(w).toMatch(
            new RegExp(`is bound to a variable of type ${type}\\(${other}\\)`),
          );
        }
      });
    }
  }
});

describe("a library's STRING / WSTRING VAR_IN_OUT", () => {
  const LIB = `FUNCTION FS : INT
VAR_IN_OUT s : STRING(20); END_VAR
FS := LEN(s);
END_FUNCTION
FUNCTION FW : INT
VAR_IN_OUT s : WSTRING(20); END_VAR
FW := LEN(s);
END_FUNCTION
FUNCTION_BLOCK FB_M
VAR_IN_OUT s1 : STRING(LEN_C); s2 : STRING(LEN_C); END_VAR
METHOD M : INT
VAR_IN_OUT s : STRING(20); END_VAR
M := LEN(s);
END_METHOD
END_FUNCTION_BLOCK
`;
  const archive = (
    constants: Record<string, number>,
    strip = false,
    opaque = false,
  ): StlibArchive => {
    const lib = compileStlib([{ source: LIB, fileName: "l.st" }], {
      name: "l",
      version: "1.0.0",
      namespace: "l",
      globalConstants: constants,
    });
    expect(lib.errors).toEqual([]);
    const raw = JSON.parse(JSON.stringify(lib.archive)) as StlibArchive;
    if (strip) {
      delete raw.manifest.stringLengthsRecorded;
      for (const fb of raw.manifest.functionBlocks) {
        for (const v of fb.inouts) delete v.maxLength;
      }
    }
    // A C++ class the loader cannot read lengths from.
    if (opaque) {
      for (const chunk of raw.chunks) {
        chunk.header = chunk.header.replaceAll("IECStringVar<", "OpaqueVar<");
      }
    }
    return loadStlibArchive(raw);
  };
  const warnings = (body: string, lib: StlibArchive): string[] => {
    const r = compile(
      `PROGRAM Main
VAR a : STRING(30); w : WSTRING(30); b : STRING(254); m : FB_M; n : INT; END_VAR
${body}
END_PROGRAM
`,
      { libraries: [lib] },
    );
    expect(r.errors).toEqual([]);
    return r.warnings
      .map((x) => x.message)
      .filter((x) => x.includes("copy-in / copy-out"))
      .map((x) => x.slice(0, x.indexOf(";")));
  };

  it("warns for a FUNCTION's, a WSTRING FUNCTION's and a METHOD's in/out of another length", () => {
    expect(
      warnings("n := FS(a) + FW(w) + m.M(a);", archive({ LEN_C: 20 })),
    ).toEqual([
      "VAR_IN_OUT 'S' of type STRING(20) is bound to a variable of type STRING(30)",
      "VAR_IN_OUT 'S' of type WSTRING(20) is bound to a variable of type WSTRING(30)",
      "VAR_IN_OUT 'S' of type STRING(20) is bound to a variable of type STRING(30)",
    ]);
  });

  it("compares a STRING(NAME) in/out by the constant's value", () => {
    expect(warnings("m(s1 := b, s2 := b);", archive({ LEN_C: 20 }))).toEqual([
      "VAR_IN_OUT 'S1' of type STRING(LEN_C) is bound to a variable of type STRING(254)",
      "VAR_IN_OUT 'S2' of type STRING(LEN_C) is bound to a variable of type STRING(254)",
    ]);
    expect(warnings("m(s1 := b, s2 := b);", archive({ LEN_C: 254 }))).toEqual(
      [],
    );
  });

  it("reads an older archive's unrecorded in/out lengths from its C++ class, as a marked archive records them", () => {
    expect(
      warnings("m(s1 := b, s2 := b);", archive({ LEN_C: 254 }, true)),
    ).toEqual([]);
  });

  it("keeps an archive without readable lengths as written: a plain in/out is not taken for 254", () => {
    expect(
      warnings("m(s1 := b, s2 := b);", archive({ LEN_C: 254 }, true, true)),
    ).toEqual([
      "VAR_IN_OUT 'S1' of type STRING is bound to a variable of type STRING(254)",
      "VAR_IN_OUT 'S2' of type STRING is bound to a variable of type STRING(254)",
    ]);
  });

  it("warns for an interface METHOD's in/out of another length", () => {
    const r = compile(
      `INTERFACE I_X
METHOD MI : INT
VAR_IN_OUT s : STRING(20); END_VAR
END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB_X IMPLEMENTS I_X
METHOD MI : INT
VAR_IN_OUT s : STRING(20); END_VAR
MI := LEN(s);
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main
VAR x : FB_X; i : I_X; a : STRING(30); n : INT; END_VAR
i := x;
n := i.MI(a);
END_PROGRAM
`,
    );
    expect(r.errors).toEqual([]);
    expect(
      r.warnings.filter((w) => w.message.includes("copy-in / copy-out")),
    ).toHaveLength(1);
  });
});

describe("a library's plain STRING VAR_IN_OUT and the archive's stringLengthsRecorded", () => {
  const LIB = `FUNCTION LF : INT
VAR_IN_OUT s1 : STRING; s2 : STRING; END_VAR
LF := LEN(s2);
END_FUNCTION
FUNCTION_BLOCK LFB
VAR_IN_OUT f1 : STRING; f2 : STRING; END_VAR
METHOD M : INT
VAR_IN_OUT s1 : STRING; s2 : STRING; END_VAR
M := LEN(s2);
END_METHOD
END_FUNCTION_BLOCK
`;
  const archive = (
    features: string[],
    marked: boolean,
    opaque = false,
  ): StlibArchive => {
    const lib = compileStlib([{ source: LIB, fileName: "l.st" }], {
      name: "l",
      version: "1.0.0",
      namespace: "l",
      features,
    });
    expect(lib.errors).toEqual([]);
    expect(lib.archive.manifest.stringLengthsRecorded).toBe(true);
    const raw = JSON.parse(JSON.stringify(lib.archive)) as StlibArchive;
    if (!marked) delete raw.manifest.stringLengthsRecorded;
    // C++ prototypes and a class the loader cannot read lengths from.
    if (opaque) {
      for (const chunk of raw.chunks) {
        chunk.header = chunk.header.replaceAll("IEC_STRING", "OPAQUE_STRING");
      }
    }
    return loadStlibArchive(raw);
  };
  const warned = (
    type: string,
    features: string[],
    lib: StlibArchive,
  ): string[] => {
    const r = compile(
      `PROGRAM Main
VAR a : ${type}; fb : LFB; n : INT; END_VAR
n := LF(s1 := a, s2 := a);
n := fb.M(s1 := a, s2 := a);
fb(f1 := a, f2 := a);
END_PROGRAM
`,
      { libraries: [lib], features },
    );
    expect(r.errors).toEqual([]);
    return r.warnings
      .map((w) => w.message)
      .filter((m) => m.includes("copy-in / copy-out"))
      .map((m) => m.slice(0, m.indexOf(" is bound")));
  };

  for (const [mode, features, same] of [
    ["254", [], "STRING(254)"],
    ["string_default_80", ["+string_default_80"], "STRING(80)"],
  ] as const) {
    it(`binds a variable of the library's default length by reference (${mode})`, () => {
      expect(warned(same, [...features], archive([...features], true))).toEqual(
        [],
      );
    });
  }

  it("copies one of another length with a warning, FUNCTION, METHOD and FB alike", () => {
    expect(
      warned(
        "STRING(254)",
        ["+string_default_80"],
        archive(["+string_default_80"], true),
      ),
    ).toEqual([
      "VAR_IN_OUT 'S1' of type STRING(80)",
      "VAR_IN_OUT 'S2' of type STRING(80)",
      "VAR_IN_OUT 'S1' of type STRING(80)",
      "VAR_IN_OUT 'S2' of type STRING(80)",
      "VAR_IN_OUT 'F1' of type STRING(80)",
      "VAR_IN_OUT 'F2' of type STRING(80)",
    ]);
  });

  it("reads an archive without the marker from its C++ prototypes and class, as a marked one", () => {
    expect(warned("STRING(254)", [], archive([], false))).toEqual([]);
  });

  it("keeps development's behaviour for an archive without the marker or readable lengths", () => {
    // FUNCTION and METHOD in-outs unchecked; the FB's compared as written.
    expect(warned("STRING(254)", [], archive([], false, true))).toEqual([
      "VAR_IN_OUT 'F1' of type STRING",
      "VAR_IN_OUT 'F2' of type STRING",
    ]);
  });

  it("warns for a METHOD a block inherits from a library block", () => {
    const lib = compileStlib(
      [
        {
          source: `FUNCTION_BLOCK LB
METHOD M : INT
VAR_IN_OUT s : STRING(20); END_VAR
M := LEN(s);
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK LB2 EXTENDS LB
END_FUNCTION_BLOCK
`,
          fileName: "b.st",
        },
      ],
      { name: "b", version: "1.0.0", namespace: "b" },
    );
    const r = compile(
      `FUNCTION_BLOCK UB EXTENDS LB
END_FUNCTION_BLOCK
PROGRAM Main
VAR a : STRING(30); l2 : LB2; u : UB; n : INT; END_VAR
n := l2.M(a) + u.M(a);
END_PROGRAM
`,
      {
        libraries: [loadStlibArchive(JSON.parse(JSON.stringify(lib.archive)))],
      },
    );
    expect(r.errors).toEqual([]);
    expect(
      r.warnings.filter((w) => w.message.includes("copy-in / copy-out")),
    ).toHaveLength(2);
  });
});
