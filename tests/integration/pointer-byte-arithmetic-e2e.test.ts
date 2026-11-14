// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: pointer arithmetic counts bytes, as on a PLC: `p + n`, `p - n` and
 * `ADR(x) + n` move the address by n bytes whatever the target type is.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `TYPE ST : STRUCT a : BYTE; b : INT; c : DINT; END_STRUCT END_TYPE
PROGRAM MAIN
VAR arr : ARRAY[0..3] OF INT := [10, 20, 30, 40]; p : POINTER TO INT; v1, v2, v3, v4, v5 : INT; s : ST; pd : POINTER TO DINT; d : DINT; END_VAR
p := ADR(arr[0]);
p := p + 2; v1 := p^;
p := ADR(arr[0]) + 4; v2 := p^;
p := 2 + ADR(arr[0]); v3 := p^;
p := ADR(arr[3]) - 6; v4 := p^;
p := p - 0; v5 := p^;
s.c := 77; pd := ADR(s) + 4; d := pd^;
END_PROGRAM
`;

describe.skipIf(!hasGpp)("pointer arithmetic in bytes — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-ptrbytes-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const [label, options] of [
    ["no dialect", {}],
    ["strict", { strict: true }],
  ] as const) {
    it(`moves pointers by bytes (${label})`, () => {
      const result = compile(SOURCE, {
        ...options,
        headerFileName: "generated.hpp",
      });
      expect(result.errors).toEqual([]);
      const stdout = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: `ptrbytes_${label.replace(/\W/g, "_")}`,
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.V1.get() << " " << p.V2.get() << " " << p.V3.get() << " " << p.V4.get() << " "
              << p.V5.get() << " " << p.D.get() << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe("20 30 20 10 10 77");
    });
  }

  it("counts bytes through a whole + / - chain, in every target, and between two addresses", () => {
    const result = compile(
      `PROGRAM MAIN
VAR ai : ARRAY[0..7] OF INT := [10,20,30,40,50,60,70,80]; pi : POINTER TO INT; v1, v2, v3, v4 : INT;
  x : DINT; xw, d : LWORD; q : POINTER TO BYTE; dd : LINT; END_VAR
pi := ADR(ai[0]) + 2 + 2; v1 := pi^;
pi := ADR(ai) + 2 + 2; v2 := pi^;
pi := (ADR(ai[0])) + 4; v3 := pi^;
pi := ADR(ai[0]) + 8 - 2; v4 := pi^;
xw := ADR(x) + 4; d := (ADR(x) + 4) - ADR(x);
q := ADR(x) + 4;
dd := ADR(ai[3]) - ADR(ai[0]);
END_PROGRAM
`,
      { headerFileName: "generated.hpp" },
    );
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "adr_chain",
      mainCode: `
#include <iostream>
#include <cstdint>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    const auto base = static_cast<unsigned long long>(reinterpret_cast<std::uintptr_t>(&p.X));
    std::cout << p.V1.get() << " " << p.V2.get() << " " << p.V3.get() << " " << p.V4.get() << " "
              << (p.XW.get() - base) << " " << p.D.get() << " "
              << (reinterpret_cast<std::uintptr_t>(p.Q.get_void()) - base) << " " << p.DD.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("30 30 30 40 4 4 4 6");
  });

  it("refuses moving a POINTER TO a wider type by a constant that would misalign it", () => {
    const result = compile(`PROGRAM MAIN
VAR ab : ARRAY[0..15] OF BYTE; pd : POINTER TO DINT; pb : POINTER TO BYTE; vd : DINT; END_VAR
pd := ADR(ab[0]); pd := pd + 1; pd := pd + 4; pd := pd - 8; pb := pb + 3; vd := pd^;
END_PROGRAM
`);
    expect(
      result.errors.map((e) => `${e.line}:${e.column} ${e.message}`),
    ).toEqual([
      "3:25 Moving a POINTER TO DINT by 1 byte(s) would make its dereference misaligned; move it by a multiple of 4 bytes",
    ]);
  });

  it("keeps OSCAT FINDB_NUM and FINDB_NONUM inside their string", () => {
    const result = compile(
      `PROGRAM MAIN
VAR r1, r2 : INT; END_VAR
r1 := FINDB_NONUM('12a34'); r2 := FINDB_NUM('ab1c2d');
END_PROGRAM
`,
      {
        headerFileName: "generated.hpp",
        libraries: discoverStlibs(path.resolve(__dirname, "../../libs")),
      },
    );
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "adr_findb",
      extraFlags: ["-fsanitize=address", "-fno-omit-frame-pointer"],
      mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.R1.get() << " " << p.R2.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("3 5");
  });

  it("refuses a misaligned move by any constant offset, and an address taken from a value", () => {
    const result = compile(`PROGRAM MAIN
VAR ad : ARRAY[0..7] OF DINT := [1,2,3,4,5,6,7,8]; p : POINTER TO DINT; a : ARRAY[0..1] OF POINTER TO DINT; v1 : DINT; x : ARRAY[0..3] OF DINT; w, d1 : LWORD; END_VAR
VAR CONSTANT one : INT := 1; four : INT := 4; END_VAR
p := p + 16#1;
p := 1 + p;
p := p + 4 + 1;
p := p + (1);
p := ADR(ad[0]) + 1;
p := p + one;
p := p + -1;
a[0] := a[0] + 1;
p := p + 2 * 2;
p := p + four;
p := p + four - 4 + 8;
p := ADR(ad[0]) + 4;
d1 := w - (ADR(x[0]) + 4);
d1 := w - ADR(x[0]);
v1 := p^;
END_PROGRAM
`);
    expect(
      result.errors.map((e) => `${e.line}:${e.column} ${e.message}`),
    ).toEqual([
      ...[
        "4:6 1",
        "5:6 1",
        "6:6 5",
        "7:6 1",
        "8:6 1",
        "9:6 1",
        "10:6 -1",
        "11:9 1",
      ].map((t) => {
        const [at, bytes] = t.split(" ");
        return `${at} Moving a POINTER TO DINT by ${bytes} byte(s) would make its dereference misaligned; move it by a multiple of 4 bytes`;
      }),
      "16:12 An address is offset by + or - an integer, or subtracted from another address: it cannot be subtracted from a value or added to an address",
      "17:11 An address is offset by + or - an integer, or subtracted from another address: it cannot be subtracted from a value or added to an address",
    ]);
  });

  it("takes bytes of a wider value through a byte address, folds a chain's net offset, and subtracts pointers", () => {
    const result = compile(
      `PROGRAM MAIN
VAR dw : DWORD := 16#44332211; pb : POINTER TO BYTE; b1, b2, b3, b4 : BYTE; buf : ARRAY[0..3] OF BYTE;
  ad : ARRAY[0..7] OF DINT; p, q : POINTER TO DINT; pdw : POINTER TO DWORD; n1, n2, n3 : DINT; v : DINT; END_VAR
pb := ADR(dw) + 1; b1 := pb^;
MEMCPY(ADR(buf), ADR(dw) + 2, 2); b2 := buf[0];
pdw := ADR(dw); pb := pdw + 3; b3 := pb^;
ad[2] := 77; p := ADR(ad[0]); p := p + 1 + 3; p := p + 2 + 2; v := p^;
p := ADR(ad[1]); q := ADR(ad[5]);
n1 := q - p; n2 := ADR(ad[5]) - p; n3 := q - ADR(ad[1]);
END_PROGRAM
`,
      { headerFileName: "generated.hpp" },
    );
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "adr_byte_view",
      extraFlags: [
        "-fsanitize=address,undefined",
        "-fno-sanitize-recover=undefined",
      ],
      mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << (int)p.B1.get() << " " << (int)p.B2.get() << " " << (int)p.B3.get() << " " << p.V.get() << " "
              << p.N1.get() << " " << p.N2.get() << " " << p.N3.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("34 51 68 77 16 16 16");
  });
});
