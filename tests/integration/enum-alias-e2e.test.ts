/**
 * E2E: an alias of an enumeration (`TYPE E2A : E2; END_TYPE`, also an alias
 * of an alias) is that enumeration: its variables take the enumeration's
 * values and variables, compare with them, select a CASE and convert with
 * TO_INT, and they are declared with the wrapper a direct enumeration
 * variable gets.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `
TYPE E2 : (A, B, C); END_TYPE
TYPE E3 : (X, Y); END_TYPE
TYPE E2A : E2; END_TYPE
TYPE E2B : E2A; END_TYPE
TYPE S1 : STRUCT f : E2A; g : E2; END_STRUCT END_TYPE
TYPE AA : ARRAY[0..1] OF E2A; END_TYPE
FUNCTION FA : E2A
VAR_INPUT v : E2A; END_VAR
  FA := v;
END_FUNCTION
PROGRAM Main
VAR
  d : E2; a : E2A := E2#A; b : E2B; s : S1; arr : ARRAY[0..1] OF E2A; na : AA;
  r : REF_TO E2A; p : POINTER TO E2A;
  n1, n2, n3, n4 : INT; ok1, ok2 : BOOL;
END_VAR
  a := E2#B; b := C; d := a; a := d; b := a;
  s.f := a; s.g := s.f; arr[1] := b; na[0] := a;
  a := FA(E2#C); a := FA(d);
  r := REF(a); r^ := E2A#B; p := ADR(a); p^ := C;
  ok1 := a = E2#C; ok2 := a = d;
  n1 := TO_INT(a); n2 := TO_INT(b) + TO_INT(arr[1]) + TO_INT(s.f);
  CASE a OF E2#C: n3 := 7; ELSE n3 := 1; END_CASE;
  n4 := TO_INT(na[0]);
END_PROGRAM
`;

const MODES: Array<[string, Parameters<typeof compile>[1]]> = [
  ["no flags", {}],
  ["strict", { strict: true }],
];

function errorsFor(body: string): string[] {
  return compile(
    `TYPE E2 : (A, B, C); END_TYPE
TYPE E3 : (X, Y); END_TYPE
TYPE E2A : E2; END_TYPE
PROGRAM Main
VAR d : E2; a : E2A; other : E3; i : INT; END_VAR
${body}
END_PROGRAM`,
    {},
  ).errors.map((e) => e.message);
}

describe("an alias of an enumeration", () => {
  it.each(MODES)("is its enumeration (%s)", (_name, options) => {
    expect(compile(SOURCE, options).errors.map((e) => e.message)).toEqual([]);
  });

  it("declares its variables with the enumeration wrapper", () => {
    const r = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(r.headerCode).toContain("using E2A = E2;");
    expect(r.headerCode).toContain("using IEC_E2A = IEC_ENUM<E2A>;");
    expect(r.headerCode).toContain("using IEC_E2B = IEC_ENUM<E2B>;");
    expect(r.headerCode).toMatch(/IEC_E2A A\b/);
    expect(r.headerCode).toMatch(/IEC_E2B B\b/);
    expect(r.headerCode).toContain("IEC_E2A F{};");
    expect(r.headerCode).not.toContain("IECVar<E2A>");
  });

  it("is still not another enumeration or a number", () => {
    expect(errorsFor("a := E3#X;")).toEqual(["Cannot assign E3 to E2"]);
    expect(errorsFor("a := other;")).toEqual(["Cannot assign E3 to E2"]);
    expect(errorsFor("a := 1;")).toEqual(["Cannot assign INT to E2"]);
    expect(errorsFor("i := a;")).toEqual(["Cannot assign E2 to INT"]);
    expect(errorsFor("i := a + 1;")).toHaveLength(1);
  });
});

describe.skipIf(!hasGpp)("an alias of an enumeration end to end", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-enumalias-"));
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
      testName: `enum_alias_${name.replace(/ /g, "_")}`,
      mainCode: `#include <iostream>
int main() {
  strucpp::Program_MAIN p;
  p.run();
  std::cout << (int)p.N1 << " " << (int)p.N2 << " " << (int)p.N3 << " "
            << (int)p.N4 << " " << (bool)p.OK1 << (bool)p.OK2 << std::endl;
  return 0;
}
`,
    });
    expect(out).toBe("2 3 7 1 10");
  });
});
