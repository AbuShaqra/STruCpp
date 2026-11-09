/**
 * Dialect profiles: resolveDialect with injected file access, so every case
 * is pure (no file system).
 */
import { describe, it, expect } from "vitest";
import {
  resolveDialect,
  profilesWithFeature,
  DialectError,
  DEFAULT_FEATURES,
  KNOWN_FEATURES,
  IEC_PROFILE,
  type DialectRequest,
  type ResolvedDialect,
} from "../../src/dialect.js";
import { SemanticAnalyzer } from "../../src/semantic/analyzer.js";

/** An in-memory folder tree: path -> file text. */
function fakeFs(files: Record<string, string>): {
  readFile: (p: string) => string;
  listDir: (d: string) => string[];
} {
  return {
    readFile: (p) => {
      const text = files[p];
      if (text === undefined) throw new Error(`ENOENT: ${p}`);
      return text;
    },
    listDir: (d) => {
      const prefix = d.endsWith("/") ? d : `${d}/`;
      const names = Object.keys(files)
        .filter((p) => p.startsWith(prefix))
        .map((p) => p.slice(prefix.length))
        .filter((n) => !n.includes("/"));
      if (names.length === 0) throw new Error(`ENOENT: ${d}`);
      return names;
    },
  };
}

function profile(o: Record<string, unknown>): string {
  return JSON.stringify({ name: String(o.id), semantics: {}, ...o });
}

function resolve(
  req: DialectRequest,
  files: Record<string, string> = {},
): ResolvedDialect {
  const io = fakeFs(files);
  return resolveDialect(req, io.readFile, io.listDir);
}

function errorOf(fn: () => unknown): DialectError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DialectError);
    return e as DialectError;
  }
  throw new Error("expected a DialectError");
}

const VENDOR_A = profile({
  id: "vendor-a",
  extends: "iec-3",
  features: ["program_methods", "pointer_to", "reference_to", "ref_assign"],
});

describe("resolveDialect", () => {
  it("no flag gives the default set", () => {
    const d = resolveDialect({});
    expect(d.id).toBeNull();
    expect([...d.features].sort()).toEqual(
      ["pointer_to", "ref_assign", "reference_to"].sort(),
    );
    expect(d.features).toEqual(new Set(DEFAULT_FEATURES));
    expect(d.loaded).toEqual([]);
  });

  it("self_caret is known but in neither the default set nor iec-3", () => {
    expect(KNOWN_FEATURES).toContain("self_caret");
    expect(DEFAULT_FEATURES.has("self_caret")).toBe(false);
    expect(resolveDialect({ features: ["+self_caret"] }).features).toContain(
      "self_caret",
    );
  });

  it("property is known but in neither the default set nor iec-3", () => {
    expect(KNOWN_FEATURES).toContain("property");
    expect(DEFAULT_FEATURES.has("property")).toBe(false);
    expect(resolveDialect({ features: ["+property"] }).features).toContain(
      "property",
    );
  });

  it("postfix_enum_base is known but in neither the default set nor iec-3", () => {
    expect(KNOWN_FEATURES).toContain("postfix_enum_base");
    expect(DEFAULT_FEATURES.has("postfix_enum_base")).toBe(false);
    expect(resolveDialect({ dialect: "iec-3" }).features).not.toContain(
      "postfix_enum_base",
    );
    expect(
      resolveDialect({ features: ["+postfix_enum_base"] }).features,
    ).toContain("postfix_enum_base");
  });

  it("named_global_lists is known but in neither the default set nor iec-3", () => {
    expect(KNOWN_FEATURES).toContain("named_global_lists");
    expect(DEFAULT_FEATURES.has("named_global_lists")).toBe(false);
    expect(resolveDialect({ dialect: "iec-3" }).features).not.toContain(
      "named_global_lists",
    );
    expect(
      resolveDialect({ features: ["+named_global_lists"] }).features,
    ).toContain("named_global_lists");
  });

  it("struct_extends is known but in neither the default set nor iec-3", () => {
    expect(KNOWN_FEATURES).toContain("struct_extends");
    expect(DEFAULT_FEATURES.has("struct_extends")).toBe(false);
    expect(resolveDialect({ dialect: "iec-3" }).features).not.toContain(
      "struct_extends",
    );
    expect(
      resolveDialect({ features: ["+struct_extends"] }).features,
    ).toContain("struct_extends");
  });

  it("union is known but in neither the default set nor iec-3", () => {
    expect(KNOWN_FEATURES).toContain("union");
    expect(DEFAULT_FEATURES.has("union")).toBe(false);
    expect(resolveDialect({ dialect: "iec-3" }).features).not.toContain(
      "union",
    );
    expect(resolveDialect({ features: ["+union"] }).features).toContain(
      "union",
    );
  });

  it("fb_init is known but in neither the default set nor iec-3", () => {
    expect(KNOWN_FEATURES).toContain("fb_init");
    expect(DEFAULT_FEATURES.has("fb_init")).toBe(false);
    expect(resolveDialect({ dialect: "iec-3" }).features).not.toContain(
      "fb_init",
    );
    expect(resolveDialect({ features: ["+fb_init"] }).features).toContain(
      "fb_init",
    );
  });

  it("iec-3 has no features", () => {
    const d = resolveDialect({ dialect: "iec-3" });
    expect(d.id).toBe("iec-3");
    expect(d.features.size).toBe(0);
    expect(IEC_PROFILE).toEqual({
      id: "iec-3",
      name: "IEC 61131-3 Ed. 3 (2013)",
      features: [],
      semantics: {},
    });
  });

  it("the default is no profile, not iec-3, and keeps its three features", () => {
    const d = resolveDialect({});
    expect(d.id).toBeNull();
    expect([...d.features].sort()).toEqual([
      "pointer_to",
      "ref_assign",
      "reference_to",
    ]);
    expect(resolveDialect({ dialect: "iec-3" }).features.size).toBe(0);
  });

  it("the id 'iec' is refused with a hint naming iec-3", () => {
    expect(errorOf(() => resolveDialect({ dialect: "iec" })).message).toBe(
      "unknown dialect 'iec' (known: iec-3); the IEC 61131-3 Ed. 3 profile is 'iec-3'",
    );
    const e = errorOf(() =>
      resolve(
        { dialect: "iec", dialectPath: ["dir"] },
        { "dir/vendor-a.json": VENDOR_A },
      ),
    );
    expect(e.message).toBe(
      "unknown dialect 'iec' (known: iec-3, vendor-a); the IEC 61131-3 Ed. 3 profile is 'iec-3'",
    );
  });

  it("a profile extending 'iec' is refused with a hint naming iec-3", () => {
    const old = profile({ id: "old", extends: "iec", features: [] });
    expect(
      errorOf(() =>
        resolve({ dialectFiles: ["p/old.json"] }, { "p/old.json": old }),
      ).message,
    ).toBe(
      "dialect 'old': extends 'iec', which is not loaded; the IEC 61131-3 Ed. 3 profile is 'iec-3'",
    );
    expect(
      errorOf(() =>
        resolveDialect({
          dialect: {
            id: "obj",
            name: "Obj",
            extends: "iec",
            features: [],
            semantics: {},
          },
        }),
      ).message,
    ).toBe(
      "dialect 'obj': extends 'iec', which is not loaded; the IEC 61131-3 Ed. 3 profile is 'iec-3'",
    );
  });

  it("a loaded profile whose own id is 'iec' is refused as reserved", () => {
    const own = profile({ id: "iec", features: ["pointer_to"] });
    expect(
      errorOf(() =>
        resolve({ dialectFiles: ["p/x.json"] }, { "p/x.json": own }),
      ).message,
    ).toBe(
      "dialect file p/x.json: the id 'iec' is reserved; the IEC 61131-3 Ed. 3 profile is 'iec-3'",
    );
    expect(
      errorOf(() =>
        resolve(
          { dialect: "iec-3", dialectPath: ["dir"] },
          { "dir/iec.json": own },
        ),
      ).message,
    ).toBe(
      "dialect file dir/iec.json: the id 'iec' is reserved; the IEC 61131-3 Ed. 3 profile is 'iec-3'",
    );
    expect(
      errorOf(() =>
        resolveDialect({
          dialect: { id: "iec", name: "Mine", features: [], semantics: {} },
        }),
      ).message,
    ).toBe(
      "dialect 'iec': the id 'iec' is reserved; the IEC 61131-3 Ed. 3 profile is 'iec-3'",
    );
  });

  it("an unknown id other than 'iec' gets no iec-3 hint", () => {
    expect(errorOf(() => resolveDialect({ dialect: "iec-4" })).message).toBe(
      "unknown dialect 'iec-4' (known: iec-3)",
    );
  });

  it("a file profile extending iec-3 adds its features", () => {
    const d = resolve(
      { dialectFiles: ["p/mine.json"] },
      {
        "p/mine.json": profile({
          id: "mine",
          extends: "iec-3",
          features: ["program_methods"],
        }),
      },
    );
    expect(d.id).toBe("mine");
    expect([...d.features]).toEqual(["program_methods"]);
    expect(d.loaded.map((p) => p.id)).toEqual(["mine"]);
  });

  it("--dialect picks a profile from --dialect-path", () => {
    const d = resolve(
      { dialect: "vendor-a", dialectPath: ["dir"] },
      {
        "dir/vendor-a.json": VENDOR_A,
        "dir/other.json": profile({ id: "other", features: [] }),
      },
    );
    expect(d.id).toBe("vendor-a");
    expect([...d.features].sort()).toEqual([
      "pointer_to",
      "program_methods",
      "ref_assign",
      "reference_to",
    ]);
  });

  it("an extends child inherits the parent's features", () => {
    const d = resolve(
      { dialect: "child", dialectPath: ["dir"] },
      {
        "dir/vendor-a.json": VENDOR_A,
        "dir/child.json": profile({
          id: "child",
          extends: "vendor-a",
          features: [],
        }),
      },
    );
    expect(d.features.has("program_methods")).toBe(true);
  });

  it("--feature -pointer_to removes from the default set", () => {
    const d = resolveDialect({ features: ["-pointer_to"] });
    expect(d.id).toBeNull();
    expect([...d.features].sort()).toEqual(["ref_assign", "reference_to"]);
  });

  it("--feature +program_methods under iec-3 adds it", () => {
    const d = resolveDialect({
      dialect: "iec-3",
      features: ["+program_methods"],
    });
    expect([...d.features]).toEqual(["program_methods"]);
    const bare = resolveDialect({ dialect: "iec-3", features: ["ref_assign"] });
    expect([...bare.features]).toEqual(["ref_assign"]);
  });

  it("--feature overrides apply in order", () => {
    const d = resolveDialect({
      dialect: "iec-3",
      features: ["+pointer_to", "-pointer_to", "+ref_assign"],
    });
    expect([...d.features]).toEqual(["ref_assign"]);
  });

  it("an unknown --feature is an error", () => {
    expect(errorOf(() => resolveDialect({ features: ["+goto"] })).message).toBe(
      "unknown feature 'goto' in --feature (known: program_methods, pointer_to, reference_to, ref_assign, self_caret, property, postfix_enum_base, named_global_lists, struct_extends, union, fb_init, trunc_dint)",
    );
  });

  it("unknown feature in a file is an error naming the file", () => {
    const e = errorOf(() =>
      resolve(
        { dialectFiles: ["p/x.json"] },
        { "p/x.json": profile({ id: "x", features: ["goto"] }) },
      ),
    );
    expect(e.message).toBe(
      "unknown feature 'goto' in dialect file p/x.json (known: program_methods, pointer_to, reference_to, ref_assign, self_caret, property, postfix_enum_base, named_global_lists, struct_extends, union, fb_init, trunc_dint)",
    );
  });

  it("unknown dialect lists the known ids", () => {
    const e = errorOf(() =>
      resolve(
        { dialect: "nope", dialectPath: ["dir"] },
        { "dir/vendor-a.json": VENDOR_A },
      ),
    );
    expect(e.message).toBe("unknown dialect 'nope' (known: iec-3, vendor-a)");
    expect(errorOf(() => resolveDialect({ dialect: "nope" })).message).toBe(
      "unknown dialect 'nope' (known: iec-3)",
    );
  });

  it("extends cycle is an error", () => {
    const e = errorOf(() =>
      resolve(
        { dialectPath: ["dir"] },
        {
          "dir/a.json": profile({ id: "a", extends: "b", features: [] }),
          "dir/b.json": profile({ id: "b", extends: "a", features: [] }),
        },
      ),
    );
    expect(e.message).toBe("dialect 'a': extends cycle a -> b -> a");
  });

  it("a missing extends target is an error", () => {
    const e = errorOf(() =>
      resolve(
        { dialectFiles: ["p/a.json"] },
        { "p/a.json": profile({ id: "a", extends: "ghost", features: [] }) },
      ),
    );
    expect(e.message).toBe("dialect 'a': extends 'ghost', which is not loaded");
  });

  it("invalid JSON is an error naming the file", () => {
    const e = errorOf(() =>
      resolve({ dialectFiles: ["p/a.json"] }, { "p/a.json": "{ not json" }),
    );
    expect(e.message).toMatch(/^dialect file p\/a\.json: /);
  });

  it("semantics keys are refused", () => {
    const e = errorOf(() =>
      resolve(
        { dialectFiles: ["p/a.json"] },
        {
          "p/a.json": JSON.stringify({
            id: "a",
            name: "A",
            features: [],
            semantics: { trunc_result: "INT" },
          }),
        },
      ),
    );
    expect(e.message).toBe(
      "dialect file p/a.json: semantics key 'trunc_result' is not known",
    );
  });

  it("id must match the file name in --dialect-path", () => {
    const e = errorOf(() =>
      resolve({ dialectPath: ["dir"] }, { "dir/vendor-b.json": VENDOR_A }),
    );
    expect(e.message).toBe(
      "dialect file dir/vendor-b.json: id 'vendor-a' does not match the file name",
    );
    // --dialect-file has no such rule
    const d = resolve(
      { dialectFiles: ["p/any.json"] },
      { "p/any.json": VENDOR_A },
    );
    expect(d.id).toBe("vendor-a");
  });

  it("loaded lists every profile in --dialect-path", () => {
    const d = resolve(
      { dialectPath: ["d1", "d2"] },
      {
        "d1/vendor-a.json": VENDOR_A,
        "d1/notes.txt": "not a profile",
        "d2/zeta.json": profile({ id: "zeta", features: [] }),
        "d2/beta.json": profile({ id: "beta", features: ["ref_assign"] }),
      },
    );
    expect(d.id).toBeNull();
    expect(d.features).toEqual(new Set(DEFAULT_FEATURES));
    expect(d.loaded.map((p) => p.id)).toEqual(["vendor-a", "beta", "zeta"]);
  });

  it("profilesWithFeature is sorted", () => {
    const d = resolve(
      { dialectPath: ["dir"] },
      {
        "dir/zz.json": profile({ id: "zz", features: ["pointer_to"] }),
        "dir/aa.json": profile({ id: "aa", features: ["pointer_to"] }),
        "dir/mm.json": profile({ id: "mm", features: [] }),
      },
    );
    expect(profilesWithFeature(d, "pointer_to")).toEqual(["aa", "zz"]);
    expect(profilesWithFeature(d, "program_methods")).toEqual([]);
  });

  it("profilesWithFeature names a profile that only inherits the feature", () => {
    const d = resolve(
      { dialectPath: ["dir"] },
      {
        "dir/vendor-a.json": VENDOR_A,
        "dir/child.json": profile({
          id: "child",
          extends: "vendor-a",
          features: [],
        }),
      },
    );
    expect(profilesWithFeature(d, "program_methods")).toEqual([
      "child",
      "vendor-a",
    ]);
  });

  it("a bad file in --dialect-path is an error even when another id is selected", () => {
    const e = errorOf(() =>
      resolve(
        { dialect: "vendor-a", dialectPath: ["dir"] },
        {
          "dir/vendor-a.json": VENDOR_A,
          "dir/broken.json": profile({ id: "broken", features: ["goto"] }),
        },
      ),
    );
    expect(e.message).toContain("dialect file dir/broken.json");
    const iec = errorOf(() =>
      resolve(
        { dialect: "iec-3", dialectPath: ["dir"] },
        { "dir/broken.json": "[" },
      ),
    );
    expect(iec.message).toMatch(/^dialect file dir\/broken\.json: /);
  });

  it("a profile object is validated, loaded and selected", () => {
    const d = resolveDialect({
      dialect: {
        id: "obj",
        name: "Obj",
        extends: "iec-3",
        features: ["program_methods"],
        semantics: {},
      },
    });
    expect(d.id).toBe("obj");
    expect([...d.features]).toEqual(["program_methods"]);
    expect(d.loaded.map((p) => p.id)).toEqual(["obj"]);
    const e = errorOf(() =>
      resolveDialect({
        dialect: {
          id: "bad",
          name: "Bad",
          features: ["goto" as "pointer_to"],
          semantics: {},
        },
      }),
    );
    expect(e.message).toContain("unknown feature 'goto' in dialect 'bad'");
  });

  it("files or folders without a reader are an error", () => {
    expect(
      errorOf(() => resolveDialect({ dialectFiles: ["a.json"] })).message,
    ).toBe("dialect files need a file reader");
  });

  it("an unreadable file or folder is a DialectError", () => {
    expect(
      errorOf(() => resolve({ dialectFiles: ["p/missing.json"] })).message,
    ).toBe("dialect file p/missing.json: ENOENT: p/missing.json");
    expect(errorOf(() => resolve({ dialectPath: ["nodir"] })).message).toBe(
      "dialect path nodir: ENOENT: nodir",
    );
  });
});

describe("SemanticAnalyzer features", () => {
  it("defaults to the default set and takes the dialect's features", () => {
    expect(new SemanticAnalyzer().features).toBe(DEFAULT_FEATURES);
    const iec = resolveDialect({ dialect: "iec-3" });
    expect(new SemanticAnalyzer({ dialect: iec }).features).toBe(iec.features);
    const own = new Set(["program_methods"]);
    expect(new SemanticAnalyzer({ dialect: iec, features: own }).features).toBe(
      own,
    );
  });
});
