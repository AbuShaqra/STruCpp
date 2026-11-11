// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * Dialect profile settings: validation of the client-supplied profile and
 * its propagation into every DocumentManager analysis.
 */
import { describe, it, expect } from "vitest";
import {
  analyze,
  compile,
  compileStlib,
  type AnalysisResult,
  type CompileOptions,
  type DialectProfile,
} from "strucpp";
import { DocumentManager } from "../../server/src/document-manager.js";
import { NullWorkspaceFs, type WorkspaceFs } from "../../server/src/workspace-fs.js";
import {
  parseDialectSettings,
  dialectOptions,
} from "../../server/src/dialect-settings.js";

const PROGRAM_WITH_METHOD = `PROGRAM Main
  VAR x : INT; END_VAR
  METHOD Inc : INT
    Inc := 1;
  END_METHOD
  x := x + 1;
END_PROGRAM`;

const POINTER_PROGRAM = `PROGRAM Main
  VAR p : POINTER TO INT; x : INT; END_VAR
  x := x + 1;
END_PROGRAM`;

const POINTER_FB = `FUNCTION_BLOCK Holder
  VAR p : POINTER TO INT; END_VAR
END_FUNCTION_BLOCK`;

const PLAIN_PROGRAM = `PROGRAM Main
  VAR x : INT; END_VAR
  x := x + 1;
END_PROGRAM`;

function profile(id: string, features: DialectProfile["features"]): DialectProfile {
  return { id, name: id, extends: "iec-3", features, semantics: {} };
}

const IEC_ONLY = profile("test-plain", []);
const WITH_METHODS = profile("test-methods", ["program_methods"]);
const WITH_POINTERS = profile("test-pointers", ["pointer_to"]);

function messages(result: AnalysisResult | undefined): string[] {
  return (result?.errors ?? []).map((e) => `${e.line}: ${e.message}`);
}

/** A DocumentManager whose analyze function records every options object. */
function recordingManager(fs: WorkspaceFs = NullWorkspaceFs): {
  dm: DocumentManager;
  calls: Array<Partial<CompileOptions> | undefined>;
} {
  const calls: Array<Partial<CompileOptions> | undefined> = [];
  const dm = new DocumentManager((source, options) => {
    calls.push(options);
    return analyze(source, options);
  }, fs);
  return { dm, calls };
}

/** In-memory workspace with one folder `/ws`. */
function memoryFs(files: Record<string, string>): WorkspaceFs {
  return {
    realpath: (p) => (p === "/ws" ? "/ws" : null),
    readDir: (dir) =>
      dir === "/ws"
        ? Object.keys(files).map((name) => ({
            name,
            isDirectory: false,
            isSymbolicLink: false,
          }))
        : null,
    readFile: (p) => files[p.replace(/^\/ws\//, "")] ?? null,
  };
}

describe("parseDialectSettings", () => {
  it("accepts absent values as no selection", () => {
    expect(parseDialectSettings(undefined, undefined)).toEqual({
      ok: true,
      settings: {},
    });
    expect(parseDialectSettings(null, null)).toEqual({ ok: true, settings: {} });
  });

  it("accepts a valid profile object and feature overrides", () => {
    const result = parseDialectSettings(WITH_POINTERS, ["+program_methods"]);
    expect(result).toEqual({
      ok: true,
      settings: { dialect: WITH_POINTERS, features: ["+program_methods"] },
    });
  });

  it("drops an empty feature list", () => {
    expect(parseDialectSettings(WITH_POINTERS, [])).toEqual({
      ok: true,
      settings: { dialect: WITH_POINTERS },
    });
  });

  it("rejects an unknown feature in the profile with the compiler's message", () => {
    const result = parseDialectSettings(
      { id: "test-bad", features: ["no_such_feature"] },
      undefined,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/unknown feature 'no_such_feature'/);
  });

  it("rejects an unknown feature override", () => {
    const result = parseDialectSettings(undefined, ["bogus"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/unknown feature 'bogus'/);
  });

  it("rejects wrong field types", () => {
    const badId = parseDialectSettings({ id: 3, features: [] }, undefined);
    expect(badId.ok).toBe(false);
    if (!badId.ok) expect(badId.message).toMatch(/'id' must be a non-empty string/);

    const badFeatures = parseDialectSettings({ id: "x", features: "pointer_to" }, undefined);
    expect(badFeatures.ok).toBe(false);
    if (!badFeatures.ok) expect(badFeatures.message).toMatch(/'features' must be an array of strings/);
  });

  it("rejects an extends cycle and an unknown parent", () => {
    const cycle = parseDialectSettings({ id: "loop", extends: "loop", features: [] }, undefined);
    expect(cycle.ok).toBe(false);
    if (!cycle.ok) expect(cycle.message).toMatch(/extends cycle/);

    const orphan = parseDialectSettings({ id: "orphan", extends: "missing", features: [] }, undefined);
    expect(orphan.ok).toBe(false);
    if (!orphan.ok) expect(orphan.message).toMatch(/extends 'missing', which is not loaded/);
  });

  it("accepts a profile extending iec-3 and rejects one extending iec with a hint", () => {
    const current = parseDialectSettings({ id: "cur", extends: "iec-3", features: ["pointer_to"] }, undefined);
    expect(current.ok).toBe(true);
    const old = parseDialectSettings({ id: "old", extends: "iec", features: [] }, undefined);
    expect(old.ok).toBe(false);
    if (!old.ok) {
      expect(old.message).toBe(
        "dialect 'old': extends 'iec', which is not loaded; the IEC 61131-3 Ed. 3 profile is 'iec-3'",
      );
    }
  });

  it("rejects a profile whose own id is iec as reserved", () => {
    const result = parseDialectSettings({ id: "iec", features: [] }, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe(
        "dialect 'iec': the id 'iec' is reserved; the IEC 61131-3 Ed. 3 profile is 'iec-3'",
      );
    }
  });

  it("rejects a profile given as a string, number or array", () => {
    for (const value of ["iec", 42, [WITH_POINTERS]]) {
      const result = parseDialectSettings(value, undefined);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toMatch(/must be a profile object/);
    }
  });

  it("rejects features that are not an array of strings", () => {
    for (const value of ["pointer_to", [1], { a: 1 }]) {
      const result = parseDialectSettings(undefined, value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toMatch(/'features' must be an array of strings/);
    }
  });
});

describe("dialectOptions", () => {
  it("carries no dialect or features key when nothing is selected", () => {
    const options = dialectOptions({});
    expect(Object.keys(options)).toEqual([]);
  });

  it("carries the profile object and overrides", () => {
    expect(dialectOptions({ dialect: WITH_METHODS, features: ["pointer_to"] })).toEqual({
      dialect: WITH_METHODS,
      features: ["pointer_to"],
    });
  });
});

describe("DocumentManager dialect selection", () => {
  it("no profile: analysis options carry no dialect or features key", () => {
    const { dm, calls } = recordingManager();
    dm.onDocumentOpen("file:///main.st", PLAIN_PROGRAM);
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty("dialect");
    expect(calls[0]).not.toHaveProperty("features");
  });

  it("no profile: diagnostics equal a plain analyze() call", () => {
    const dm = new DocumentManager(analyze, NullWorkspaceFs);
    for (const src of [PROGRAM_WITH_METHOD, POINTER_PROGRAM]) {
      const state = dm.onDocumentOpen("file:///main.st", src);
      expect(messages(state.analysisResult)).toEqual(
        messages(analyze(src, { fileName: "main.st" })),
      );
    }
  });

  it("program_methods decides whether a PROGRAM METHOD is an error", () => {
    const dm = new DocumentManager(analyze, NullWorkspaceFs);
    dm.setDialect({ dialect: IEC_ONLY });
    const without = dm.onDocumentOpen("file:///main.st", PROGRAM_WITH_METHOD);
    expect(messages(without.analysisResult)).toEqual([
      "3: METHOD in a PROGRAM needs the feature program_methods",
    ]);

    dm.setDialect({ dialect: WITH_METHODS });
    const results = dm.reanalyzeAll();
    expect(messages(results.get("file:///main.st"))).toEqual([]);
  });

  it("pointer_to decides whether POINTER TO is an error", () => {
    const dm = new DocumentManager(analyze, NullWorkspaceFs);
    dm.setDialect({ dialect: IEC_ONLY });
    const without = dm.onDocumentOpen("file:///main.st", POINTER_PROGRAM);
    expect(messages(without.analysisResult)).toEqual([
      "2: POINTER TO needs the feature pointer_to",
    ]);

    dm.setDialect({ dialect: WITH_POINTERS });
    expect(messages(dm.reanalyzeAll().get("file:///main.st"))).toEqual([]);
  });

  it("single-feature overrides are applied on top of the profile", () => {
    const dm = new DocumentManager(analyze, NullWorkspaceFs);
    dm.setDialect({ dialect: IEC_ONLY, features: ["+pointer_to"] });
    const state = dm.onDocumentOpen("file:///main.st", POINTER_PROGRAM);
    expect(messages(state.analysisResult)).toEqual([]);

    // The message also names the loaded profiles that enable the feature.
    dm.setDialect({ dialect: WITH_POINTERS, features: ["-pointer_to"] });
    const overridden = messages(dm.reanalyzeAll().get("file:///main.st"));
    expect(overridden).toHaveLength(1);
    expect(overridden[0]).toMatch(/^2: POINTER TO needs the feature pointer_to/);
  });

  it("clearing the profile restores the no-profile options", () => {
    const { dm, calls } = recordingManager();
    dm.setDialect({ dialect: IEC_ONLY });
    dm.onDocumentOpen("file:///main.st", PLAIN_PROGRAM);
    expect(calls[0]?.dialect).toEqual(IEC_ONLY);
    dm.setDialect({});
    dm.reanalyzeAll();
    expect(calls[1]).not.toHaveProperty("dialect");
    expect(calls[1]).not.toHaveProperty("features");
  });

  it("diagnostics match compile() under the same profile", () => {
    const samples = [PROGRAM_WITH_METHOD, POINTER_PROGRAM, PLAIN_PROGRAM];
    for (const dialect of [IEC_ONLY, WITH_METHODS, WITH_POINTERS]) {
      const dm = new DocumentManager(analyze, NullWorkspaceFs);
      dm.setDialect({ dialect });
      for (const src of samples) {
        const state = dm.onDocumentOpen("file:///main.st", src);
        const compiled = compile(src, { fileName: "main.st", dialect });
        expect(messages(state.analysisResult)).toEqual(
          compiled.errors.map((e) => `${e.line}: ${e.message}`),
        );
      }
    }
  });

  it("workspace sources are analysed under the profile", () => {
    const { dm, calls } = recordingManager(memoryFs({ "holder.st": POINTER_FB }));
    dm.setWorkspaceFolders(["/ws"]);
    dm.setDialect({ dialect: IEC_ONLY });
    const state = dm.onDocumentOpen("file:///ws/main.st", PLAIN_PROGRAM);
    expect(calls[0]?.additionalSources?.map((s) => s.fileName)).toEqual(["holder.st"]);
    expect(calls[0]?.dialect).toEqual(IEC_ONLY);
    const workspaceErrors = (state.analysisResult?.errors ?? []).filter(
      (e) => e.file === "holder.st",
    );
    expect(workspaceErrors.map((e) => e.message)).toEqual([
      "POINTER TO needs the feature pointer_to",
    ]);

    dm.setDialect({ dialect: WITH_POINTERS });
    const after = dm.reanalyzeAll().get("file:///ws/main.st");
    expect((after?.errors ?? []).filter((e) => e.file === "holder.st")).toEqual([]);
  });

  it("library documents are analysed under the profile", () => {
    const lib = compileStlib([{ source: POINTER_FB, fileName: "holder.st" }], {
      name: "testlib",
      version: "1.0.0",
      namespace: "testlib",
    });
    expect(lib.success).toBe(true);
    const { dm, calls } = recordingManager();
    dm.setLibraryArchiveCache("testlib", lib.archive);
    dm.setDialect({ dialect: IEC_ONLY });
    const uri = "strucpp-lib:/testlib/sources/holder.st";
    const state = dm.onDocumentOpen(uri, POINTER_FB);
    expect(calls[0]?.dialect).toEqual(IEC_ONLY);
    expect(messages(state.analysisResult)).toEqual([
      "2: POINTER TO needs the feature pointer_to",
    ]);

    dm.setDialect({ dialect: WITH_POINTERS });
    expect(messages(dm.reanalyzeAll().get(uri))).toEqual([]);
  });

  it("test files are analysed under the profile", () => {
    const { dm, calls } = recordingManager();
    dm.setDialect({ dialect: WITH_POINTERS });
    dm.onDocumentOpen("file:///main.st", PLAIN_PROGRAM);
    dm.onDocumentOpen(
      "file:///test_main.st",
      `TEST 'counts'\n  ASSERT_TRUE(TRUE);\nEND_TEST\n`,
    );
    expect(calls.every((c) => c?.dialect === WITH_POINTERS)).toBe(true);
  });

  it("getDialectOptions returns the current selection for compile requests", () => {
    const dm = new DocumentManager(analyze, NullWorkspaceFs);
    expect(dm.getDialectOptions()).toEqual({});
    dm.setDialect({ dialect: WITH_POINTERS, features: ["program_methods"] });
    expect(dm.getDialectOptions()).toEqual({
      dialect: WITH_POINTERS,
      features: ["program_methods"],
    });
  });
});

const COND_PROGRAM = `PROGRAM Main
VAR x : INT; END_VAR
{IF defined(SIM)}
x := not valid st;
{END_IF}
  x := nope;
END_PROGRAM`;

const WITH_COND = profile("test-cond", ["conditional_pragmas"]);

describe("pragmaDefines setting", () => {
  it("accepts a name → string map and absent values", () => {
    expect(parseDialectSettings(undefined, undefined, { SIM: "", MODE: "fast" })).toEqual({
      ok: true,
      settings: { pragmaDefines: { SIM: "", MODE: "fast" } },
    });
    expect(parseDialectSettings(null, null, null)).toEqual({ ok: true, settings: {} });
    expect(parseDialectSettings(null, null, {})).toEqual({ ok: true, settings: {} });
  });

  it("rejects a non-object, a non-string value and a key that is not an identifier", () => {
    expect(parseDialectSettings(null, null, ["SIM"])).toEqual({
      ok: false,
      message: "'pragmaDefines' must be an object",
    });
    expect(parseDialectSettings(null, null, { SIM: 1 })).toEqual({
      ok: false,
      message: `'pragmaDefines' value of "SIM" must be a string`,
    });
    expect(parseDialectSettings(null, null, { "1X": "" })).toEqual({
      ok: false,
      message: `'pragmaDefines' key "1X" is not an identifier`,
    });
  });

  it("dialectOptions carries pragmaDefines only when non-empty", () => {
    expect(dialectOptions({})).not.toHaveProperty("pragmaDefines");
    expect(dialectOptions({ pragmaDefines: {} })).not.toHaveProperty("pragmaDefines");
    expect(dialectOptions({ pragmaDefines: { SIM: "" } })).toEqual({
      pragmaDefines: { SIM: "" },
    });
  });
});

describe("DocumentManager conditional pragmas", () => {
  it("analysis options carry the defines", () => {
    const { dm, calls } = recordingManager();
    dm.setDialect({ dialect: WITH_COND, pragmaDefines: { SIM: "" } });
    dm.onDocumentOpen("file:///main.st", PLAIN_PROGRAM);
    expect(calls[0]).toMatchObject({ pragmaDefines: { SIM: "" } });
  });

  it("without the feature each directive is an error at its position", () => {
    const dm = new DocumentManager(analyze, NullWorkspaceFs);
    dm.setDialect({ dialect: IEC_ONLY });
    const state = dm.onDocumentOpen("file:///main.st", COND_PROGRAM);
    const refusals = (state.analysisResult?.errors ?? []).filter((e) =>
      e.message.startsWith("Conditional compilation pragmas are not supported"),
    );
    expect(refusals.map((e) => [e.line, e.column])).toEqual([
      [3, 1],
      [5, 1],
    ]);
  });

  it("with the feature the dead branch is not checked and positions are kept", () => {
    const dm = new DocumentManager(analyze, NullWorkspaceFs);
    dm.setDialect({ dialect: WITH_COND });
    const state = dm.onDocumentOpen("file:///main.st", COND_PROGRAM);
    const errors = (state.analysisResult?.errors ?? []).filter((e) => e.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors) expect([e.line, e.column]).toEqual([6, 8]);
  });

  it("test files take the pass, and their errors keep their line and column", () => {
    const test = `TEST 't'
{IF defined(SIM)}
  ASSERT_TRUE(TRUE);
{END_IF}
{ELSE}
END_TEST`;
    const dm = new DocumentManager(analyze, NullWorkspaceFs);
    dm.setDialect({ dialect: WITH_COND });
    const state = dm.onDocumentOpen("file:///test_main.st", test);
    expect(messages(state.analysisResult)).toContain(
      "5: {ELSE} without a matching {IF}",
    );
    const err = state.analysisResult?.errors.find((e) => e.message.startsWith("{ELSE}"));
    expect(err).toMatchObject({ line: 5, column: 1 });

    const off = new DocumentManager(analyze, NullWorkspaceFs);
    off.setDialect({ dialect: IEC_ONLY });
    const refused = off.onDocumentOpen("file:///test_main.st", test);
    const first = refused.analysisResult?.errors.find((e) =>
      e.message.startsWith("Conditional compilation pragmas"),
    );
    expect(first).toMatchObject({ line: 2, column: 1 });
  });
});
