// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * A library FUNCTION's manifest records its parameters' POINTER TO, REF_TO
 * and ARRAY shapes (`parameterShapes`), so an address passed to a narrow
 * value input of it is refused; an archive written before, without the
 * marker, reads its parameters as before and refuses nothing new.
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

  // RR's REFERENCE TO is dropped too: an old archive with one reads every
  // input by its bare name (P as INT), as before.
  it("refuses nothing new from an archive written without parameterShapes", () => {
    const old = JSON.parse(JSON.stringify(library())) as StlibArchive;
    delete old.manifest.parameterShapes;
    for (const p of old.manifest.functions[0]!.parameters) {
      delete p.referenceKind;
      delete p.referenceChain;
      delete p.arrayDimensions;
      delete p.elementTypeName;
      delete p.elementReferenceChain;
    }
    const archive = loadStlibArchive(old);
    expect(
      analyze(CALL("0"), { features: FEATURES, libraries: [archive] }).errors,
    ).toEqual([]);
  });
});
