/**
 * E2E: a property GET or SET may open with a declaration part (VAR ...
 * END_VAR, possibly empty). Its locals belong to that accessor, as a
 * METHOD's do: fresh on every call and invisible to the other accessor and
 * to the rest of the FUNCTION_BLOCK.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const SOURCE = `
INTERFACE I_P
PROPERTY Value : INT
GET END_GET
SET END_SET
END_PROPERTY
END_INTERFACE
FUNCTION_BLOCK FB_P IMPLEMENTS I_P
VAR _v : INT; _name : STRING(10); calls : INT; END_VAR
PROPERTY Value : INT
GET
VAR t : INT; k : INT := 3; END_VAR
  calls := calls + 1;
  t := _v * 2 + k;
  k := k + 100;
  IF t > 1000 THEN Value := 1000; RETURN; END_IF;
  Value := t;
END_GET
SET
VAR
  t : INT;
END_VAR
  t := Value + 1;
  _v := t;
END_SET
END_PROPERTY
PROPERTY Name : STRING(10)
GET
VAR END_VAR
  Name := _name;
END_GET
SET
VAR tmp : STRING; END_VAR
  tmp := CONCAT(Name, '!');
  _name := tmp;
END_SET
END_PROPERTY
PROPERTY Plain : INT
GET
  Plain := _v;
END_GET
END_PROPERTY
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_D EXTENDS FB_P
PROPERTY Extra : INT
GET
VAR t : INT; END_VAR
  t := Value;
  Extra := t + 1;
END_GET
END_PROPERTY
END_FUNCTION_BLOCK
PROGRAM Main
VAR p : FB_P; d : FB_D; itf : I_P; n1, n2, n3, n4, n5, n6 : INT; s : STRING; END_VAR
  p.Value := 4;
  n1 := p.Value;
  n2 := p.Value;
  p.Value := 600;
  n3 := p.Value;
  p.Name := 'abc';
  s := p.Name;
  n4 := p.Plain;
  d.Value := 1;
  n5 := d.Extra;
  itf := p;
  itf.Value := 9;
  n6 := itf.Value;
END_PROGRAM
`;

const PROPERTY = {
  id: "vendor-x",
  name: "Vendor X",
  extends: "iec-3",
  features: ["property" as const],
  semantics: {},
};

const MODES: Array<[string, Parameters<typeof compile>[1]]> = [
  ["property", { features: ["+property"] }],
  ["strict property", { strict: true, features: ["+property"] }],
  ["strict vendor profile", { strict: true, dialect: PROPERTY }],
];

function errorsFor(fb: string, options = MODES[0]![1]): string[] {
  return compile(
    `FUNCTION_BLOCK FB_P\nVAR _v : INT; END_VAR\n${fb}\nEND_FUNCTION_BLOCK\n`,
    options,
  ).errors.map((e) => e.message);
}

describe("declaration part of a property accessor", () => {
  it.each(MODES)("is accepted (%s)", (_name, options) => {
    expect(compile(SOURCE, options).errors.map((e) => e.message)).toEqual([]);
  });

  it("needs no feature in a FUNCTION_BLOCK, as a property itself", () => {
    const fb = SOURCE.replace(/INTERFACE[\s\S]*?END_INTERFACE/, "")
      .replace(" IMPLEMENTS I_P", "")
      .replace("itf : I_P; ", "")
      .replace(/ {2}itf := p;[\s\S]*?n6 := itf.Value;\n/, "");
    expect(compile(fb, {}).errors.map((e) => e.message)).toEqual([]);
    expect(
      compile(fb, { dialect: "iec-3" }).errors.map((e) => e.message),
    ).toEqual([]);
  });

  it("keeps a local out of the other accessor and the FB body", () => {
    const prop = `PROPERTY Value : INT
GET
VAR t : INT; END_VAR
  Value := t;
END_GET
SET
  t := Value;
END_SET
END_PROPERTY`;
    expect(errorsFor(prop)).toEqual(["Undeclared variable 'T'"]);
    expect(
      errorsFor(`${prop.replace("  t := Value;\n", "")}\nt := 1;`),
    ).toEqual(["Undeclared variable 'T'"]);
  });

  it("checks the types of the locals", () => {
    expect(
      errorsFor(`PROPERTY Value : INT
GET
VAR t : STRING; END_VAR
  Value := t;
END_GET
END_PROPERTY`),
    ).toEqual(["Cannot assign STRING to INT"]);
  });

  it("refuses a block other than VAR or VAR_TEMP", () => {
    for (const kind of ["VAR_INPUT", "VAR_OUTPUT", "VAR_IN_OUT"]) {
      expect(
        errorsFor(`PROPERTY Value : INT
GET
${kind} t : INT; END_VAR
  Value := 1;
END_GET
END_PROPERTY`),
      ).toEqual([
        `A property accessor declares only VAR or VAR_TEMP variables, not ${kind} (GET of 'VALUE')`,
      ]);
    }
  });

  it("leaves a property without a declaration part unchanged", () => {
    const plain = `FUNCTION_BLOCK FB_P
VAR _v : INT; END_VAR
PROPERTY Value : INT
GET
  Value := _v;
END_GET
SET
  _v := Value;
END_SET
END_PROPERTY
END_FUNCTION_BLOCK
`;
    const empty = plain
      .replace("GET\n", "GET\nVAR END_VAR\n")
      .replace("SET\n", "SET\nVAR\nEND_VAR\n");
    const a = compile(plain, {});
    const b = compile(empty, {});
    expect(b.errors).toEqual([]);
    expect(b.headerCode).toBe(a.headerCode);
    expect(b.cppCode.replace(/^#line.*$/gm, "")).toBe(
      a.cppCode.replace(/^#line.*$/gm, ""),
    );
  });
});

describe.skipIf(!hasGpp)("property accessor locals end to end", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-proplocals-"));
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
      testName: `property_locals_${name.replace(/ /g, "_")}`,
      mainCode: `#include <iostream>
int main() {
  strucpp::Program_MAIN p;
  p.run();
  std::cout << (int)p.N1 << " " << (int)p.N2 << " " << (int)p.N3 << " "
            << (int)p.N4 << " " << (int)p.N5 << " " << (int)p.N6 << " "
            << p.S.get().c_str() << " " << (int)p.P.CALLS << std::endl;
  return 0;
}
`,
    });
    expect(out).toBe("13 13 1000 601 8 23 abc! 4");
  });
});
