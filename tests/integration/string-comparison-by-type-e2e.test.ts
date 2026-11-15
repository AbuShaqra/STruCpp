// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: a comparison of two STRING or two WSTRING values compares their text,
 * whatever form each operand takes: SEL/MUX of literals, a dereference, a
 * method result, THIS.member, an alias, MAX/MIN/LIMIT of literals.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `TYPE SS : STRUCT f : STRING := 'abc'; END_STRUCT END_TYPE
TYPE MyStr : STRING(10); END_TYPE
TYPE MyW : WSTRING(10); END_TYPE
FUNCTION_BLOCK FB
VAR_OUTPUT o : STRING := 'abc'; t : BOOL; END_VAR
METHOD M : STRING
M := 'abc';
END_METHOD
METHOD MT : BOOL
t := THIS.o < 'abd';
MT := t;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION FMY : MyW
FMY := "abc";
END_FUNCTION
PROGRAM Main
VAR Y : ARRAY[0..29] OF BOOL; b : BOOL := TRUE; s : STRING := 'abc'; ws : WSTRING := "abc";
p : POINTER TO STRING; ps : POINTER TO SS; st : SS; pw : POINTER TO WSTRING; rr : REF_TO STRING;
fb : FB; rfb : REFERENCE TO FB; ms : MyStr := 'abc'; mw : MyW := "abc"; END_VAR
p := ADR(s); ps := ADR(st); pw := ADR(ws); rr := REF(s); rfb REF= fb;
Y[0] := SEL(b, 'a', 'zz') < 'bd';
Y[1] := 'bd' > SEL(b, 'a', 'zz');
Y[2] := MUX(1, 'a', 'zz') <= 'bd';
Y[3] := SEL(b, 'a', 'bc') = 'bc';
Y[4] := SEL(b, 'a', 'zz') > s;
Y[5] := SEL(b, 'a', 'bc') = MID('xbc', 2, 2);
Y[6] := p^ < 'abd';
Y[7] := 'abb' < p^;
Y[8] := 'abc' = p^;
Y[9] := 'abc' <> p^;
Y[10] := ps^.f < 'abd';
Y[11] := pw^ < "abd";
Y[12] := "abc" = pw^;
Y[13] := rr^ < 'abd';
Y[14] := fb.M() < 'abd';
Y[15] := 'abb' < rfb.M();
Y[16] := fb.MT();
Y[17] := ms < 'abd';
Y[18] := 'abc' = ms;
Y[19] := mw < "abd";
Y[20] := "abc" = FMY();
Y[21] := MAX('a', 'bc') = 'bc';
Y[22] := MIN('bc', 'zz') = 'bc';
Y[23] := LIMIT('a', 'bc', 'z') = 'bc';
Y[24] := MAX("a", "bc") <> "bc";
Y[25] := s = 'abc';
Y[26] := 'zz' < 'aa';
Y[27] := ms >= s;
Y[28] := 'abc' <> ms;
Y[29] := SEL(b, 'a', 'zz') >= 'zz';
END_PROGRAM
`;

describe.skipIf(!hasGpp)("string comparison by type — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-strcmp-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("compares the text of every operand form", () => {
    const result = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "strcmp_type",
      mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    for (int i = 0; i < 30; ++i) std::cout << p.Y.at(i).get();
    std::cout << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("000111111011111111111111010101");
  });
});
