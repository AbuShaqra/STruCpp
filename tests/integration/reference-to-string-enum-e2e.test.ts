// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * E2E: REF / REF= of a STRING, WSTRING or enumeration variable (or STRUCT
 * field) into REF_TO and REFERENCE TO, read and written through them. Built
 * with g++ and run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

describe.skipIf(!hasGpp)("references to a STRING or enum — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-refstrenum-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("builds and runs", () => {
    const result = compile(
      `
      TYPE E_Col : (Red, Green, Blue); END_TYPE
      TYPE ST_A : STRUCT s : STRING; e : E_Col; END_STRUCT END_TYPE
      FUNCTION_BLOCK FB_T
      VAR_INPUT r : REF_TO STRING; END_VAR
      VAR_OUTPUT o : STRING; END_VAR
        o := CONCAT(r^, '!');
        r^ := 'set';
      END_FUNCTION_BLOCK
      PROGRAM Main
      VAR s : STRING := 'abc'; w : WSTRING := "xy"; e : E_Col := Green;
        st : ST_A;
        ps : REF_TO STRING; pw : REF_TO WSTRING; pe : REF_TO E_Col;
        rs : REFERENCE TO STRING; re : REFERENCE TO E_Col;
        fb : FB_T; o : STRING; s2 : STRING; w2 : WSTRING;
        n : INT; wasGreen : BOOL; isBlue : BOOL; fieldBlue : BOOL; END_VAR
        ps := REF(s);
        pw := REF(w);
        pe := REF(e);
        s2 := ps^;
        w2 := pw^;
        n := LEN(ps^);
        wasGreen := pe^ = Green;
        pe^ := Blue;
        isBlue := e = Blue;
        rs REF= s;
        rs := 'via';
        fb(r := REF(s));
        o := fb.o;
        pe := REF(st.e);
        pe^ := Blue;
        fieldBlue := st.e = Blue;
        ps := REF(st.s);
        ps^ := 'field';
        re REF= e;
        re := Red;
      END_PROGRAM
      `,
      { headerFileName: "generated.hpp" },
    );
    expect(result.errors.map((e) => `${e.line}: ${e.message}`)).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "ref_string_enum",
      mainCode: `#include <iostream>
int main() {
  using namespace strucpp;
  Program_MAIN p;
  p.run();
  std::cout << p.S2.get().c_str() << " " << p.W2.get().length() << " " << p.N.get()
            << " " << p.WASGREEN.get() << " " << p.ISBLUE.get() << " " << p.O.get().c_str()
            << " " << p.S.get().c_str() << " " << p.FIELDBLUE.get() << " " << p.ST.S.get().c_str()
            << " " << static_cast<int>(p.E.get().get()) << std::endl;
  return 0;
}
`,
    });
    expect(out).toBe("abc 2 3 1 1 via! set 1 field 0");
  });
});
