/**
 * E2E: a REF_TO, REFERENCE TO or POINTER TO a STRING(n), and a named
 * STRING(n) type, keep the declared length, so a reference to a STRING(n)
 * variable builds and a write through it truncates at n characters.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `
TYPE TS10 : STRING(10); END_TYPE
TYPE TW5 : WSTRING(5); END_TYPE
TYPE RT : REF_TO STRING(10); END_TYPE
TYPE ST1 : STRUCT f : STRING(10); pf : REF_TO STRING(10); END_STRUCT END_TYPE
FUNCTION Same : REF_TO STRING(10)
VAR_INPUT r : REF_TO STRING(10); END_VAR
  Same := r;
END_FUNCTION
FUNCTION_BLOCK FB
VAR_INPUT r : REF_TO STRING(10); END_VAR
VAR_OUTPUT o : REF_TO STRING(10); END_VAR
  o := r;
END_FUNCTION_BLOCK
VAR_GLOBAL
  gs : STRING(10); gp : REF_TO STRING(10);
END_VAR
PROGRAM Main
VAR
  s10 : STRING(10); s2 : STRING(10);
  p10, p2 : REF_TO STRING(10);
  q10 : POINTER TO STRING(10);
  rr : REFERENCE TO STRING(10);
  t : TS10; pt : REF_TO TS10; w : TW5; pw : REF_TO WSTRING(5);
  w5 : WSTRING(5);
  st : ST1; r : RT; fb : FB;
  tmp : STRING; wtmp : WSTRING;
  n1, n2, n3, n4, n5, n6, n7 : INT;
END_VAR
VAR_EXTERNAL gs : STRING(10); gp : REF_TO STRING(10); END_VAR
  p10 := REF(s10);
  p10^ := 'abcdefghijklmnopqrstuvwxyz';
  n1 := LEN(s10);
  p2 := Same(p10);
  fb(r := p2, o => r);
  r^ := 'xy';
  n2 := LEN(s10);
  gp := REF(gs);
  gp^ := 'a-global-string-too-long';
  n3 := LEN(gs);
  t := 'a-named-string-too-long';
  tmp := t;
  n4 := LEN(tmp);
  pt := REF(t);
  pt^ := 'abc';
  p10 := REF(t);
  n5 := LEN(p10^);
  st.pf := REF(st.f);
  st.pf^ := 'a-field-string-too-long';
  n6 := LEN(st.f);
  pw := REF(w5);
  pw^ := "wide-string";
  w := w5;
  wtmp := w;
  n7 := LEN(wtmp);
  q10 := ADR(s2);
  q10^ := 'pointer-string-too-long';
  rr REF= s2;
END_PROGRAM
`;

const OPTIONS = { headerFileName: "generated.hpp" };

describe("declared STRING length of references and named types", () => {
  it("keeps the length in the emitted types", () => {
    const r = compile(SOURCE, OPTIONS);
    expect(r.errors).toEqual([]);
    expect(r.headerCode).toContain("using TS10 = IECString<10>;");
    expect(r.headerCode).toContain("using TW5 = IECWString<5>;");
    expect(r.headerCode).toContain("using RT = IEC_REF_TO<IECString<10>>;");
    expect(r.headerCode).toContain("IEC_REF_TO<IECString<10>> PF{};");
    expect(r.headerCode).toContain("IEC_REF_TO<IECString<10>> P10;");
    expect(r.headerCode).toContain("IEC_Ptr<IECString<10>> Q10;");
    expect(r.headerCode).toContain("IEC_REFERENCE_TO<IECString<10>> RR;");
    expect(r.headerCode).toContain("IEC_REF_TO<IECWString<5>> PW;");
    expect(r.headerCode).not.toContain("IECString<254>>");
  });

  it("keeps the default length of an unsized STRING reference", () => {
    const r = compile(
      `PROGRAM Main VAR s : STRING; p : REF_TO STRING; END_VAR p := REF(s); END_PROGRAM`,
      OPTIONS,
    );
    expect(r.errors).toEqual([]);
    expect(r.headerCode).toContain("IEC_REF_TO<IECString<254>> P;");
  });
});

describe.skipIf(!hasGpp)("declared STRING length end to end", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-strlenref-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("writes through sized references truncate at the declared length", () => {
    const r = compile(SOURCE, OPTIONS);
    expect(r.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: r.headerCode,
      cppCode: r.cppCode,
      testName: "string_length_ref",
      mainCode: `#include <iostream>
int main() {
  strucpp::Program_MAIN p;
  p.run();
  std::cout << (int)p.N1 << " " << (int)p.N2 << " " << (int)p.N3 << " "
            << (int)p.N4 << " " << (int)p.N5 << " " << (int)p.N6 << " "
            << (int)p.N7 << " " << p.S10.get().c_str() << " "
            << p.S2.get().c_str() << " " << sizeof(p.T) << std::endl;
  return 0;
}
`,
    });
    expect(out).toBe("10 2 10 10 3 10 5 xy pointer-st 11");
  });
});
