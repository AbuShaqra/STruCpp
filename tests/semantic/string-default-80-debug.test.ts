// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * The debug table and string_default_80: a STRING or WSTRING of another
 * length than 254 (the plain one under the feature, an explicit STRING(n)
 * scalar or ARRAY element) is skipped with a warning that gives the right
 * advice, never registered with the 254-character size; an ARRAY of them
 * gets one warning. The feature reached through a dialect profile behaves as
 * the --feature form. A library compiled with the feature has its array
 * elements and STRUCT fields at 80 too.
 */
import { describe, it, expect } from "vitest";
import { compile, compileStlib, type CompileOptions } from "../../src/index.js";
import type { DialectProfile } from "../../src/dialect.js";
import { loadStlibArchive } from "../../src/library/library-loader.js";

const SRC = `TYPE ST_D : STRUCT s : STRING; w : WSTRING; END_STRUCT; END_TYPE
TYPE T_AS : ARRAY[0..1] OF STRING; END_TYPE
PROGRAM Main
VAR s : STRING := 'hi'; w : WSTRING := "wide"; st : ST_D; arr : ARRAY[0..1] OF STRING;
  tas : T_AS; e : ARRAY[0..1] OF STRING(10); k : STRING(254); END_VAR
s := 'a';
END_PROGRAM
CONFIGURATION C
RESOURCE R ON PLC
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM I WITH T : Main;
END_RESOURCE
END_CONFIGURATION
`;

const PROFILE: DialectProfile = {
  id: "vendor80",
  name: "vendor80",
  extends: "iec-3",
  features: ["string_default_80"],
  semantics: {},
};

function debug(opts: Partial<CompileOptions>): {
  leaves: string[];
  skipped: string[];
} {
  const r = compile(SRC, { headerFileName: "generated.hpp", ...opts });
  expect(r.errors).toEqual([]);
  return {
    leaves: (r.debugMap?.leaves ?? []).map(
      (l) => `${l.path} ${l.type} ${l.size}`,
    ),
    skipped: r.warnings
      .map((w) => w.message)
      .filter((m) => m.includes("not debuggable")),
  };
}

const SKIP80 = (path: string, type: string): string =>
  `${path} is not debuggable: ${type} without a length holds 80 characters here, but the debug dispatch addresses strings as ${type}(254). Declare it as ${type}(254) to expose it.`;

const ARRAY80 = (path: string): string =>
  `${path} is not debuggable: its elements are STRING without a length, which holds 80 characters here, but the debug dispatch addresses strings as STRING(254). Declare them as STRING(254) to expose them.`;

describe("debug table and STRING lengths", () => {
  for (const [label, opts] of [
    ["--feature", { features: ["+string_default_80"] }],
    ["a dialect profile", { dialect: PROFILE }],
  ] as const) {
    it(`skips every 80-character string, array elements included (${label})`, () => {
      const d = debug(opts);
      expect(d.leaves).toEqual(["I.K STRING 127"]);
      expect(d.skipped).toEqual(
        expect.arrayContaining([
          SKIP80("I.S", "STRING"),
          SKIP80("I.W", "WSTRING"),
          SKIP80("I.ST.S", "STRING"),
          ARRAY80("I.ARR"),
          ARRAY80("I.TAS"),
          "I.E is not debuggable: its elements are declared STRING(10), but the debug dispatch addresses strings as STRING(254). Declare them as STRING(254) to expose them.",
        ]),
      );
      expect(d.skipped.filter((m) => m.startsWith("I.ARR"))).toEqual([
        ARRAY80("I.ARR"),
      ]);
    });
  }

  it("without the feature registers the plain strings and skips STRING(10) elements", () => {
    const d = debug({});
    expect(d.leaves).toEqual([
      "I.S STRING 127",
      "I.W WSTRING 253",
      "I.ST.S STRING 127",
      "I.ST.W WSTRING 253",
      "I.ARR[0] STRING 127",
      "I.ARR[1] STRING 127",
      "I.TAS[0] STRING 127",
      "I.TAS[1] STRING 127",
      "I.K STRING 127",
    ]);
    expect(d.skipped).toEqual([
      "I.E is not debuggable: its elements are declared STRING(10), but the debug dispatch addresses strings as STRING(254). Declare them as a plain STRING to expose them.",
    ]);
  });

  it("warns once for a large ARRAY OF STRING, not once per element", () => {
    const r = compile(
      `PROGRAM Main
VAR big : ARRAY[0..1999] OF STRING; END_VAR
END_PROGRAM
CONFIGURATION C
RESOURCE R ON PLC
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM I WITH T : Main;
END_RESOURCE
END_CONFIGURATION
`,
      { headerFileName: "generated.hpp", features: ["+string_default_80"] },
    );
    expect(r.errors).toEqual([]);
    expect(
      r.warnings
        .map((w) => w.message)
        .filter((m) => m.includes("not debuggable")),
    ).toEqual([ARRAY80("I.BIG")]);
    expect(r.debugMap?.leaves ?? []).toEqual([]);
  });

  for (const [label, opts] of [
    ["with the feature", { features: ["+string_default_80"] }],
    ["without it", {}],
  ] as const) {
    it(`skips the array elements and STRUCT fields of a library compiled with the feature (${label})`, () => {
      const lib = compileStlib(
        [
          {
            source: `TYPE LT : STRUCT s : STRING; n : INT; END_STRUCT; END_TYPE
FUNCTION_BLOCK FB_Lib80
VAR_INPUT si : STRING; ai : ARRAY[0..1] OF STRING; st : LT; END_VAR
END_FUNCTION_BLOCK
`,
            fileName: "l.st",
          },
        ],
        {
          name: "l80",
          version: "1.0.0",
          namespace: "l80",
          features: ["+string_default_80"],
        },
      );
      expect(lib.errors).toEqual([]);
      const archive = loadStlibArchive(JSON.parse(JSON.stringify(lib.archive)));
      const r = compile(
        `PROGRAM Main
VAR lfb80 : FB_Lib80; lt : LT; END_VAR
END_PROGRAM
CONFIGURATION C
RESOURCE R ON PLC
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM I WITH T : Main;
END_RESOURCE
END_CONFIGURATION
`,
        { headerFileName: "generated.hpp", libraries: [archive], ...opts },
      );
      expect(r.errors).toEqual([]);
      expect((r.debugMap?.leaves ?? []).map((l) => l.path)).toEqual([
        "I.LFB80.ST.N",
        "I.LT.N",
      ]);
      const skipped = r.warnings
        .map((w) => w.message)
        .filter((m) => m.includes("not debuggable"))
        .map((m) => m.slice(0, m.indexOf(" is not debuggable")));
      expect(skipped).toEqual([
        "I.LFB80.SI",
        "I.LFB80.AI",
        "I.LFB80.ST.S",
        "I.LT.S",
      ]);
    });
  }
});
