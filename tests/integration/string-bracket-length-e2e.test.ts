// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: STRING[n] and WSTRING[n] truncate to their length under g++, as
 * STRING(n) and WSTRING(n) do.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `TYPE TS : STRING[10]; END_TYPE
TYPE ST : STRUCT f : STRING[5]; END_STRUCT END_TYPE
FUNCTION F : STRING[8]
VAR_INPUT a : STRING[3]; END_VAR
F := CONCAT(a, 'xyzxyzxyz');
END_FUNCTION
PROGRAM Main
VAR
  s : STRING[4] := 'abcdefg';
  w : WSTRING[3] := "abcdef";
  t : TS := 'hello world!';
  st : ST;
  arr : ARRAY[1..2] OF STRING[2];
  n : INT; m : INT; k : INT; f : INT; e : INT; q : INT;
END_VAR
n := LEN(s);
m := LEN(w);
k := LEN(t);
st.f := 'abcdefgh';
f := LEN(st.f);
arr[1] := 'xyz';
e := LEN(arr[1]);
q := LEN(F('abcdef'));
END_PROGRAM
`;

describe.skipIf(!hasGpp)("STRING[n] and WSTRING[n] — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-strbr-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  for (const [label, options] of [
    ["no dialect", {}],
    ["iec-3", { dialect: "iec-3" }],
    ["strict", { strict: true }],
  ] as const) {
    it(`truncates to the bracketed length (${label})`, () => {
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
        testName: `strbr_${label.replace(/\W/g, "_")}`,
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.N.get() << " " << p.M.get() << " " << p.K.get() << " "
              << p.F.get() << " " << p.E.get() << " " << p.Q.get() << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe("4 3 10 5 2 8");
    });
  }
});
