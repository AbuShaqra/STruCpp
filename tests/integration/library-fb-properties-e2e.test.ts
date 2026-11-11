// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * E2E: properties of a library function block, own and inherited, read and
 * written by a consumer, also from a local block that EXTENDS the library
 * block; a VAR_TEMP member and a base's input. Built with g++ and run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile, compileStlib } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const LIB = `FUNCTION_BLOCK FB_Prop
VAR_INPUT k : INT := 1; END_VAR
VAR _v : INT := 7; END_VAR
VAR_TEMP t : INT; END_VAR
METHOD Twice : INT
Twice := _v * 2;
END_METHOD
PROPERTY Val : INT
GET
  Val := _v;
END_GET
SET
  _v := Val;
END_SET
END_PROPERTY
PROPERTY RO : INT
GET
  RO := _v * 2;
END_GET
END_PROPERTY
PROPERTY Name : STRING(20)
GET
  Name := 'abc';
END_GET
END_PROPERTY
t := _v + k;
_v := t;
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Der EXTENDS FB_Prop
PROPERTY Own : INT
GET
  Own := 100;
END_GET
END_PROPERTY
END_FUNCTION_BLOCK`;

describe.skipIf(!hasGpp)("library FB properties — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-libprop-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("builds and runs", () => {
    const lib = compileStlib([{ source: LIB, fileName: "prop.st" }], {
      name: "prop-lib",
      version: "1.0.0",
      namespace: "strucpp",
    });
    expect(lib.success).toBe(true);
    const result = compile(
      `FUNCTION_BLOCK FB_Loc EXTENDS FB_Prop
METHOD Get2 : INT
Get2 := Val + THIS.Val * 10;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main
VAR p : FB_Prop; d : FB_Der; l : FB_Loc;
  a : INT; b : INT; c : INT; e : INT; s : STRING; END_VAR
p.k := 2;
p();
a := p.Val;
p.Val := 3;
b := p.RO + d.Own + d.Twice() + p.t;
d.Val := 4;
c := d.Val + d.RO;
l.Val := 2;
e := l.Get2() + l.RO;
s := d.Name;
END_PROGRAM`,
      { headerFileName: "generated.hpp", libraries: [lib.archive!] },
    );
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "library_fb_properties",
      mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN p;
    p.run();
    std::cout << p.A.get() << " " << p.B.get() << " " << p.C.get() << " "
              << p.E.get() << " " << p.S.get().c_str() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("9 129 12 26 abc");
  });
});
