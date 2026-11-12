/**
 * The feature bit_type end to end (g++): BIT members hold their values in
 * packed bytes, SIZEOF and byte access see the packed layout, and a UNION or
 * STRUCT OVERLAP over such a STRUCT reads and writes single bits.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile, type CompileOptions } from "../../src/index.js";
import type { DialectProfile } from "../../src/dialect.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const PROFILE: DialectProfile = {
  id: "codesys3",
  name: "codesys3",
  extends: "iec-3",
  features: ["pointer_to", "bit_type", "union"],
  semantics: {},
};

const SOURCE = `TYPE ST_B : STRUCT
  a : BIT;
  b : BIT := TRUE;
  c : BIT;
  n : INT := 7;
  d : BIT;
END_STRUCT; END_TYPE
TYPE ST_9 : STRUCT
  b0, b1, b2, b3, b4, b5, b6, b7, b8 : BIT;
  w : WORD;
END_STRUCT; END_TYPE
TYPE ST_F : STRUCT a : BIT; b : BIT; c : BIT; n : BYTE; END_STRUCT; END_TYPE
TYPE U_A : UNION f : ST_F; w : WORD; END_UNION; END_TYPE
TYPE ST_O : STRUCT OVERLAP f : ST_F; b : BYTE; END_STRUCT; END_TYPE
FUNCTION_BLOCK FB_I
VAR_INPUT i : BOOL; END_VAR
VAR_OUTPUT q : BOOL; END_VAR
q := NOT i;
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR
  s, t : ST_B;
  init : ST_B := (a := TRUE, d := TRUE);
  s9 : ST_9;
  u : U_A;
  o : ST_O;
  fb : FB_I;
  p : POINTER TO ARRAY[0..3] OF BYTE;
  x, eq, viaU, viaO, fromFb : BOOL;
  sz, sz9 : UDINT;
  byte0, byte1 : BYTE;
  w : WORD;
END_VAR
s.a := TRUE;
s.c := s.b;
x := s.b AND NOT s.c;
sz := SIZEOF(s);
sz9 := SIZEOF(s9);
s9.b8 := TRUE;
s9.b0 := TRUE;
s9.b1 := s9.b0;
s9.b1 := FALSE;
p := ADR(s9);
byte0 := p^[0];
byte1 := p^[1];
t := s;
eq := t = s;
u.w := 16#0205;
viaU := u.f.c;
u.f.b := TRUE;
w := u.w;
o.b := 2;
viaO := o.f.b;
fb(i := s.a, q => s.d);
fromFb := s.d;
END_PROGRAM
`;

describeIfGpp("bit_type — generated C++", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-bittype-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function run(opts: Partial<CompileOptions>, name: string): string[] {
    const result = compile(SOURCE, {
      headerFileName: "generated.hpp",
      ...opts,
    });
    expect(result.errors.map((e) => `${e.line}: ${e.message}`)).toEqual([]);
    const v = (e: string): string => `std::cout << (unsigned)(${e}) << " ";`;
    return compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: name,
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p; p.run();\n ${[
        v("p.X.get()"),
        v("p.SZ.get()"),
        v("p.SZ9.get()"),
        v("p.BYTE0.get()"),
        v("p.BYTE1.get()"),
        v("p.EQ.get()"),
        v("p.INIT.bits_0_.A"),
        v("p.INIT.bits_0_.B"),
        v("p.INIT.bits_0_.C"),
        v("p.INIT.bits_1_.D"),
        v("p.VIAU.get()"),
        v("p.W.get()"),
        v("p.VIAO.get()"),
        v("p.FROMFB.get()"),
        v("sizeof(ST_B)"),
      ].join(" ")}\n return 0;\n}\n`,
    })
      .trim()
      .split(/\s+/);
  }

  const EXPECTED = [
    "0", // x: b TRUE, c := b
    "6", // SIZEOF(ST_B): bits, pad, INT, bits, pad
    "4", // SIZEOF(ST_9): two bytes of bits, WORD
    "1", // byte 0 of s9: b0
    "1", // byte 1 of s9: b8
    "1", // t = s
    "1",
    "1",
    "0",
    "1", // init: a, b (default), c, d
    "1", // viaU: bit 2 of 16#05
    "519", // u.w after u.f.b: 16#0207
    "1", // viaO: bit 1 of o.b = 2
    "0", // NOT s.a through an FB
    "6",
  ];

  it("runs with the feature, under --strict and under a profile", () => {
    expect(run({ features: ["+bit_type", "+union"] }, "bittype_flag")).toEqual(
      EXPECTED,
    );
    expect(
      run(
        { features: ["+bit_type", "+union"], strict: true },
        "bittype_strict",
      ),
    ).toEqual(EXPECTED);
    expect(run({ dialect: PROFILE }, "bittype_profile")).toEqual(EXPECTED);
  });

  it("is refused without the feature", () => {
    const r = compile(SOURCE, { features: ["+union"] });
    expect(r.errors.map((e) => e.message)).toContain(
      "BIT as a STRUCT member needs the feature bit_type",
    );
  });
});
