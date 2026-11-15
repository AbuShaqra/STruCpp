// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Feature string_default_80: a STRING or WSTRING with no length written holds
 * 80 characters. Covers the lowering, the library manifest field
 * `stringDefaultLength` (absent = 254), the VAR_IN_OUT warning between two
 * default lengths, and test files. Without the feature nothing changes.
 */
import { describe, it, expect } from "vitest";
import { analyze, compile, compileStlib } from "../../src/index.js";
import {
  loadLibraryManifest,
  loadStlibArchive,
} from "../../src/library/library-loader.js";
import { parseTestFile } from "../../src/testing/test-parser.js";
import { KNOWN_FEATURES } from "../../src/dialect.js";
import { defaultStringLength } from "../../src/semantic/string-default-length.js";
import type { StlibArchive } from "../../src/library/library-manifest.js";

const ON = { features: ["+string_default_80"] };

function library(features: string[]): StlibArchive {
  const lib = compileStlib(
    [
      {
        source: `FUNCTION_BLOCK FB_Io
VAR_IN_OUT s : STRING; w : WSTRING; END_VAR
VAR_INPUT n : STRING(10); END_VAR
s := CONCAT(s, 'x');
END_FUNCTION_BLOCK
FUNCTION F_Text : STRING
VAR_INPUT a : STRING; END_VAR
F_Text := a;
END_FUNCTION
FUNCTION_BLOCK FB_Ref
VAR_INPUT r : REFERENCE TO STRING; END_VAR
END_FUNCTION_BLOCK
`,
        fileName: "lib.st",
      },
    ],
    {
      name: "strlib",
      version: "1.0.0",
      namespace: "strlib",
      features: ["+reference_to", ...features],
    },
  );
  expect(lib.errors).toEqual([]);
  return loadStlibArchive(JSON.parse(JSON.stringify(lib.archive)));
}

const inOutWarnings = (w: { message: string }[]): string[] =>
  w.map((d) => d.message).filter((m) => m.includes("VAR_IN_OUT"));

describe("feature string_default_80", () => {
  it("is a known feature and sets the default length", () => {
    expect(KNOWN_FEATURES).toContain("string_default_80");
    expect(defaultStringLength(new Set(["string_default_80"]))).toBe(80);
    expect(defaultStringLength(new Set())).toBe(254);
  });

  it("gives a plain STRING and WSTRING 80 characters, in every place a type is written", () => {
    const src = `TYPE ST_A : STRUCT s : STRING; END_STRUCT; END_TYPE
TYPE T_S : STRING; END_TYPE
FUNCTION F_S : STRING
VAR_INPUT a : WSTRING; END_VAR
F_S := 'a';
END_FUNCTION
PROGRAM Main
VAR s : STRING; w : WSTRING; arr : ARRAY[0..1] OF STRING; t : STRING(10); n : DINT; END_VAR
n := SIZEOF(s) + SIZEOF(w);
END_PROGRAM
`;
    const on = compile(src, ON);
    expect(on.errors).toEqual([]);
    const code = `${on.headerCode}\n${on.cppCode}`;
    expect(code).toContain("IECStringVar<80>");
    expect(code).toContain("IECWStringVar<80>");
    expect(code).toContain("IECStringVar<10>");
    expect(code).not.toContain("<254>");
    const off = compile(src, {});
    expect(off.errors).toEqual([]);
    expect(`${off.headerCode}\n${off.cppCode}`).not.toContain("<80>");
    const iec = compile(src, { dialect: "iec-3" });
    expect(`${iec.headerCode}\n${iec.cppCode}`).not.toContain("<80>");
  });

  it("writes stringDefaultLength 80 into a library's manifest, and none without it", () => {
    expect(library(["+string_default_80"]).manifest.stringDefaultLength).toBe(
      80,
    );
    expect(library([]).manifest.stringDefaultLength).toBeUndefined();
  });

  it("refuses a manifest stringDefaultLength that is not a positive integer", () => {
    const manifest = { ...library([]).manifest } as Record<string, unknown>;
    for (const bad of [0, -1, 1.5, "80"]) {
      expect(() =>
        loadLibraryManifest({ ...manifest, stringDefaultLength: bad }),
      ).toThrow(/stringDefaultLength/);
    }
  });

  it("passes a plain STRING to a library's plain STRING VAR_IN_OUT of the other default with no warning", () => {
    const body = `PROGRAM Main
VAR f : FB_Io; s : STRING; w : WSTRING; END_VAR
f(s := s, w := w);
END_PROGRAM
`;
    for (const [lib, opts] of [
      [library(["+string_default_80"]), {}],
      [library([]), ON],
      [library(["+string_default_80"]), { dialect: "iec-3" }],
    ] as const) {
      const r = analyze(body, { ...opts, libraries: [lib] });
      expect(r.errors).toEqual([]);
      expect(inOutWarnings(r.warnings)).toEqual([]);
    }
  });

  it("still warns when a length is written on one side", () => {
    const r = analyze(
      `PROGRAM Main
VAR f : FB_Io; s : STRING(80); w : WSTRING; END_VAR
f(s := s, w := w);
END_PROGRAM
`,
      { libraries: [library([])] },
    );
    expect(inOutWarnings(r.warnings)).toHaveLength(1);
    expect(inOutWarnings(r.warnings)[0]).toContain("STRING(80)");
  });

  it("still refuses a REFERENCE TO STRING of the other default length", () => {
    const r = analyze(
      `PROGRAM Main
VAR f : FB_Ref; s : STRING; END_VAR
f(r := s);
END_PROGRAM
`,
      { ...ON, libraries: [library(["+reference_to"])] },
    );
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("lowers a test file's plain STRING too", () => {
    const src = `TEST 'len'
  VAR s : STRING; END_VAR
  ASSERT_EQ(SIZEOF(s), 81);
END_TEST
`;
    const on = parseTestFile(src, "t.st", ON);
    expect(on.errors).toEqual([]);
    expect(JSON.stringify(on.testFile)).toContain('"maxLength":80');
    const off = parseTestFile(src, "t.st");
    expect(JSON.stringify(off.testFile)).not.toContain('"maxLength":80');
  });
});
