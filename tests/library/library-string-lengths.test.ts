// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * A library archive records the STRING / WSTRING lengths written in its
 * declarations: function block members and properties, STRUCT fields,
 * globals, FUNCTION inputs, POINTER TO targets and ARRAY[*] elements, and the
 * base of an alias. A consumer reads them back, so a library STRING(20) is
 * never taken for the default length. A default length stays implied by
 * `stringDefaultLength`, and an archive without the lengths still loads.
 */
import { describe, it, expect } from "vitest";
import { compile, compileStlib, type CompileOptions } from "../../src/index.js";
import { functionParameterEntry } from "../../src/library/library-compiler.js";
import { loadStlibArchive } from "../../src/library/library-loader.js";
import type { StlibArchive } from "../../src/library/library-manifest.js";
import type { TypeReference } from "../../src/frontend/ast.js";
import { createDefaultSourceSpan } from "../../src/frontend/ast.js";

const LIB = `TYPE ST_Rec :
STRUCT
  s20 : STRING(20);
  s254 : STRING(254);
  plain : STRING;
END_STRUCT
END_TYPE
TYPE TS : STRING(20); END_TYPE
TYPE TDw : DWORD; END_TYPE
TYPE TP : POINTER TO INT; END_TYPE

VAR_GLOBAL
  gName : STRING(30);
  gLong : STRING(254);
END_VAR

FUNCTION_BLOCK FB_Lib
VAR_INPUT
  sIn20 : STRING(20);
  sIn254 : STRING(254);
  sInPlain : STRING;
END_VAR
VAR_OUTPUT
  sOut20 : STRING(20);
END_VAR
VAR
  sLocal : STRING(200);
END_VAR
PROPERTY P_Name : STRING(40)
GET
  P_Name := sIn20;
END_GET
END_PROPERTY
sOut20 := sIn20;
END_FUNCTION_BLOCK

FUNCTION F_Lens : INT
VAR_INPUT
  arr : ARRAY[*] OF STRING(10);
  sIn : STRING(12);
  pIn : POINTER TO STRING(20);
END_VAR
VAR_OUTPUT
  pOut : POINTER TO STRING(20);
END_VAR
F_Lens := 1;
END_FUNCTION
`;

function library(features: string[] = []): StlibArchive {
  const lib = compileStlib([{ source: LIB, fileName: "lib.st" }], {
    name: "lens",
    version: "1.0.0",
    namespace: "lens",
    features,
  });
  expect(lib.errors).toEqual([]);
  return loadStlibArchive(JSON.parse(JSON.stringify(lib.archive)));
}

const CONFIG = `CONFIGURATION C
RESOURCE R ON PLC
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM I WITH T : Main;
END_RESOURCE
END_CONFIGURATION
`;

/** The debug leaves and the "not debuggable" warnings of `source`. */
function debug(
  source: string,
  opts: Partial<CompileOptions>,
): { leaves: string[]; skipped: string[] } {
  const r = compile(source + CONFIG, {
    headerFileName: "generated.hpp",
    ...opts,
  });
  expect(r.errors).toEqual([]);
  return {
    leaves: (r.debugMap?.leaves ?? []).map((l) => `${l.path} ${l.type}`),
    skipped: r.warnings
      .map((w) => w.message)
      .filter((m) => m.includes("not debuggable"))
      .map((m) => m.slice(0, m.indexOf(" is not debuggable"))),
  };
}

const MEMBERS = `PROGRAM Main
VAR fb : FB_Lib; rec : ST_Rec; END_VAR
END_PROGRAM
`;

describe("library STRING lengths in the manifest", () => {
  it("records written lengths, not default ones", () => {
    const m = library(["+string_default_80"]).manifest;
    const fb = m.functionBlocks.find((f) => f.name === "FB_LIB")!;
    expect(fb.inputs.map((v) => [v.name, v.maxLength])).toEqual([
      ["SIN20", 20],
      ["SIN254", 254],
      ["SINPLAIN", undefined],
    ]);
    expect(fb.outputs[0]?.maxLength).toBe(20);
    expect(fb.locals?.[0]?.maxLength).toBe(200);
    expect(fb.properties?.[0]?.type.maxLength).toBe(40);
    const rec = m.types.find((t) => t.name === "ST_REC")!;
    expect(rec.fields).toEqual([
      { name: "S20", type: "STRING", maxLength: 20 },
      { name: "S254", type: "STRING", maxLength: 254 },
      { name: "PLAIN", type: "STRING" },
    ]);
    expect(m.globals).toEqual([
      { name: "GNAME", type: "STRING", maxLength: 30 },
      { name: "GLONG", type: "STRING", maxLength: 254 },
    ]);
    const params = m.functions.find((f) => f.name === "F_LENS")!.parameters;
    expect(params.find((p) => p.name === "ARR")).toMatchObject({
      type: "__VLA_1D_STRING",
      elementMaxLength: 10,
    });
    expect(params.find((p) => p.name === "SIN")?.maxLength).toBe(12);
    for (const name of ["PIN", "POUT"]) {
      expect(params.find((p) => p.name === name)).toMatchObject({
        type: "STRING",
        referenceKind: "pointer_to",
        maxLength: 20,
      });
    }
  });

  it("records an alias's base type and length, not an ARRAY's or POINTER's", () => {
    const types = library().manifest.types;
    expect(types.find((t) => t.name === "TS")).toEqual({
      name: "TS",
      kind: "alias",
      baseType: "STRING",
      maxLength: 20,
    });
    expect(types.find((t) => t.name === "TDW")).toEqual({
      name: "TDW",
      kind: "alias",
      baseType: "DWORD",
    });
    expect(types.find((t) => t.name === "TP")).toEqual({
      name: "TP",
      kind: "alias",
    });
  });

  it("leaves a library's STRING(20) out of the debug table instead of addressing it as 254", () => {
    const d = debug(MEMBERS, { libraries: [library()] });
    expect(d.skipped).toEqual(["I.FB.SIN20", "I.FB.SOUT20", "I.REC.S20"]);
    expect(d.leaves).toEqual([
      "I.FB.SIN254 STRING",
      "I.FB.SINPLAIN STRING",
      "I.REC.S254 STRING",
      "I.REC.PLAIN STRING",
    ]);
  });

  it("keeps an 80-character library's STRING(254) members in the debug table", () => {
    const d = debug(MEMBERS, {
      libraries: [library(["+string_default_80"])],
      features: ["+string_default_80"],
    });
    expect(d.leaves).toEqual(["I.FB.SIN254 STRING", "I.REC.S254 STRING"]);
    expect(d.skipped).toEqual([
      "I.FB.SIN20",
      "I.FB.SINPLAIN",
      "I.FB.SOUT20",
      "I.REC.S20",
      "I.REC.PLAIN",
    ]);
  });

  it("keeps a STRING(NAME) member whose constant is 254 in the debug table", () => {
    const lib = compileStlib(
      [
        {
          source: `FUNCTION_BLOCK FB_C
VAR_INPUT s : STRING(STRING_LENGTH); t : STRING(SHORT_LENGTH); END_VAR
END_FUNCTION_BLOCK
`,
          fileName: "c.st",
        },
      ],
      {
        name: "c",
        version: "1.0.0",
        namespace: "c",
        globalConstants: { STRING_LENGTH: 254, SHORT_LENGTH: 16 },
      },
    );
    expect(lib.errors).toEqual([]);
    expect(lib.archive.manifest.functionBlocks[0]?.inputs).toEqual([
      { name: "S", type: "STRING", maxLength: "STRING_LENGTH" },
      { name: "T", type: "STRING", maxLength: "SHORT_LENGTH" },
    ]);
    const d = debug("PROGRAM Main\nVAR fb : FB_C; END_VAR\nEND_PROGRAM\n", {
      libraries: [loadStlibArchive(JSON.parse(JSON.stringify(lib.archive)))],
    });
    expect(d.leaves).toEqual(["I.FB.S STRING"]);
    expect(d.skipped).toEqual(["I.FB.T"]);
  });

  it("binds a library global of the parameter's length to a VAR_IN_OUT without a copy", () => {
    const warnings = compile(
      `FUNCTION F_254 : INT
VAR_IN_OUT s : STRING(254); END_VAR
F_254 := LEN(s);
END_FUNCTION
FUNCTION F_30 : INT
VAR_IN_OUT s : STRING(30); END_VAR
F_30 := LEN(s);
END_FUNCTION
PROGRAM Main
VAR n : INT; END_VAR
n := F_254(gLong) + F_30(gName);
END_PROGRAM
`,
      { libraries: [library()] },
    ).warnings.map((w) => w.message);
    expect(warnings.filter((w) => w.includes("copy-in"))).toEqual([]);
  });

  it("reads a library alias of STRING(20) as a STRING", () => {
    const r = compile(
      `PROGRAM Main
VAR t : TS; n : INT; END_VAR
n := LEN(t);
END_PROGRAM
`,
      { libraries: [library()] },
    );
    expect(r.errors).toEqual([]);
  });

  it("loads an archive written without the lengths as before", () => {
    const old = JSON.parse(JSON.stringify(library())) as StlibArchive;
    const strip = (v: { maxLength?: unknown; elementMaxLength?: unknown }) => {
      delete v.maxLength;
      delete v.elementMaxLength;
    };
    for (const fb of old.manifest.functionBlocks) {
      [...fb.inputs, ...fb.outputs, ...fb.inouts, ...(fb.locals ?? [])].forEach(
        strip,
      );
      for (const p of fb.properties ?? []) strip(p.type);
    }
    for (const t of old.manifest.types) {
      delete t.baseType;
      strip(t);
      for (const f of t.fields ?? []) strip(f);
    }
    for (const g of old.manifest.globals ?? []) strip(g);
    for (const fn of old.manifest.functions) {
      for (const p of fn.parameters) {
        if (p.direction === "input") strip(p);
      }
    }
    const d = debug(MEMBERS, { libraries: [loadStlibArchive(old)] });
    expect(d.skipped).toEqual([]);
    expect(d.leaves).toHaveLength(7);
  });
});

describe("REFERENCE TO parameter shapes in the manifest", () => {
  const ref = (extra: Partial<TypeReference>): TypeReference => ({
    kind: "TypeReference",
    sourceSpan: createDefaultSourceSpan(),
    name: "INT",
    isReference: true,
    referenceKind: "reference_to",
    ...extra,
  });

  it("records a plain REFERENCE TO by its kind alone", () => {
    expect(functionParameterEntry("R", "input", { type: ref({}) })).toEqual({
      name: "R",
      type: "INT",
      direction: "input",
      referenceKind: "reference_to",
    });
  });

  it("records a REFERENCE TO an ARRAY or a POINTER with its whole shape", () => {
    expect(
      functionParameterEntry("RA", "input", {
        type: ref({
          name: "__INLINE_ARRAY_INT",
          arrayDimensions: [{ start: 0, end: 3 }],
          elementTypeName: "INT",
        }),
      }),
    ).toEqual({
      name: "RA",
      type: "__INLINE_ARRAY_INT",
      direction: "input",
      referenceKind: "reference_to",
      arrayDimensions: [{ start: 0, end: 3 }],
      elementTypeName: "INT",
    });
    expect(
      functionParameterEntry("RP", "input", {
        type: ref({ referenceChain: ["reference_to", "pointer_to"] }),
      }),
    ).toEqual({
      name: "RP",
      type: "INT",
      direction: "input",
      referenceKind: "reference_to",
      referenceChain: ["reference_to", "pointer_to"],
    });
  });
});
