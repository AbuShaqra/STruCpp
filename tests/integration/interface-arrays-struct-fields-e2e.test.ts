// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: an INTERFACE as an ARRAY element (inline and named ARRAY type) and as
 * a STRUCT field holds a reference to an instance, as an interface variable
 * does: bound, passed to an interface input, called through, compared to 0.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `INTERFACE ICnt
METHOD Inc : INT
END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB_C IMPLEMENTS ICnt
VAR_OUTPUT n : INT; END_VAR
METHOD Inc : INT
n := n + 1;
Inc := n;
END_METHOD
END_FUNCTION_BLOCK
TYPE TA : ARRAY[0..1] OF ICnt; END_TYPE
TYPE ST : STRUCT list : TA; one : ICnt; END_STRUCT END_TYPE
FUNCTION Bump : INT
VAR_INPUT i : ICnt; END_VAR
Bump := i.Inc();
END_FUNCTION
FUNCTION_BLOCK FB_H
VAR_INPUT c : ICnt; END_VAR
VAR_OUTPUT r : INT; END_VAR
VAR slots : ARRAY[1..2] OF ICnt; END_VAR
slots[1] := c;
r := slots[1].Inc();
END_FUNCTION_BLOCK
PROGRAM Main
VAR c1 : FB_C; c2 : FB_C; t : TA; s : ST; h : FB_H; x : INT; y : INT; z : INT; ok : BOOL; END_VAR
t[0] := c1;
s.list := t;
s.one := c2;
x := Bump(s.list[0]) + Bump(t[0]) * 10;
h(c := c2);
y := h.r + s.one.Inc() * 10;
ok := s.list[1] = 0;
z := SEL(ok, 0, 1);
END_PROGRAM
`;

describe.skipIf(!hasGpp)(
  "interface ARRAY elements and STRUCT fields — g++ e2e",
  () => {
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-itfarr-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    it("builds and runs", () => {
      const result = compile(SOURCE, { headerFileName: "generated.hpp" });
      expect(result.errors).toEqual([]);
      const stdout = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: "interface_arrays_struct_fields",
        mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN p;
    p.run();
    std::cout << p.X.get() << " " << p.Y.get() << " " << p.Z.get() << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe("21 21 1");
    });
  },
);
