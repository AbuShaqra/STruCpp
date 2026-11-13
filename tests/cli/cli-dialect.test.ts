/**
 * Dialect flags on the CLI: --print-dialect, --dialect, --dialect-path,
 * --dialect-file, --feature, and one plain error line for a bad profile.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "child_process";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
  readdirSync,
  symlinkSync,
} from "fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, mkdtempSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { compile } from "../../src/index.js";
import { compileStlib } from "../../src/library/library-compiler.js";
import { nodeDialectIO } from "../../src/node/dialect-io.js";
import { DEFAULT_FEATURES, KNOWN_FEATURES } from "../../src/dialect.js";

const CLI_PATH = resolve(__dirname, "../../dist/node/cli.js");
// Per-run folder, so concurrent runs do not share files.
const TMP_BASE = mkdtempSync(join(tmpdir(), "strucpp-cli-dialect-tests-"));
const GOOD = resolve(__dirname, "../fixtures/dialects/good");
const BAD = resolve(__dirname, "../fixtures/dialects/bad");

/** Run the CLI; returns exit status and both streams. */
function run(args: string[]): { status: number; out: string; err: string } {
  const r = spawnSync("node", [CLI_PATH, ...args], {
    encoding: "utf-8",
    timeout: 60000,
  });
  return { status: r.status ?? -1, out: r.stdout, err: r.stderr };
}

function freshDir(name: string): string {
  const dir = join(TMP_BASE, name);
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeAll(() => {
  if (!existsSync(CLI_PATH)) {
    throw new Error(`CLI not built: ${CLI_PATH} not found.`);
  }
  mkdirSync(TMP_BASE, { recursive: true });
});

describe("--help", () => {
  it("lists every known feature and the default set, within 80 columns", () => {
    const r = run(["--help"]);
    expect(r.status).toBe(0);
    const lines = r.out.split("\n");
    const start = lines.findIndex((l) => l.startsWith("  --feature "));
    const end = lines.findIndex((l, i) => i > start && l.startsWith("  --"));
    const featureHelp = lines.slice(start, end).join(" ").replace(/\s+/g, " ");
    for (const f of KNOWN_FEATURES) {
      expect(featureHelp).toMatch(new RegExp(`[ :,]${f}[,]?(?: |$)`));
    }
    const dStart = lines.findIndex((l) => l.startsWith("  --dialect "));
    const dialectHelp = lines
      .slice(dStart, dStart + 4)
      .join(" ")
      .replace(/\s+/g, " ");
    expect(dialectHelp).toContain(
      `the features ${[...DEFAULT_FEATURES].join(", ")})`,
    );
    for (const l of [
      ...lines.slice(start, end),
      ...lines.slice(dStart, dStart + 4),
    ]) {
      expect(l.length).toBeLessThanOrEqual(80);
    }
  });
});

describe("--print-dialect", () => {
  it("--print-dialect without flags prints the default set", () => {
    const r = run(["--print-dialect"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      id: null,
      features: ["pointer_to", "ref_assign", "reference_to"],
    });
  });

  it("--dialect iec-3 --print-dialect", () => {
    const r = run(["--dialect", "iec-3", "--print-dialect"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ id: "iec-3", features: [] });
  });

  it("--dialect-path tests/fixtures/dialects/good --dialect vendor-a --print-dialect", () => {
    const r = run([
      "--dialect-path",
      GOOD,
      "--dialect",
      "vendor-a",
      "--print-dialect",
    ]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      id: "vendor-a",
      features: ["pointer_to", "program_methods", "ref_assign", "reference_to"],
    });
  });

  it("--dialect-file selects the one file; --feature applies after it", () => {
    const r = run([
      "--dialect-file",
      join(GOOD, "vendor-a.json"),
      "--feature",
      "-pointer_to",
      "--feature",
      "-program_methods",
      "--print-dialect",
    ]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      id: "vendor-a",
      features: ["ref_assign", "reference_to"],
    });
  });
});

describe("bad dialect input", () => {
  const cases = readdirSync(BAD).sort();

  it("has one folder per bad case", () => {
    expect(cases).toEqual([
      "cycle",
      "json",
      "semantics",
      "unknown-feature",
      "wrong-id",
    ]);
  });

  /** The id each bad case's folder selects: its (first) file's name. */
  const SELECTS: Record<string, string> = {
    cycle: "bad-cycle-a",
    json: "bad-json",
    semantics: "bad-semantics",
    "unknown-feature": "bad-feature",
    "wrong-id": "bad-id",
  };

  it.each(cases)(
    "a bad profile that is selected exits 1 with one error line and no stack trace (%s)",
    (name) => {
      const r = run([
        "--dialect-path",
        join(BAD, name),
        "--dialect",
        SELECTS[name]!,
        "--print-dialect",
      ]);
      expect(r.status).toBe(1);
      expect(r.out).toBe("");
      const lines = r.err.trimEnd().split("\n");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^error: /);
      expect(r.err).not.toMatch(/\n\s+at /);
    },
  );

  it.each(cases)(
    "a bad profile that is not selected is skipped with a warning (%s)",
    (name) => {
      const r = run(["--dialect-path", join(BAD, name), "--print-dialect"]);
      expect(r.status).toBe(0);
      expect(JSON.parse(r.out)).toEqual({
        id: null,
        features: ["pointer_to", "ref_assign", "reference_to"],
      });
      for (const line of r.err.trimEnd().split("\n")) {
        expect(line).toMatch(
          /^warning: .*; it is not selected, so it is skipped$/,
        );
      }
    },
  );

  it("names the problem of each bad case", () => {
    const msg = (name: string): string =>
      run([
        "--dialect-path",
        join(BAD, name),
        "--dialect",
        SELECTS[name]!,
        "--print-dialect",
      ]).err.trim();
    expect(msg("cycle")).toBe(
      "error: dialect 'bad-cycle-a': extends cycle bad-cycle-a -> bad-cycle-b -> bad-cycle-a",
    );
    expect(msg("json")).toMatch(/^error: dialect file .*bad-json\.json: .+/);
    expect(msg("semantics")).toMatch(
      /^error: dialect file .*bad-semantics\.json: semantics key 'trunc_result' is not known$/,
    );
    expect(msg("unknown-feature")).toMatch(
      /^error: unknown feature 'no_such_feature' in dialect file .*bad-feature\.json \(known: program_methods, pointer_to, reference_to, ref_assign, self_caret, property, postfix_enum_base, named_global_lists, struct_extends, union, fb_init, trunc_dint, interface_zero, end_semicolon_optional, conditional_pragmas, vendor_operators\, type_colon_optional, conditional_return\, platform_types\)$/,
    );
    expect(msg("wrong-id")).toMatch(
      /^error: dialect file .*bad-id\.json: id 'another-id' does not match the file name$/,
    );
  });

  it("an unknown dialect or feature exits 1", () => {
    const d = run(["--dialect", "nope", "--print-dialect"]);
    expect(d.status).toBe(1);
    expect(d.err.trim()).toBe("error: unknown dialect 'nope' (known: iec-3)");
    const f = run(["--feature", "+goto", "--print-dialect"]);
    expect(f.status).toBe(1);
    expect(f.err.trim()).toBe(
      "error: unknown feature 'goto' in --feature (known: program_methods, pointer_to, reference_to, ref_assign, self_caret, property, postfix_enum_base, named_global_lists, struct_extends, union, fb_init, trunc_dint, interface_zero, end_semicolon_optional, conditional_pragmas, vendor_operators, type_colon_optional, conditional_return, platform_types)",
    );
  });

  it("an empty --feature id exits 1 naming the form", () => {
    for (const spec of ["+", "-"]) {
      const r = run(["--feature", spec, "--print-dialect"]);
      expect(r.status).toBe(1);
      expect(r.err.trim()).toBe(
        `error: --feature '${spec}' names no feature: write +id, -id or id (known: program_methods, pointer_to, reference_to, ref_assign, self_caret, property, postfix_enum_base, named_global_lists, struct_extends, union, fb_init, trunc_dint, interface_zero, end_semicolon_optional, conditional_pragmas, vendor_operators, type_colon_optional, conditional_return, platform_types)`,
      );
    }
  });

  it("--dialect iec exits 1 with a hint naming iec-3", () => {
    const r = run(["--dialect", "iec", "--print-dialect"]);
    expect(r.status).toBe(1);
    expect(r.err.trim()).toBe(
      "error: unknown dialect 'iec' (known: iec-3); the IEC 61131-3 Ed. 3 profile is 'iec-3'",
    );
  });

  it("a profile file extending iec exits 1 with a hint naming iec-3", () => {
    const dir = freshDir("extends-iec");
    const file = join(dir, "old.json");
    writeFileSync(
      file,
      JSON.stringify({ id: "old", extends: "iec", features: [] }),
    );
    const r = run(["--dialect-file", file, "--print-dialect"]);
    expect(r.status).toBe(1);
    expect(r.err.trim()).toBe(
      "error: dialect 'old': extends 'iec', which is not loaded; the IEC 61131-3 Ed. 3 profile is 'iec-3'",
    );
  });

  it("a profile file whose id is iec exits 1 as reserved", () => {
    const dir = freshDir("own-iec");
    const file = join(dir, "iec.json");
    writeFileSync(file, JSON.stringify({ id: "iec", features: [] }));
    const r = run([
      "--dialect-file",
      file,
      "--dialect",
      "iec",
      "--print-dialect",
    ]);
    expect(r.status).toBe(1);
    expect(r.err.trim()).toBe(
      `error: dialect file ${file}: the id 'iec' is reserved; the IEC 61131-3 Ed. 3 profile is 'iec-3'`,
    );
  });

  it("a profile file extending iec-3 is selected", () => {
    const dir = freshDir("extends-iec-3");
    const file = join(dir, "new.json");
    writeFileSync(
      file,
      JSON.stringify({
        id: "new",
        extends: "iec-3",
        features: ["program_methods"],
      }),
    );
    const r = run(["--dialect-file", file, "--print-dialect"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      id: "new",
      features: ["program_methods"],
    });
  });

  it("a bad profile stops --compile-lib before compiling", () => {
    const dir = freshDir("compile-lib");
    const st = join(dir, "lib.st");
    writeFileSync(
      st,
      "FUNCTION F : INT\n  VAR_INPUT a : INT; END_VAR\n  F := a;\nEND_FUNCTION\n",
    );
    const r = run([
      "--compile-lib",
      st,
      "-o",
      dir,
      "--lib-name",
      "f",
      "--dialect",
      "nope",
    ]);
    expect(r.status).toBe(1);
    expect(r.err.trim()).toBe("error: unknown dialect 'nope' (known: iec-3)");
    expect(existsSync(join(dir, "f.stlib"))).toBe(false);
  });
});

describe("compiling under a dialect", () => {
  it("--dialect iec-3 compiles a plain program with the default libraries", () => {
    const dir = freshDir("plain");
    const st = join(dir, "main.st");
    writeFileSync(
      st,
      `PROGRAM Main
  VAR t : TON; done : BOOL; END_VAR
  t(IN := TRUE, PT := T#1s);
  done := t.Q;
END_PROGRAM
`,
    );
    const r = run([st, "-o", join(dir, "main.cpp"), "--dialect", "iec-3"]);
    expect(r.err).toBe("");
    expect(r.status).toBe(0);
    expect(existsSync(join(dir, "main.cpp"))).toBe(true);
  });

  it("compile() and compileStlib take the dialect options", () => {
    const src = "PROGRAM P\n  VAR x : INT; END_VAR\n  x := 1;\nEND_PROGRAM\n";
    expect(compile(src, { dialect: "iec-3" }).success).toBe(true);
    const bad = compile(src, { dialect: "nope" });
    expect(bad.success).toBe(false);
    expect(bad.errors.map((e) => e.message)).toEqual([
      "unknown dialect 'nope' (known: iec-3)",
    ]);
    expect(
      compile(src, {
        dialect: "vendor-a",
        dialectPath: [GOOD],
        dialectIO: nodeDialectIO,
      }).success,
    ).toBe(true);
    expect(compile(src, { dialectPath: [GOOD] }).errors[0]?.message).toBe(
      "dialect files need a file reader",
    );
    const lib = compileStlib(
      [
        {
          source: "FUNCTION F : INT\n  F := 1;\nEND_FUNCTION\n",
          fileName: "f.st",
        },
      ],
      { name: "f", version: "1.0.0", namespace: "f", dialect: "nope" },
    );
    expect(lib.success).toBe(false);
    expect(lib.errors.map((e) => e.message)).toEqual([
      "unknown dialect 'nope' (known: iec-3)",
    ]);
  });
});

describe("one profile file reached twice, and dialect warnings in --test", () => {
  const prep = (): string => {
    const dir = freshDir("reached-twice");
    mkdirSync(join(dir, "d"), { recursive: true });
    writeFileSync(
      join(dir, "d", "va.json"),
      JSON.stringify({ id: "va", extends: "iec-3", features: ["pointer_to"] }),
    );
    symlinkSync(join(dir, "d", "va.json"), join(dir, "link.json"));
    return dir;
  };

  it("loads it once, whatever spelling reaches it", () => {
    const dir = prep();
    const d = join(dir, "d");
    for (const args of [
      ["--dialect-path", d, "--dialect-path", d],
      ["--dialect-path", d, "--dialect-path", `${d}/./`, "--dialect", "va"],
      ["--dialect-file", join(d, "va.json"), "--dialect-path", d],
      [
        "--dialect-file",
        join(d, "va.json"),
        "--dialect-file",
        join(dir, "link.json"),
      ],
    ]) {
      const r = run([...args, "--print-dialect"]);
      expect(r.status, args.join(" ")).toBe(0);
      expect(r.err, args.join(" ")).toBe("");
    }
  });

  for (const flags of [[], ["--strict"]]) {
    it(`a --test run prints the warning for a skipped profile (${flags.join(" ") || "no flag"})`, () => {
      const dir = freshDir(`test-warn-${flags.length}`);
      mkdirSync(join(dir, "dp"), { recursive: true });
      writeFileSync(join(dir, "dp", "broken.json"), "{oops");
      const src = join(dir, "src.st");
      const test = join(dir, "test_src.st");
      writeFileSync(
        src,
        "PROGRAM Main\nVAR x : INT; END_VAR\nx := 1;\nEND_PROGRAM\n",
      );
      writeFileSync(test, "TEST 't'\nASSERT_TRUE(TRUE);\nEND_TEST\n");
      const r = run([
        src,
        "--test",
        test,
        "--dialect-path",
        join(dir, "dp"),
        ...flags,
      ]);
      expect(r.out).toContain("1 test, 1 passed, 0 failed");
      expect(r.err).toMatch(
        /warning: dialect file .*broken\.json: .*; it is not selected, so it is skipped/,
      );
    }, 300000);
  }
});
afterAll(() => rmSync(TMP_BASE, { recursive: true, force: true }));
