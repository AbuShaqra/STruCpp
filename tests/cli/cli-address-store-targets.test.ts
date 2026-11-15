// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Through the CLI, with the bundled libraries loaded: an address stored in a
 * POINTER TO, REF_TO or REFERENCE TO target is accepted wherever it is
 * stored (a result, a property, an output capture, a FOR control variable),
 * and the difference of two addresses is an integer.
 */
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { writeFileSync, rmSync, mkdtempSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";

const CLI_PATH = resolve(__dirname, "../../dist/node/cli.js");
const TMP = mkdtempSync(join(tmpdir(), "strucpp-cli-address-targets-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const DIALECT = join(TMP, "all.json");
writeFileSync(
  DIALECT,
  JSON.stringify({
    id: "allfeat",
    extends: "iec-3",
    features: [
      "pointer_to",
      "reference_to",
      "ref_assign",
      "self_caret",
      "property",
      "platform_types",
      "fb_property",
      "bare_self_caret",
    ],
  }),
);

let counter = 0;
/** `--check` of `source` through the CLI; the diagnostic lines. */
function check(source: string): string[] {
  const file = join(TMP, `a${counter++}.st`);
  writeFileSync(file, source);
  let out: string;
  try {
    out = execFileSync(
      "node",
      [CLI_PATH, "--check", "--dialect-file", DIALECT, file],
      { encoding: "utf-8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  return out
    .split("\n")
    .filter((l) => / (error|warning): /.test(l))
    .map((l) => l.replace(/^.*?:(\d+:\d+): /, "$1: "));
}

describe("address stores into pointer and reference targets (CLI)", () => {
  it("accepts an address as a FUNCTION or METHOD result of type POINTER TO or REF_TO", () => {
    expect(
      check(`VAR_GLOBAL g : INT; END_VAR
FUNCTION F_P : POINTER TO INT
VAR x : INT; END_VAR
F_P := ADR(g);
END_FUNCTION
FUNCTION_BLOCK FB
METHOD GetP : POINTER TO INT
GetP := ADR(g);
END_METHOD
METHOD GetR : REF_TO INT
GetR := REF(g);
END_METHOD
END_FUNCTION_BLOCK
PROGRAM P
END_PROGRAM
`),
    ).toEqual([]);
  });

  it("accepts an address set into a PROPERTY of type POINTER TO or REF_TO", () => {
    expect(
      check(`INTERFACE I
PROPERTY PP : POINTER TO INT
GET
END_GET
SET
END_SET
END_PROPERTY
END_INTERFACE
FUNCTION_BLOCK FB IMPLEMENTS I
VAR p : POINTER TO INT; r : REF_TO INT; END_VAR
PROPERTY PP : POINTER TO INT
GET
PP := p;
END_GET
SET
p := PP;
END_SET
END_PROPERTY
PROPERTY PR : REF_TO INT
GET
PR := r;
END_GET
SET
r := PR;
END_SET
END_PROPERTY
END_FUNCTION_BLOCK
PROGRAM P
VAR x : INT; fb : FB; itf : I; END_VAR
itf := fb;
fb.PP := ADR(x);
itf.PP := ADR(x);
fb.PR := REF(x);
END_PROGRAM
`),
    ).toEqual([]);
  });

  it("accepts a pointer output captured into a POINTER TO or REF_TO variable", () => {
    expect(
      check(`VAR_GLOBAL g : INT; END_VAR
FUNCTION FO : BOOL
VAR_OUTPUT o : POINTER TO INT; END_VAR
o := ADR(g);
FO := TRUE;
END_FUNCTION
FUNCTION_BLOCK FB
VAR_OUTPUT o : POINTER TO INT; r : REF_TO INT; END_VAR
METHOD M : BOOL
VAR_OUTPUT pOut : POINTER TO INT; END_VAR
pOut := ADR(g);
M := TRUE;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB2 EXTENDS FB
METHOD N : BOOL
VAR p : POINTER TO INT; END_VAR
N := SUPER^.M(pOut => p);
END_METHOD
END_FUNCTION_BLOCK
PROGRAM P
VAR fb : FB; p : POINTER TO INT; r : REF_TO INT; b : BOOL; END_VAR
b := fb.M(pOut => p);
b := FO(o => p);
fb(o => p, r => r);
END_PROGRAM
`),
    ).toEqual([]);
  });

  it("gives no address refusal for a pointer FOR control variable", () => {
    expect(
      check(`PROGRAM P
VAR x : INT; p : POINTER TO INT; i : INT; END_VAR
FOR p := ADR(x) TO ADR(x) DO i := i + 1; END_FOR
END_PROGRAM
`),
    ).toEqual([]);
  });

  it("takes the difference of two addresses as an integer", () => {
    expect(
      check(`FUNCTION F : BOOL
VAR_INPUT d : DINT; END_VAR
F := d > 0;
END_FUNCTION
PROGRAM P
VAR a, b, i : INT; d : DINT; pv, pv2 : PVOID; ok : BOOL; END_VAR
d := ADR(a) - ADR(b);
ok := F(ADR(a) - ADR(b));
FOR d := 0 TO ADR(a) - ADR(b) DO i := i + 1; END_FOR
pv := ADR(a);
pv2 := ADR(b);
d := pv2 - pv;
END_PROGRAM
`),
    ).toEqual([]);
  });
});
