// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * Conditional pragmas through compile(), analyze() and parseTestFile():
 * refused without the feature conditional_pragmas, resolved with it, and
 * every diagnostic kept at its original line and column.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  compile,
  analyze,
  parseTestFile,
  KNOWN_FEATURES,
  DEFAULT_FEATURES,
  resolveDialect,
} from "../../src/index.js";
import { nodeDialectIO } from "../../src/node/dialect-io.js";
import type { CompileError, CompileOptions } from "../../src/types.js";

let dir = "";
let vendorFile = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "strucpp-cond-"));
  vendorFile = join(dir, "vendor-cond.json");
  writeFileSync(
    vendorFile,
    JSON.stringify({
      id: "vendor-cond",
      extends: "iec-3",
      features: ["conditional_pragmas"],
    }),
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function vendor(extra: Partial<CompileOptions> = {}): Partial<CompileOptions> {
  return {
    strict: true,
    dialectFiles: [vendorFile],
    dialectIO: nodeDialectIO,
    ...extra,
  };
}

function at(list: ReadonlyArray<CompileError>): string[] {
  return list.map((e) => `${e.line}:${e.column} ${e.message}`);
}

const REFUSAL = "Conditional compilation pragmas are not supported";
const HINT = "; they need the feature conditional_pragmas";

/** A program whose initial value of x depends on SIM / MODE. */
const PROGRAM = `PROGRAM Main
VAR
{IF defined(SIM)}
  x : INT := 1;
{ELSIF hasvalue(MODE, 'fast')}
  x : INT := 2;
{ELSE}
  x : INT := 3;
{END_IF}
END_VAR
x := x + 0;
END_PROGRAM
`;

type Mode = { name: string; options: () => Partial<CompileOptions> };

const REFUSING: Mode[] = [
  { name: "no flags", options: () => ({}) },
  { name: "dialect iec-3", options: () => ({ dialect: "iec-3" }) },
  { name: "strict alone", options: () => ({ strict: true }) },
];

describe.each(REFUSING)("refused: $name", ({ options }) => {
  it("compile() fails at each directive with the feature hint", () => {
    const r = compile(PROGRAM, { ...options(), pragmaDefines: { SIM: "" } });
    expect(r.success).toBe(false);
    const refusals = r.errors.filter((e) => e.message.startsWith(REFUSAL));
    expect(refusals.map((e) => [e.line, e.column])).toEqual([
      [3, 1],
      [5, 1],
      [7, 1],
      [9, 1],
    ]);
    for (const e of refusals) expect(e.message.endsWith(HINT)).toBe(true);
  });

  it("analyze() reports the same refusals", () => {
    const r = analyze(PROGRAM, options());
    const refusals = r.errors.filter((e) => e.message.startsWith(REFUSAL));
    expect(refusals).toHaveLength(4);
    expect(refusals[0]!.message).toBe(`${REFUSAL}: {IF defined(SIM)}${HINT}`);
  });
});

describe("refusal names loaded profiles that have the feature", () => {
  it("lists the vendor profile", () => {
    const r = compile(PROGRAM, {
      dialect: "iec-3",
      dialectFiles: [vendorFile],
      dialectIO: nodeDialectIO,
    });
    expect(r.errors[0]!.message).toBe(
      `${REFUSAL}: {IF defined(SIM)}${HINT} (profiles: vendor-cond)`,
    );
  });
});

const ACCEPTING: Mode[] = [
  { name: "strict + vendor profile", options: () => vendor() },
  {
    name: "features +conditional_pragmas",
    options: () => ({ features: ["+conditional_pragmas"] }),
  },
];

describe.each(ACCEPTING)("accepted: $name", ({ options }) => {
  const cases: Array<[Record<string, string> | undefined, string]> = [
    [undefined, "X(3)"],
    [{ SIM: "" }, "X(1)"],
    [{ sim: "" }, "X(1)"],
    [{ MODE: "fast" }, "X(2)"],
    [{ MODE: "slow" }, "X(3)"],
  ];
  it.each(cases)("defines %j compile the right branch", (defines, init) => {
    const r = compile(PROGRAM, {
      ...options(),
      ...(defines ? { pragmaDefines: defines } : {}),
    });
    expect(at(r.errors)).toEqual([]);
    expect(r.success).toBe(true);
    expect(r.headerCode + r.cppCode).toContain(init);
    for (const other of ["X(1)", "X(2)", "X(3)"].filter((v) => v !== init)) {
      expect(r.headerCode + r.cppCode).not.toContain(other);
    }
  });

  it("an {attribute} in a dead branch gives no warning; in a live one it does", () => {
    const src = `PROGRAM Main
VAR x : INT; END_VAR
{IF defined(SIM)}
{attribute 'dead'}
{ELSE}
{attribute 'live'}
{END_IF}
x := 1;
END_PROGRAM
`;
    const r = compile(src, options());
    expect(r.success).toBe(true);
    expect(at(r.warnings)).toEqual(["6:1 Pragma ignored: {attribute 'live'}"]);
  });

  it("dead code is not checked; a later error keeps its line and column", () => {
    const src = `PROGRAM Main
VAR x : INT; b : BOOL; END_VAR
{IF defined(SIM)}
x := undefined_thing + TRUE;
this is not ST at all
{END_IF}
    b := nope;
END_PROGRAM
`;
    // The only error is the undeclared `nope`, at its own line 7, column 10.
    const c = compile(src, options());
    expect(c.success).toBe(false);
    const errors = c.errors.filter((e) => e.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors) expect([e.line, e.column]).toEqual([7, 10]);
    const a = analyze(src, options());
    const aErrors = a.errors.filter((e) => e.severity === "error");
    expect(aErrors.length).toBeGreaterThan(0);
    for (const e of aErrors) expect([e.line, e.column]).toEqual([7, 10]);
  });
});

describe("strict + vendor profile", () => {
  const STRICT = `PROGRAM Main
VAR i : INT; d : DINT; END_VAR
{IF defined(SIM)}
i := d;
{END_IF}
  i := d;
END_PROGRAM
`;

  it("a strict violation after a dead block is reported at its own line and column only", () => {
    const r = compile(STRICT, vendor());
    expect(r.success).toBe(false);
    expect(r.errors.map((e) => [e.line, e.column])).toEqual([[6, 8]]);
  });

  it("the same violation in a live branch is reported too", () => {
    const r = compile(STRICT, vendor({ pragmaDefines: { SIM: "" } }));
    expect(r.errors.map((e) => [e.line, e.column])).toEqual([
      [4, 6],
      [6, 8],
    ]);
  });

  it("strict alone refuses; strict with the profile accepts", () => {
    const src = PROGRAM.replace("x := x + 0;", "x := x;");
    expect(compile(src, { strict: true }).success).toBe(false);
    expect(compile(src, vendor()).success).toBe(true);
  });

  it("pragma errors stop compile and are listed by analyze, with positions", () => {
    const src = `PROGRAM Main
VAR x : INT; END_VAR
{IF defined(pou:Main)}
{END_IF}
x := 1;
{END_IF}
END_PROGRAM
`;
    const c = compile(src, vendor());
    expect(c.success).toBe(false);
    expect(at(c.errors)).toEqual([
      "3:5 Conditional pragma operator 'defined(pou:...)' is not supported",
      "6:1 {END_IF} without a matching {IF}",
    ]);
    const a = analyze(src, vendor());
    expect(at(a.errors)).toEqual(at(c.errors));
  });

  it("additionalSources get the same pass, errors name their file", () => {
    const lib = `FUNCTION F : INT
VAR_INPUT a : INT; END_VAR
{IF defined(SIM)}
F := a + 100;
{ELSE}
F := a;
{END_IF}
END_FUNCTION
`;
    const main = `PROGRAM Main
VAR x : INT; END_VAR
x := F(1);
END_PROGRAM
`;
    const on = compile(main, {
      ...vendor({ pragmaDefines: { SIM: "" } }),
      additionalSources: [{ fileName: "lib.st", source: lib }],
    });
    expect(at(on.errors)).toEqual([]);
    expect(on.cppCode).toContain("100");
    const off = compile(main, {
      ...vendor(),
      additionalSources: [{ fileName: "lib.st", source: lib }],
    });
    expect(off.success).toBe(true);
    expect(off.cppCode).not.toContain("100");

    const broken = compile(main, {
      ...vendor(),
      additionalSources: [{ fileName: "lib.st", source: `${lib}{ELSE}\n` }],
    });
    expect(broken.errors).toEqual([
      expect.objectContaining({
        file: "lib.st",
        line: 9,
        column: 1,
        message: "{ELSE} without a matching {IF}",
      }),
    ]);
    const refused = compile(main, {
      strict: true,
      additionalSources: [{ fileName: "lib.st", source: lib }],
    });
    expect(refused.errors[0]).toMatchObject({
      file: "lib.st",
      line: 3,
      column: 1,
    });
    expect(refused.errors[0]!.message.endsWith(HINT)).toBe(true);
  });

  it("IL in a live branch is transpiled; IL in a dead branch is never seen", () => {
    const src = `FUNCTION_BLOCK Shower
VAR st : INT; out : INT; END_VAR
{IF defined(USE_IL)}
  LD st
  ST out
{ELSE}
  out := st + 1;
{END_IF}
END_FUNCTION_BLOCK
PROGRAM Main
VAR s : Shower; END_VAR
s();
END_PROGRAM
`;
    const st = compile(src, vendor());
    expect(at(st.errors)).toEqual([]);
    expect(st.cppCode).toMatch(/OUT = .*ST.*\+ 1/);
    const il = compile(src, {
      features: ["+conditional_pragmas"],
      pragmaDefines: { USE_IL: "" },
    });
    expect(at(il.errors)).toEqual([]);
    expect(il.cppCode).not.toMatch(/ST \+ 1/);
  });

  it("#line directives keep the original line numbers", () => {
    const src = `PROGRAM Main
VAR x : INT; END_VAR
{IF defined(SIM)}
x := 11;
{ELSE}
x := 22;
{END_IF}
END_PROGRAM
`;
    const r = compile(src, vendor({ lineDirectives: true, fileName: "m.st" }));
    expect(r.success).toBe(true);
    const lines = r.cppCode.split("\n");
    const idx = lines.findIndex((l) => l.includes("X = 22"));
    expect(idx).toBeGreaterThan(0);
    expect(
      lines
        .slice(0, idx)
        .reverse()
        .find((l) => l.startsWith("#line")),
    ).toBe('#line 6 "m.st"');
  });
});

describe("pragmaDefines validation", () => {
  it("a key that is not an identifier throws a TypeError", () => {
    expect(() => compile(PROGRAM, { pragmaDefines: { "1X": "" } })).toThrow(
      TypeError,
    );
    expect(() => analyze(PROGRAM, { pragmaDefines: { "A-B": "" } })).toThrow(
      TypeError,
    );
    expect(() =>
      compile(PROGRAM, { pragmaDefines: { A: 5 as unknown as string } }),
    ).toThrow(TypeError);
  });

  it("are ignored without the feature: no diagnostic of their own", () => {
    const plain = `PROGRAM Main\nVAR x : INT; END_VAR\nx := 1;\nEND_PROGRAM\n`;
    const r = compile(plain, { pragmaDefines: { SIM: "" } });
    expect(r.success).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it("globalConstants never become defined()", () => {
    const r = compile(PROGRAM, {
      features: ["+conditional_pragmas"],
      globalConstants: { SIM: 1 },
    });
    expect(r.success).toBe(true);
    expect(r.headerCode + r.cppCode).toContain("X(3)");
  });
});

describe("parseTestFile", () => {
  const TEST_SRC = `TEST 'branch'
{IF defined(SIM)}
  ASSERT_TRUE(TRUE);
{ELSE}
  ASSERT_TRUE(FALSE);
{END_IF}
END_TEST
`;

  it("without options refuses conditional pragmas as before", () => {
    const r = parseTestFile(TEST_SRC, "t.st");
    expect(r.errors.map((e) => [e.line, e.column])).toEqual([
      [2, 1],
      [4, 1],
      [6, 1],
    ]);
    expect(r.errors[0]!.message).toBe(`${REFUSAL}: {IF defined(SIM)}`);
  });

  it("with options but no feature refuses with the hint", () => {
    const r = parseTestFile(TEST_SRC, "t.st", { dialect: "iec-3" });
    expect(r.errors).toHaveLength(3);
    expect(r.errors[0]!.message.endsWith(HINT)).toBe(true);
  });

  it("with the feature resolves the branches", () => {
    const on = parseTestFile(TEST_SRC, "t.st", {
      features: ["+conditional_pragmas"],
      pragmaDefines: { SIM: "" },
    });
    expect(on.errors).toEqual([]);
    expect(JSON.stringify(on.testFile)).toContain('"value":true');
    expect(JSON.stringify(on.testFile)).not.toContain('"value":false');
    const off = parseTestFile(TEST_SRC, "t.st", {
      dialectFiles: [vendorFile],
      dialectIO: nodeDialectIO,
    });
    expect(off.errors).toEqual([]);
    expect(JSON.stringify(off.testFile)).toContain('"value":false');
  });

  it("pragma errors carry file, line and column", () => {
    const r = parseTestFile(`${TEST_SRC}{END_IF}\n`, "t.st", {
      features: ["+conditional_pragmas"],
    });
    expect(r.errors).toEqual([
      expect.objectContaining({ file: "t.st", line: 8, column: 1 }),
    ]);
  });

  it("a bad dialect is an error entry", () => {
    const r = parseTestFile(TEST_SRC, "t.st", { dialect: "nope" });
    expect(r.errors[0]!.message).toMatch(/unknown dialect 'nope'/);
    expect(r.errors[0]!.file).toBe("t.st");
  });
});

describe("dialect profiles", () => {
  it("conditional_pragmas is known, not in the default set and not in iec-3", () => {
    expect(KNOWN_FEATURES).toContain("conditional_pragmas");
    expect(DEFAULT_FEATURES.has("conditional_pragmas")).toBe(false);
    expect(
      resolveDialect({ dialect: "iec-3" }).features.has("conditional_pragmas"),
    ).toBe(false);
  });
});
