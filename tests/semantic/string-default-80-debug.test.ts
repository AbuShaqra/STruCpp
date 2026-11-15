// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * The debug table and string_default_80: a STRING or WSTRING of another
 * length than 254 (the plain one under the feature, an explicit STRING(n)
 * scalar or ARRAY element) is skipped with a warning that gives the right
 * advice, never registered with the 254-character size. The feature reached
 * through a dialect profile behaves as the --feature form.
 */
import { describe, it, expect } from "vitest";
import { compile, type CompileOptions } from "../../src/index.js";
import type { DialectProfile } from "../../src/dialect.js";

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
          SKIP80("I.ARR[0]", "STRING"),
          SKIP80("I.TAS[1]", "STRING"),
          "I.E[0] is not debuggable: declared STRING(10), but the debug dispatch addresses strings as STRING(254). Declare it as STRING(254) to expose it.",
        ]),
      );
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
      "I.E[0] is not debuggable: declared STRING(10), but the debug dispatch addresses strings as STRING(254). Declare it as a plain STRING to expose it.",
      "I.E[1] is not debuggable: declared STRING(10), but the debug dispatch addresses strings as STRING(254). Declare it as a plain STRING to expose it.",
    ]);
  });
});
