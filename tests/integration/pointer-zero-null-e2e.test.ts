/**
 * E2E: under pointer_to, the untyped literal 0 stored in a POINTER TO of any
 * target type (elementary, STRING, STRUCT, FB, interface, pointer) is NULL:
 * in an assignment, as an initial value and as an argument. Any other
 * integer stays an error for a STRUCT or FB target. `=` and `<>` on a pointer
 * or REF_TO a STRUCT compare the reference, not the STRUCT.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `
INTERFACE I_A
METHOD M : INT END_METHOD
END_INTERFACE
TYPE ST_A : STRUCT x : INT; pf : POINTER TO ST_A; END_STRUCT END_TYPE
FUNCTION_BLOCK FB_Q IMPLEMENTS I_A
VAR n : INT; pm : POINTER TO FB_Q; END_VAR
METHOD M : INT
  M := 1;
END_METHOD
  pm := 0;
END_FUNCTION_BLOCK
FUNCTION IsNull : BOOL
VAR_INPUT p : POINTER TO FB_Q; END_VAR
  IsNull := p = 0;
END_FUNCTION
PROGRAM Main
VAR
  q : FB_Q; s : ST_A; str : STRING; x : INT;
  pq : POINTER TO FB_Q; ps : POINTER TO ST_A; pi : POINTER TO I_A;
  pstr : POINTER TO STRING; pint : POINTER TO INT;
  pp : POINTER TO POINTER TO INT;
  pq0 : POINTER TO FB_Q := 0; pint0 : POINTER TO INT := 0;
  ps2 : POINTER TO ST_A; rs1, rs2 : REF_TO ST_A;
  ap : ARRAY[0..1] OF POINTER TO FB_Q;
  n, cnt : INT; b1, b2 : BOOL;
END_VAR
  pq := ADR(q); ps := ADR(s); pstr := ADR(str); pint := ADR(x);
  ap[0] := ADR(q); s.pf := ADR(s);
  IF pq <> 0 AND ps <> 0 AND pstr <> 0 AND pint <> 0 THEN cnt := 1; END_IF;
  b1 := IsNull(pq);
  ps2 := ADR(s); rs1 := REF(s); rs2 := REF(s);
  IF ps = ps2 AND ps <> NULL THEN cnt := cnt + 1; END_IF;
  IF rs1 = rs2 AND rs1 <> NULL THEN cnt := cnt + 1; END_IF;
  pq := 0; ps := 0; pi := 0; pstr := 0; pint := 0; pp := 0;
  ap[0] := 0; s.pf := 0;
  IF pq = 0 THEN n := n + 1; END_IF;
  IF ps = 0 THEN n := n + 1; END_IF;
  IF pi = 0 THEN n := n + 1; END_IF;
  IF pstr = 0 THEN n := n + 1; END_IF;
  IF pint = 0 THEN n := n + 1; END_IF;
  IF pp = 0 THEN n := n + 1; END_IF;
  IF pq0 = 0 AND pint0 = 0 THEN n := n + 1; END_IF;
  IF ap[0] = 0 AND s.pf = 0 THEN n := n + 1; END_IF;
  b2 := IsNull(0);
END_PROGRAM
`;

const VENDOR = {
  id: "vendor-x",
  name: "Vendor X",
  extends: "iec-3",
  features: ["pointer_to" as const],
  semantics: {},
};

const MODES: Array<[string, Parameters<typeof compile>[1]]> = [
  ["no flags", {}],
  ["strict", { strict: true }],
  ["strict vendor profile", { strict: true, dialect: VENDOR }],
];

describe("0 stored in a POINTER TO", () => {
  it.each(MODES)("is accepted for every target type (%s)", (_n, options) => {
    expect(compile(SOURCE, options).errors.map((e) => e.message)).toEqual([]);
  });

  it("is still refused where POINTER TO itself is (iec-3)", () => {
    const messages = compile(SOURCE, { dialect: "iec-3" }).errors.map(
      (e) => e.message,
    );
    expect(messages.length).toBeGreaterThan(0);
    expect(new Set(messages)).toEqual(
      new Set([
        "POINTER TO needs the feature pointer_to",
        "ADR needs the feature pointer_to",
      ]),
    );
  });

  it("refuses another integer for a STRUCT or FB target", () => {
    const errors = (body: string): string[] =>
      compile(
        `TYPE ST_A : STRUCT x : INT; END_STRUCT END_TYPE
FUNCTION_BLOCK FB_Q END_FUNCTION_BLOCK
PROGRAM Main
VAR pq : POINTER TO FB_Q; ps : POINTER TO ST_A; END_VAR
${body}
END_PROGRAM`,
      ).errors.map((e) => e.message);
    expect(errors("pq := 1;")).toEqual(["Cannot assign INT to FB_Q"]);
    expect(errors("ps := INT#0;")).toEqual(["Cannot assign INT to ST_A"]);
  });
});

describe.skipIf(!hasGpp)("0 stored in a POINTER TO end to end", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-ptrzero-"));
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
      testName: `pointer_zero_${name.replace(/ /g, "_")}`,
      mainCode: `#include <iostream>
int main() {
  strucpp::Program_MAIN p;
  p.run();
  std::cout << (int)p.N << " " << (int)p.CNT << " " << (bool)p.B1
            << (bool)p.B2 << std::endl;
  return 0;
}
`,
    });
    expect(out).toBe("8 3 01");
  });
});
