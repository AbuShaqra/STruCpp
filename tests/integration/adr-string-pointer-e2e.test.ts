/**
 * E2E: ADR of a STRING or WSTRING (variable, STRUCT field, array element,
 * global, FB member) into a POINTER TO STRING, and reads and writes through
 * it, under pointer_to with and without --strict.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `
TYPE ST_S : STRUCT name : STRING; tag : STRING(10); END_STRUCT END_TYPE
FUNCTION_BLOCK FB_S
VAR msg : STRING; pm : POINTER TO STRING; END_VAR
VAR_OUTPUT cnt : INT; END_VAR
  pm := ADR(msg);
  pm^ := 'fb';
  cnt := LEN(msg);
END_FUNCTION_BLOCK
FUNCTION LenOf : INT
VAR_INPUT p : POINTER TO STRING; END_VAR
  LenOf := LEN(p^);
END_FUNCTION
VAR_GLOBAL gstr : STRING; END_VAR
PROGRAM Main
VAR
  str : STRING; s10 : STRING(10); ws : WSTRING; st : ST_S;
  arr : ARRAY[0..1] OF STRING;
  ps : POINTER TO STRING; p10 : POINTER TO STRING(10);
  pw : POINTER TO WSTRING;
  fb : FB_S; n1, n2, n3, n4, n5, n6 : INT;
END_VAR
VAR_EXTERNAL gstr : STRING; END_VAR
  ps := ADR(str);     ps^ := 'abc';               n1 := LEN(str);
  p10 := ADR(s10);    p10^ := 'abcdefghijklmnop'; n2 := LEN(s10);
  pw := ADR(ws);      pw^ := "wide";              n3 := LEN(ws);
  ps := ADR(st.name); ps^ := 'field';             n4 := LEN(st.name);
  ps := ADR(arr[1]);  ps^ := 'el';                n5 := LEN(arr[1]);
  ps := ADR(gstr);    ps^ := 'global!';
  n6 := LenOf(ps) + LenOf(ADR(str));
  fb();
END_PROGRAM
`;

const MODES: Array<[string, Parameters<typeof compile>[1]]> = [
  ["no flags", {}],
  ["strict", { strict: true }],
  [
    "strict vendor profile",
    {
      strict: true,
      dialect: {
        id: "vendor-x",
        name: "Vendor X",
        extends: "iec-3",
        features: ["pointer_to"],
        semantics: {},
      },
    },
  ],
];

describe.skipIf(!hasGpp)("ADR into POINTER TO STRING end to end", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-adrstr-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it.each(MODES)("builds and runs (%s)", (name, options) => {
    const r = compile(SOURCE, { ...options, headerFileName: "generated.hpp" });
    expect(r.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: r.headerCode,
      cppCode: r.cppCode,
      testName: `adr_string_${name.replace(/ /g, "_")}`,
      mainCode: `#include <iostream>
int main() {
  strucpp::Program_MAIN p;
  p.run();
  std::cout << (int)p.N1 << " " << (int)p.N2 << " " << (int)p.N3 << " "
            << (int)p.N4 << " " << (int)p.N5 << " " << (int)p.N6 << " "
            << (int)p.FB.CNT << std::endl;
  return 0;
}
`,
    });
    expect(out).toBe("3 10 4 5 2 10 2");
  });
});
