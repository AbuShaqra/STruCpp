// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * A library FUNCTION's manifest records its parameters' POINTER TO, REF_TO
 * and ARRAY shapes (`parameterShapes`), so an address passed to a narrow
 * value input of it is refused; an archive written before, without the
 * marker, cannot tell a pointer from a value, so an address into it is not checked.
 */
import { describe, it, expect } from "vitest";
import { analyze, compileStlib } from "../../src/index.js";
import { loadStlibArchive } from "../../src/library/library-loader.js";
import type { StlibArchive } from "../../src/library/library-manifest.js";

const FEATURES = ["+pointer_to", "+reference_to"];

function library(): StlibArchive {
  const lib = compileStlib(
    [
      {
        source: `FUNCTION F_Shapes : INT
VAR_INPUT
  p : POINTER TO INT;
  r : REF_TO DINT;
  pp : POINTER TO POINTER TO BYTE;
  a : ARRAY[0..3] OF INT;
  ap : ARRAY[1..2] OF POINTER TO INT;
  rr : REFERENCE TO INT;
  d : DWORD;
END_VAR
F_Shapes := 1;
END_FUNCTION
`,
        fileName: "shapes.st",
      },
    ],
    {
      name: "shapes",
      version: "1.0.0",
      namespace: "shapes",
      features: FEATURES,
    },
  );
  expect(lib.errors).toEqual([]);
  return loadStlibArchive(JSON.parse(JSON.stringify(lib.archive)));
}

const CALL = (d: string): string => `PROGRAM Main
VAR x : INT; dx : DINT; px : POINTER TO BYTE; arr : ARRAY[0..3] OF INT; ap : ARRAY[1..2] OF POINTER TO INT; n : INT; END_VAR
n := F_Shapes(p := ADR(x), r := REF(dx), pp := ADR(px), a := arr, ap := ap, rr := x, d := ${d});
END_PROGRAM
`;

describe("library FUNCTION parameter shapes", () => {
  it("records POINTER TO, REF_TO and ARRAY parameters in the manifest", () => {
    const manifest = library().manifest;
    expect(manifest.parameterShapes).toBe(true);
    const params = manifest.functions[0]!.parameters;
    const byName = (n: string) => params.find((p) => p.name === n);
    expect(byName("P")).toMatchObject({
      type: "INT",
      referenceKind: "pointer_to",
    });
    expect(byName("R")).toMatchObject({
      type: "DINT",
      referenceKind: "ref_to",
    });
    expect(byName("PP")).toMatchObject({
      type: "BYTE",
      referenceKind: "pointer_to",
      referenceChain: ["pointer_to", "pointer_to"],
    });
    expect(byName("A")).toMatchObject({
      arrayDimensions: [{ start: 0, end: 3 }],
      elementTypeName: "INT",
    });
    expect(byName("AP")).toMatchObject({
      arrayDimensions: [{ start: 1, end: 2 }],
      elementReferenceChain: ["pointer_to"],
    });
    expect(byName("RR")).toEqual({
      name: "RR",
      type: "INT",
      direction: "input",
      referenceKind: "reference_to",
    });
    expect(byName("D")).toEqual({
      name: "D",
      type: "DWORD",
      direction: "input",
    });
  });

  it("accepts addresses into the pointer inputs and refuses one into the DWORD input", () => {
    const opts = { features: FEATURES, libraries: [library()] };
    expect(analyze(CALL("0"), opts).errors).toEqual([]);
    expect(analyze(CALL("ADR(x)"), opts).errors.map((e) => e.message)).toEqual([
      "ADR gives a 64-bit address, which DWORD cannot hold; use a POINTER TO or PVOID, or __XWORD, LWORD or ULINT",
    ]);
  });

  // A pre-parameterShapes archive keeps REFERENCE TO only: P, R and PP are
  // recorded as INT, DINT and BYTE, which may be pointers, so ADR and REF
  // into them are accepted, as into a FUNCTION without a REFERENCE TO input.
  it("accepts addresses into the bare-typed inputs of an archive written without parameterShapes", () => {
    const old = JSON.parse(JSON.stringify(library())) as StlibArchive;
    delete old.manifest.parameterShapes;
    for (const p of old.manifest.functions[0]!.parameters) {
      if (p.referenceKind !== "reference_to") delete p.referenceKind;
      delete p.referenceChain;
      delete p.arrayDimensions;
      delete p.elementTypeName;
      delete p.elementReferenceChain;
    }
    const archive = loadStlibArchive(old);
    expect(
      archive.manifest.functions[0]!.parameters.find((p) => p.name === "RR")
        ?.referenceKind,
    ).toBe("reference_to");
    const opts = { features: FEATURES, libraries: [archive] };
    expect(analyze(CALL("0"), opts).errors).toEqual([]);
    expect(analyze(CALL("ADR(x)"), opts).errors).toEqual([]);
    // The REFERENCE TO input is still checked.
    expect(
      analyze(CALL("0").replace("rr := x", "rr := ADR(x)"), opts).errors.length,
    ).toBeGreaterThan(0);
  });

  it("refuses REF of an INT into a REF_TO DINT input of a library FUNCTION", () => {
    const lib = compileStlib(
      [
        {
          source: `FUNCTION F_R : INT
VAR_INPUT
  r : REF_TO DINT;
END_VAR
F_R := 1;
END_FUNCTION
`,
          fileName: "r.st",
        },
      ],
      { name: "r", version: "1.0.0", namespace: "r", features: FEATURES },
    );
    expect(lib.errors).toEqual([]);
    const opts = {
      features: FEATURES,
      libraries: [loadStlibArchive(JSON.parse(JSON.stringify(lib.archive)))],
    };
    const call = (arg: string): string[] =>
      analyze(
        `PROGRAM Main
VAR x : INT; dx : DINT; rx : REF_TO INT; n : INT; END_VAR
n := F_R(r := ${arg});
END_PROGRAM
`,
        opts,
      ).errors.map((e) => e.message);
    expect(call("REF(dx)")).toEqual([]);
    for (const arg of ["REF(x)", "rx"]) {
      expect(call(arg)).toEqual([
        expect.stringMatching(/^Cannot assign REF_TO INT to REF_TO DINT/),
      ]);
    }
  });

  it("accepts REF of a STRING(n) into a library REF_TO STRING(n) input, whose length the manifest omits", () => {
    const lib = compileStlib(
      [
        {
          source: `FUNCTION F_RStr : INT
VAR_INPUT
  r : REF_TO STRING(20);
END_VAR
F_RStr := LEN(r^);
END_FUNCTION

FUNCTION F_RWStr : INT
VAR_INPUT
  r : REF_TO WSTRING(10);
END_VAR
F_RWStr := 1;
END_FUNCTION
`,
          fileName: "rs.st",
        },
      ],
      { name: "rs", version: "1.0.0", namespace: "rs", features: FEATURES },
    );
    expect(lib.errors).toEqual([]);
    const opts = {
      features: FEATURES,
      libraries: [loadStlibArchive(JSON.parse(JSON.stringify(lib.archive)))],
    };
    const call = (expr: string): string[] =>
      analyze(
        `PROGRAM Main
VAR s20 : STRING(20) := 'abc'; w10 : WSTRING(10); i : INT; n : INT; END_VAR
n := ${expr};
END_PROGRAM
`,
        opts,
      ).errors.map((e) => e.message);
    expect(call("F_RStr(r := REF(s20))")).toEqual([]);
    expect(call("F_RWStr(r := REF(w10))")).toEqual([]);
    expect(call("F_RStr(r := REF(i))")).toEqual([
      expect.stringMatching(/^Cannot assign REF_TO INT to REF_TO STRING/),
    ]);
    expect(call("F_RStr(r := REF(w10))")).toEqual([
      expect.stringMatching(
        /^Cannot assign REF_TO WSTRING\(10\) to REF_TO STRING/,
      ),
    ]);
  });

  it("refuses a POINTER TO output of a library FUNCTION captured into a DWORD", () => {
    const lib = compileStlib(
      [
        {
          source: `FUNCTION F_O : INT
VAR_OUTPUT
  po : POINTER TO INT;
END_VAR
F_O := 1;
END_FUNCTION
`,
          fileName: "o.st",
        },
      ],
      { name: "o", version: "1.0.0", namespace: "o", features: FEATURES },
    );
    expect(lib.errors).toEqual([]);
    const opts = {
      features: FEATURES,
      libraries: [loadStlibArchive(JSON.parse(JSON.stringify(lib.archive)))],
    };
    const call = (target: string): string[] =>
      analyze(
        `PROGRAM Main
VAR dw : DWORD; lw : LWORD; n : INT; END_VAR
n := F_O(po => ${target});
END_PROGRAM
`,
        opts,
      ).errors.map((e) => e.message);
    expect(call("lw")).toEqual([]);
    expect(call("dw")).toEqual([
      "The output 'PO' gives a 64-bit address, which DWORD cannot hold; use a POINTER TO or PVOID, or __XWORD, LWORD or ULINT",
    ]);
  });
});
