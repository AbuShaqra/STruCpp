// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * Conditional pragmas in library compilation: compileStlib forwards
 * pragmaDefines, the archive records them, and library.json accepts them.
 */
import { describe, it, expect } from "vitest";
import { compileStlib } from "../../src/library/library-compiler.js";
import { loadStlibFromString } from "../../src/library/library-loader.js";
import { loadLibraryConfigFromString } from "../../src/library/library-config.js";

const LIB = `FUNCTION F : INT
VAR_INPUT a : INT; END_VAR
{IF defined(FAST)}
F := a + 100;
{ELSIF hasvalue(LEVEL, 'two')}
F := a + 222;
{ELSE}
F := a + 7;
{END_IF}
END_FUNCTION
`;

const PLAIN_LIB = `FUNCTION G : INT
VAR_INPUT a : INT; END_VAR
G := a;
END_FUNCTION
`;

const BASE = { name: "cond-lib", version: "1.0.0", namespace: "cond_lib" };

function chunkText(defines?: Record<string, string>): string {
  const r = compileStlib([{ source: LIB, fileName: "lib.st" }], {
    ...BASE,
    features: ["+conditional_pragmas"],
    ...(defines ? { pragmaDefines: defines } : {}),
  });
  expect(r.errors).toEqual([]);
  expect(r.success).toBe(true);
  return JSON.stringify(r.archive.chunks);
}

describe("compileStlib with pragmaDefines", () => {
  it("the archive chunks hold only the active branch", () => {
    const fast = chunkText({ FAST: "" });
    expect(fast).toContain("100");
    expect(fast).not.toContain("222");
    expect(fast).not.toContain("+ 7");
    const two = chunkText({ LEVEL: "two" });
    expect(two).toContain("222");
    expect(two).not.toContain("100");
    const none = chunkText();
    expect(none).toContain("+ 7");
    expect(none).not.toContain("100");
  });

  it("records the defines in the archive exactly when the feature is on", () => {
    const withDefines = compileStlib([{ source: LIB, fileName: "lib.st" }], {
      ...BASE,
      features: ["+conditional_pragmas"],
      pragmaDefines: { FAST: "" },
    });
    expect(withDefines.archive.pragmaDefines).toEqual({ FAST: "" });
    const loaded = loadStlibFromString(JSON.stringify(withDefines.archive));
    expect(loaded.pragmaDefines).toEqual({ FAST: "" });

    // Feature on, no define: recorded empty, so readers still resolve pragmas.
    const noDefines = compileStlib([{ source: LIB, fileName: "lib.st" }], {
      ...BASE,
      features: ["+conditional_pragmas"],
    });
    expect(noDefines.archive.pragmaDefines).toEqual({});

    // Feature off: no key, even with defines (they only fed global constants).
    const plain = compileStlib([{ source: PLAIN_LIB, fileName: "plain.st" }], {
      ...BASE,
      pragmaDefines: { FAST: "" },
    });
    expect(plain.success).toBe(true);
    expect("pragmaDefines" in plain.archive).toBe(false);
  });

  it("without the feature the library is refused with the hint", () => {
    const r = compileStlib([{ source: LIB, fileName: "lib.st" }], {
      ...BASE,
      pragmaDefines: { FAST: "" },
    });
    expect(r.success).toBe(false);
    expect(r.errors[0]).toMatchObject({ file: "lib.st", line: 3 });
    expect(r.errors[0]!.message).toContain(
      "they need the feature conditional_pragmas",
    );
  });

  it("the loader refuses a pragmaDefines value that is not a string", () => {
    const r = compileStlib([{ source: LIB, fileName: "lib.st" }], {
      ...BASE,
      features: ["+conditional_pragmas"],
    });
    const raw = { ...r.archive, pragmaDefines: { FAST: 1 } };
    expect(() => loadStlibFromString(JSON.stringify(raw))).toThrow(
      /pragmaDefines\["FAST"\] must be a string/,
    );
    const notMap = { ...r.archive, pragmaDefines: ["FAST"] };
    expect(() => loadStlibFromString(JSON.stringify(notMap))).toThrow(
      /pragmaDefines must be an object/,
    );
  });

  it("the loader refuses a pragmaDefines key that is not an identifier", () => {
    const r = compileStlib([{ source: LIB, fileName: "lib.st" }], {
      ...BASE,
      features: ["+conditional_pragmas"],
    });
    const raw = { ...r.archive, pragmaDefines: { "1 X": "" } };
    expect(() => loadStlibFromString(JSON.stringify(raw))).toThrow(
      /pragmaDefines key "1 X" is not an identifier/,
    );
  });
});

describe("library.json pragmaDefines", () => {
  const base = { name: "x", version: "1.0.0", namespace: "x" };
  it("accepts a name → string map", () => {
    const c = loadLibraryConfigFromString(
      JSON.stringify({ ...base, pragmaDefines: { FAST: "", MODE: "a" } }),
      "library.json",
    );
    expect(c.pragmaDefines).toEqual({ FAST: "", MODE: "a" });
  });
  it("refuses a non-string value, a bad key and a non-object", () => {
    for (const pragmaDefines of [{ FAST: 1 }, { "1X": "" }, ["FAST"]]) {
      expect(() =>
        loadLibraryConfigFromString(
          JSON.stringify({ ...base, pragmaDefines }),
          "library.json",
        ),
      ).toThrow(/library\.json: .*pragmaDefines/);
    }
  });
});
