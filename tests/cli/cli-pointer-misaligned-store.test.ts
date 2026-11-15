// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Through the CLI, with the bundled libraries loaded: an address moved by a
 * constant that misaligns it is refused on every store path into a POINTER
 * TO a multi-byte type, a test file included; a byte destination is not.
 */
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { writeFileSync, rmSync, mkdtempSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";

const CLI_PATH = resolve(__dirname, "../../dist/node/cli.js");
const TMP = mkdtempSync(join(tmpdir(), "strucpp-cli-misaligned-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const DECLS = `TYPE ST : STRUCT p : POINTER TO DINT; END_STRUCT END_TYPE
FUNCTION_BLOCK FB
VAR_INPUT ip : POINTER TO DINT; bp : POINTER TO BYTE; pv : PVOID; lw : LWORD; END_VAR
END_FUNCTION_BLOCK
FUNCTION GETD : DINT
VAR_INPUT p : POINTER TO DINT; END_VAR
GETD := p^;
END_FUNCTION
FUNCTION GETB : BYTE
VAR_INPUT p : POINTER TO BYTE; END_VAR
GETB := p^;
END_FUNCTION
`;

let counter = 0;
/** The CLI's diagnostic lines for `args` on `source` (and `test`, when given). */
function run(source: string, test?: string): string[] {
  const n = counter++;
  const file = join(TMP, `m${n}.st`);
  writeFileSync(file, source);
  const args = [CLI_PATH, "--feature", "+platform_types"];
  if (test === undefined) {
    args.push("--check", file);
  } else {
    const testFile = join(TMP, `test_m${n}.st`);
    writeFileSync(testFile, test);
    args.push(file, "--test", testFile);
  }
  let out: string;
  try {
    out = execFileSync("node", args, {
      encoding: "utf-8",
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  return out
    .split("\n")
    .filter((l) => / (error|warning): /.test(l))
    .map((l) => l.replace(/^.*?:(\d+:\d+): /, "$1: "));
}

const misaligned = (at: string, bytes: number): string =>
  `${at}: error: Moving a POINTER TO DINT by ${bytes} byte(s) would make its dereference misaligned; move it by a multiple of 4 bytes`;

describe("misaligned pointer stores (CLI)", () => {
  it("refuses a struct field, an FB input, a FUNCTION argument and a result", () => {
    expect(
      run(`${DECLS}FUNCTION GETP : POINTER TO DINT
VAR_INPUT p : POINTER TO DINT; END_VAR
GETP := p + 2;
END_FUNCTION
PROGRAM MAIN
VAR ad : ARRAY[0..7] OF DINT; s : ST; fb : FB; d : DINT; END_VAR
s.p := ADR(ad[0]) + 1;
fb(ip := ADR(ad[0]) + 1);
fb.ip := ADR(ad[0]) + 1;
d := GETD(ADR(ad[0]) + 1);
d := GETD(p := ADR(ad[0]) + 2);
END_PROGRAM
`),
    ).toEqual([
      misaligned("15:9", 2),
      misaligned("19:8", 1),
      misaligned("20:10", 1),
      misaligned("21:10", 1),
      misaligned("22:11", 1),
      misaligned("23:16", 2),
    ]);
  });

  it("accepts any offset into a byte, PVOID or LWORD destination, and aligned moves", () => {
    expect(
      run(`${DECLS}PROGRAM MAIN
VAR ad : ARRAY[0..7] OF DINT; s : ST; fb : FB; d : DINT; b : BYTE; pb : POINTER TO BYTE; END_VAR
fb(ip := ADR(ad[0]) + 8, bp := ADR(ad[0]) + 1, pv := ADR(ad[0]) + 1, lw := ADR(ad[0]) + 1);
fb.bp := ADR(ad[0]) + 3; pb := ADR(ad[0]) + 1; s.p := ADR(ad[0]) + 4;
b := GETB(ADR(ad[0]) + 3); d := GETD(ADR(ad[0]) + 4);
END_PROGRAM
`),
    ).toEqual([]);
  });

  it("refuses the same stores in a test file", () => {
    expect(
      run(
        `${DECLS}PROGRAM MAIN
VAR d : DINT; END_VAR
d := 1;
END_PROGRAM
`,
        `TEST 'mis'
VAR p : POINTER TO DINT; ad : ARRAY[0..1] OF DINT; s : ST; d : DINT; END_VAR
p := ADR(ad[0]) + 1;
s.p := ADR(ad[0]) + 2;
d := GETD(ADR(ad[0]) + 3);
p := ADR(ad[0]) + 4;
ASSERT_TRUE(TRUE);
END_TEST
`,
      ),
    ).toEqual([
      misaligned("3:6", 1),
      misaligned("4:8", 2),
      misaligned("5:11", 3),
    ]);
  });
});
