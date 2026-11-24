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
import {
  loadStlibArchive,
  prototypeReferenceLevels,
} from "../../src/library/library-loader.js";
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

  it("records an alias's base type and length, a POINTER's target, not an ARRAY's", () => {
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
      pointerTarget: "INT",
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
    const warning = compile(
      "PROGRAM Main\nVAR fb : FB_C; END_VAR\nEND_PROGRAM\n" + CONFIG,
      {
        headerFileName: "generated.hpp",
        libraries: [loadStlibArchive(JSON.parse(JSON.stringify(lib.archive)))],
      },
    ).warnings.find((w) => w.message.startsWith("I.FB.T "))?.message;
    expect(warning).toContain("declared STRING(SHORT_LENGTH = 16)");
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

const ALIASES = `TYPE TS : STRING(20); END_TYPE
TYPE TSA : TS; END_TYPE
TYPE IA : INT; END_TYPE
TYPE IAA : IA; END_TYPE
TYPE ST_O : STRUCT c : STRING(6); END_STRUCT END_TYPE
FUNCTION FT : TS
VAR_INPUT a : STRING; END_VAR
FT := a;
END_FUNCTION
FUNCTION FX : INT
VAR_IN_OUT x : TS; END_VAR
FX := LEN(x);
END_FUNCTION
FUNCTION_BLOCK FB_D
VAR_OUTPUT os : STRING(5); END_VAR
END_FUNCTION_BLOCK
FUNCTION F_R : DINT
VAR_INPUT r : REFERENCE TO INT; i : INT; p : POINTER TO INT; END_VAR
F_R := r + i;
END_FUNCTION
`;

const USE = `FUNCTION GD : INT
VAR_IN_OUT x : STRING; END_VAR
GD := LEN(x);
END_FUNCTION
PROGRAM Main
VAR tsa : TSA; iaa : IAA; t : TS; s20 : STRING(20); d : FB_D; o : ST_O;
  r : REFERENCE TO STRING(20); x : INT; n : DINT; END_VAR
n := LEN(tsa) + ABS(iaa) + LEN(FT('abc'));
n := FX(s20) + GD(t) + GD(d.os) + GD(o.c);
END_PROGRAM
`;

/** Errors and warnings of `program`, with ALIASES from a library or declared in the program. */
function diagnostics(
  program: string,
  from: "library" | "program",
): { errors: string[]; warnings: string[] } {
  const lib = compileStlib([{ source: ALIASES, fileName: "a.st" }], {
    name: "al",
    version: "1.0.0",
    namespace: "al",
  });
  expect(lib.errors).toEqual([]);
  const r =
    from === "library"
      ? compile(program, {
          libraries: [
            loadStlibArchive(JSON.parse(JSON.stringify(lib.archive))),
          ],
        })
      : compile(ALIASES + program);
  return {
    errors: r.errors.map((e) => e.message),
    warnings: r.warnings
      .map((w) => w.message)
      .filter((m) => m.includes("VAR_IN_OUT")),
  };
}

describe("library aliases and members behave as declared in the program", () => {
  it("resolves an alias of an alias, and a FUNCTION result of an alias type", () => {
    expect(diagnostics(USE, "library")).toEqual(diagnostics(USE, "program"));
    expect(diagnostics(USE, "library").errors).toEqual([]);
  });

  it("copies an alias in/out and a library member of another length, with the same warnings", () => {
    expect(diagnostics(USE, "library").warnings).toEqual([
      "VAR_IN_OUT 'X' of type TS is bound to a variable of type STRING(20); it is passed by copy-in / copy-out, not by reference",
      "VAR_IN_OUT 'X' of type STRING is bound to a variable of type TS; it is passed by copy-in / copy-out, not by reference",
      "VAR_IN_OUT 'X' of type STRING is bound to a variable of type STRING(5); it is passed by copy-in / copy-out, not by reference",
      "VAR_IN_OUT 'X' of type STRING is bound to a variable of type STRING(6); it is passed by copy-in / copy-out, not by reference",
    ]);
  });

  it("refuses REF= of a library STRING alias as for a local one", () => {
    const program = `PROGRAM Main
VAR t : TS; r : REFERENCE TO STRING(20); END_VAR
r REF= t;
END_PROGRAM
`;
    expect(diagnostics(program, "library").errors).toEqual(
      diagnostics(program, "program").errors,
    );
    expect(diagnostics(program, "library").errors).toHaveLength(1);
  });
});

describe("an archive written without parameterShapes", () => {
  it("reads its pointer parameters back from the C++ prototype, and still checks a value input", () => {
    const lib = compileStlib([{ source: ALIASES, fileName: "a.st" }], {
      name: "al",
      version: "1.0.0",
      namespace: "al",
    });
    const old = JSON.parse(JSON.stringify(lib.archive)) as StlibArchive;
    delete old.manifest.parameterShapes;
    for (const fn of old.manifest.functions) {
      for (const p of fn.parameters) {
        if (p.referenceKind !== "reference_to") delete p.referenceKind;
        delete p.maxLength;
      }
    }
    const archive = loadStlibArchive(old);
    const params = archive.manifest.functions.find(
      (f) => f.name === "F_R",
    )!.parameters;
    expect(params.map((p) => [p.name, p.referenceKind])).toEqual([
      ["R", "reference_to"],
      ["I", undefined],
      ["P", "pointer_to"],
    ]);
    const errors = (call: string): string[] =>
      compile(
        `PROGRAM Main\nVAR x : INT; n : DINT; END_VAR\nn := ${call};\nEND_PROGRAM\n`,
        { libraries: [archive] },
      ).errors.map((e) => e.message);
    expect(errors("F_R(x, x, ADR(x))")).toEqual([]);
    expect(errors("F_R(x, ADR(x), ADR(x))")).toEqual([
      "ADR gives a 64-bit address, which INT cannot hold; use a POINTER TO or PVOID, or __XWORD, LWORD or ULINT",
    ]);
  });
});

describe("reading pointer levels from a C++ prototype", () => {
  const levels = (header: string, name: string) => {
    const map = prototypeReferenceLevels(header, name);
    return map === undefined ? undefined : Object.fromEntries(map);
  };

  it("reads each parameter's levels, nested ones included", () => {
    expect(
      levels(
        "IEC_DINT F_R(IEC_REFERENCE_TO<INT_t> R, IEC_INT I, IEC_Ptr<IEC_Ptr<INT_t>> PP, IEC_REF_TO<DINT_t> RR, IEC_Ptr<IECString<254>> PS);",
        "F_R",
      ),
    ).toEqual({
      R: [],
      I: [],
      PP: ["pointer_to", "pointer_to"],
      RR: ["ref_to"],
      PS: ["pointer_to"],
    });
  });

  it("reads a prototype over several lines, with default arguments and references", () => {
    expect(
      levels(
        "IEC_BOOL\nF_X(\n    IEC_Ptr<INT_t>   P = nullptr,\n\tIEC_INT& IO,\n    IEC_ARRAY_1D<IEC_INT, ArrayBounds<0, 3>> A = {}\n);",
        "F_X",
      ),
    ).toEqual({ P: ["pointer_to"], IO: [], A: [] });
  });

  it("reads a function without parameters", () => {
    expect(levels("IEC_INT F_0();", "F_0")).toEqual({});
  });

  it("gives up on a renamed, qualified, repeated or unbalanced prototype", () => {
    expect(levels("IEC_INT F_R_(IEC_Ptr<INT_t> P);", "F_R")).toBeUndefined();
    expect(levels("IEC_INT ns::F_R(IEC_Ptr<INT_t> P);", "F_R")).toBeUndefined();
    expect(
      levels("IEC_INT F_R(IEC_Ptr<INT_t> P);\nIEC_INT F_R(IEC_INT P);", "F_R"),
    ).toBeUndefined();
    expect(levels("IEC_INT F_R(IEC_Ptr<INT_t P);", "F_R")).toBeUndefined();
    expect(levels("IEC_INT F_R(IEC_INT P, IEC_INT P);", "F_R")).toBeUndefined();
  });

  it("leaves a function whose prototype it cannot read as an older archive read it", () => {
    const lib = compileStlib([{ source: ALIASES, fileName: "a.st" }], {
      name: "al",
      version: "1.0.0",
      namespace: "al",
    });
    const old = JSON.parse(JSON.stringify(lib.archive)) as StlibArchive;
    delete old.manifest.parameterShapes;
    for (const fn of old.manifest.functions) {
      for (const p of fn.parameters) {
        if (p.referenceKind !== "reference_to") delete p.referenceKind;
      }
    }
    for (const chunk of old.chunks) {
      if (chunk.name === "F_R") {
        chunk.header = chunk.header.replace("F_R(", "F_R_(");
      }
    }
    const params = loadStlibArchive(old).manifest.functions.find(
      (f) => f.name === "F_R",
    )!.parameters;
    expect(params.map((p) => p.referenceKind)).toEqual([
      "reference_to",
      undefined,
      undefined,
    ]);
  });
});
