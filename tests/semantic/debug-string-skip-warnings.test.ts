// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * The "not debuggable" warnings for STRINGs the debug dispatch cannot
 * address: one per member of an array's elements (its indices written
 * `[*]`), not one per element; and for a member a library declares, advice
 * that does not ask the program to redeclare it.
 */
import { describe, it, expect } from "vitest";
import { compile, compileStlib, type CompileOptions } from "../../src/index.js";
import { loadStlibArchive } from "../../src/library/library-loader.js";
import { collapseElementSkips } from "../../src/backend/debug-table-gen.js";

const CONFIG = `CONFIGURATION C
RESOURCE R ON PLC
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM I WITH T : Main;
END_RESOURCE
END_CONFIGURATION
`;

function skipped(source: string, opts: Partial<CompileOptions>): string[] {
  const r = compile(source + CONFIG, {
    headerFileName: "generated.hpp",
    ...opts,
  });
  expect(r.errors).toEqual([]);
  return r.warnings
    .map((w) => w.message)
    .filter((m) => m.includes("not debuggable"));
}

const SKIP80 = (path: string): string =>
  `${path} is not debuggable: STRING without a length holds 80 characters here, but the debug dispatch addresses strings as STRING(254). Declare it as STRING(254) to expose it.`;

describe("debug table: one warning per array member", () => {
  it("warns once per STRING field of an ARRAY OF STRUCT, not once per element", () => {
    const messages = skipped(
      `TYPE ST_S : STRUCT a : STRING; b : STRING; n : INT; END_STRUCT; END_TYPE
PROGRAM Main
VAR arr : ARRAY[0..2] OF ST_S; m : ARRAY[0..1, 0..1] OF ST_S; one : ST_S; END_VAR
END_PROGRAM
`,
      { features: ["+string_default_80"] },
    );
    expect(messages).toEqual([
      SKIP80("I.ARR[*].A"),
      SKIP80("I.ARR[*].B"),
      SKIP80("I.M[*][*].A"),
      SKIP80("I.M[*][*].B"),
      SKIP80("I.ONE.A"),
      SKIP80("I.ONE.B"),
    ]);
  });

  it("keeps one element's warning as it is, and separates different reasons", () => {
    expect(
      collapseElementSkips([
        { path: "I.A[0].S", reason: "r1" },
        { path: "I.B[0].S", reason: "r1" },
        { path: "I.B[1].S", reason: "r1" },
        { path: "I.B[2].S", reason: "r2" },
      ]),
    ).toEqual([
      { path: "I.A[0].S", reason: "r1" },
      { path: "I.B[*].S", reason: "r1" },
      { path: "I.B[2].S", reason: "r2" },
    ]);
  });
});

describe("debug table: advice for a library's members", () => {
  const lib = compileStlib(
    [
      {
        source: `TYPE ST_L : STRUCT s : STRING; END_STRUCT; END_TYPE
FUNCTION_BLOCK FB_L
VAR_INPUT s : STRING; arr : ARRAY[0..1] OF STRING; END_VAR
VAR_OUTPUT rec : ST_L; END_VAR
END_FUNCTION_BLOCK
`,
        fileName: "l.st",
      },
    ],
    {
      name: "l",
      version: "1.0.0",
      namespace: "l",
      features: ["+string_default_80"],
    },
  );
  const libraries = [loadStlibArchive(JSON.parse(JSON.stringify(lib.archive)))];

  it("says a library member cannot be exposed instead of asking to redeclare it", () => {
    const messages = skipped(
      `PROGRAM Main
VAR fb : FB_L; rec : ST_L; s : STRING; END_VAR
END_PROGRAM
`,
      { features: ["+string_default_80"], libraries },
    );
    const tail = (owner: string, plural = false): string =>
      `but the debug dispatch addresses strings as STRING(254). ${plural ? "They are" : "It is"} declared in the library type ${owner}, so ${plural ? "they" : "it"} cannot be exposed here.`;
    expect(messages).toEqual([
      `I.FB.S is not debuggable: STRING without a length holds 80 characters in its library, ${tail("FB_L")}`,
      `I.FB.ARR is not debuggable: its elements are STRING without a length, which holds 80 characters in its library, ${tail("FB_L", true)}`,
      `I.FB.REC.S is not debuggable: STRING without a length holds 80 characters in its library, ${tail("FB_L")}`,
      `I.REC.S is not debuggable: STRING without a length holds 80 characters in its library, ${tail("ST_L")}`,
      SKIP80("I.S"),
    ]);
  });
});

describe("debug table: a library's STRING members of a written length", () => {
  for (const [mode, features] of [
    ["254", []],
    ["string_default_80", ["+string_default_80"]],
  ] as const) {
    it(`leaves a library FB output and STRUCT field STRING(20) out, as declared STRING(20) (${mode})`, () => {
      const lib = compileStlib(
        [
          {
            source: `TYPE ST_L : STRUCT s : STRING(20); END_STRUCT; END_TYPE
FUNCTION_BLOCK FB_L
VAR_OUTPUT o : STRING(20); e : STRING(254); END_VAR
END_FUNCTION_BLOCK
`,
            fileName: "l.st",
          },
        ],
        {
          name: "l",
          version: "1.0.0",
          namespace: "l",
          features: [...features],
        },
      );
      expect(lib.errors).toEqual([]);
      const r = compile(
        `PROGRAM Main
VAR fb : FB_L; rec : ST_L; END_VAR
END_PROGRAM
` + CONFIG,
        {
          headerFileName: "generated.hpp",
          features: [...features],
          libraries: [
            loadStlibArchive(JSON.parse(JSON.stringify(lib.archive))),
          ],
        },
      );
      expect(r.errors).toEqual([]);
      expect((r.debugMap?.leaves ?? []).map((l) => l.path)).toEqual(["I.FB.E"]);
      const tail =
        "but the debug dispatch addresses strings as STRING(254). It is declared in the library type";
      expect(
        r.warnings
          .map((w) => w.message)
          .filter((m) => m.includes("not debuggable")),
      ).toEqual([
        `I.FB.O is not debuggable: declared STRING(20), ${tail} FB_L, so it cannot be exposed here.`,
        `I.REC.S is not debuggable: declared STRING(20), ${tail} ST_L, so it cannot be exposed here.`,
      ]);
    });
  }
});
