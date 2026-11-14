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
      "3:30 Moving a POINTER TO DINT by 1 byte(s) would make its dereference misaligned; move it by a multiple of 4 bytes",
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
});
