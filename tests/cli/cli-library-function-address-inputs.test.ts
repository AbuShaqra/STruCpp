// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Through the CLI, with the bundled libraries loaded: an address passed to a
 * value input of a library FUNCTION narrower than 64 bits is refused (oscat
 * BIT_COUNT, IN : DWORD), while a library POINTER TO, REF_TO, pointer-to-
 * pointer or ARRAY OF POINTER input still takes one. The library is built with
 * --compile-lib, whose manifest records the parameter shapes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { writeFileSync, rmSync, mkdtempSync, mkdirSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";

const CLI_PATH = resolve(__dirname, "../../dist/node/cli.js");
const TMP = mkdtempSync(join(tmpdir(), "strucpp-cli-libfn-address-"));
const LIB_DIR = join(TMP, "lib");
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const DIALECT = join(TMP, "all.json");
writeFileSync(
  DIALECT,
  JSON.stringify({
    id: "allfeat",
    extends: "iec-3",
    features: ["pointer_to", "reference_to"],
  }),
);

function run(args: string[]): string {
  try {
    return execFileSync("node", [CLI_PATH, ...args], {
      encoding: "utf-8",
      timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

let counter = 0;
/** `--check` of `source` through the CLI; the diagnostic lines. */
function check(source: string, extra: string[] = []): string[] {
  const file = join(TMP, `a${counter++}.st`);
  writeFileSync(file, source);
  return run(["--check", "--dialect-file", DIALECT, ...extra, file])
    .split("\n")
    .filter((l) => / (error|warning): /.test(l))
    .map((l) => l.replace(/^.*?:(\d+:\d+): /, "$1: "));
}

const NARROW = (type: string): string =>
  `error: ADR gives a 64-bit address, which ${type} cannot hold; use a POINTER TO or PVOID, or __XWORD, LWORD or ULINT`;

beforeAll(() => {
  mkdirSync(LIB_DIR, { recursive: true });
  const src = join(TMP, "shapes.st");
  writeFileSync(
    src,
    `FUNCTION F_Shapes : INT
VAR_INPUT
  p : POINTER TO INT;
  r : REF_TO INT;
  pp : POINTER TO POINTER TO INT;
  ap : ARRAY[0..1] OF POINTER TO INT;
  d : DWORD;
  w : LWORD;
END_VAR
F_Shapes := 1;
END_FUNCTION
`,
  );
  const out = run([
    "--compile-lib",
    src,
    "-o",
    LIB_DIR,
    "--lib-name",
    "shapes",
    "--dialect-file",
    DIALECT,
  ]);
  expect(out).not.toMatch(/error/i);
});

describe("an address into a library FUNCTION input (CLI)", () => {
  it("refuses ADR into oscat BIT_COUNT's DWORD input, positional and named", () => {
    expect(
      check(`PROGRAM P
VAR x : INT; n : INT; END_VAR
n := BIT_COUNT(ADR(x));
n := BIT_COUNT(IN := ADR(x));
END_PROGRAM
`),
    ).toEqual([`3:16: ${NARROW("DWORD")}`, `4:22: ${NARROW("DWORD")}`]);
  });

  it("accepts an address into a library POINTER TO, REF_TO, pointer-to-pointer and LWORD input", () => {
    expect(
      check(
        `PROGRAM P
VAR x : INT; px : POINTER TO INT; a : ARRAY[0..1] OF POINTER TO INT; n : INT; END_VAR
px := ADR(x);
n := F_Shapes(p := ADR(x), r := REF(x), pp := ADR(px), ap := a, d := 0, w := ADR(x));
END_PROGRAM
`,
        ["-L", LIB_DIR],
      ),
    ).toEqual([]);
  });

  it("refuses an address into the library's DWORD input", () => {
    expect(
      check(
        `PROGRAM P
VAR x : INT; px : POINTER TO INT; a : ARRAY[0..1] OF POINTER TO INT; n : INT; END_VAR
n := F_Shapes(p := ADR(x), r := REF(x), pp := ADR(px), ap := a, d := ADR(x), w := 0);
END_PROGRAM
`,
        ["-L", LIB_DIR],
      ),
    ).toEqual([`3:70: ${NARROW("DWORD")}`]);
  });
});
