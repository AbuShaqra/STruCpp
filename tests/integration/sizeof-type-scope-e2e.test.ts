// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: SIZEOF(T) measures the type only when no value in scope has the name
 * (a member, inherited from a user or library base, a property), and the type
 * it measures is not hidden by a FUNCTION, METHOD, ACTION or field of its name.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const LIBS = discoverStlibs(path.resolve(__dirname, "../../libs"));

const PROGRAM_MAIN = (vars: string[], extra = ""): string => `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout${vars.map((v) => ` << p.${v}.get() << " "`).join("")}${extra};
    return 0;
}
`;

describe.skipIf(!hasGpp)("SIZEOF(T) and the names in scope — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-sizeof-scope-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const run = (
    name: string,
    source: string,
    vars: string[],
    options: Parameters<typeof compile>[1] = {},
    extra = "",
  ): string => {
    const result = compile(source, {
      ...options,
      headerFileName: "generated.hpp",
      libraries: LIBS,
    });
    expect(result.errors).toEqual([]);
    return compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: `sizeof_scope_${name}`,
      mainCode: PROGRAM_MAIN(vars, extra),
    });
  };

  it("measures a member inherited from a library base FB, not a type of its name", () => {
    const out = run(
      "library_base",
      `TYPE Q : STRUCT a : LREAL; b : LREAL; END_STRUCT END_TYPE
FUNCTION_BLOCK FB_T EXTENDS TON
VAR_OUTPUT r1 : UDINT; END_VAR
r1 := SIZEOF(Q);
END_FUNCTION_BLOCK
PROGRAM Main
VAR b : FB_T; q1 : UDINT; END_VAR
b(); q1 := b.r1;
END_PROGRAM
`,
      ["Q1"],
    );
    expect(out).toBe("1");
  });

  it("measures a PROPERTY, not a type of its name", () => {
    const out = run(
      "property",
      `TYPE T_X : STRUCT a : LREAL; b : LREAL; END_STRUCT END_TYPE
FUNCTION_BLOCK FB_A
VAR_OUTPUT r1 : UDINT; END_VAR
PROPERTY T_X : INT
GET
T_X := 5;
END_GET
END_PROPERTY
r1 := SIZEOF(T_X);
END_FUNCTION_BLOCK
PROGRAM Main
VAR b : FB_A; q1 : UDINT; END_VAR
b(); q1 := b.r1;
END_PROGRAM
`,
      ["Q1"],
      { features: ["+property"] },
    );
    expect(out).toBe("2");
  });

  it("measures a sibling member in a PROGRAM or FB initial value, not a type of its name", () => {
    const out = run(
      "member_initial_value",
      `TYPE T_X : STRUCT a : LREAL; b : LREAL; END_STRUCT END_TYPE
FUNCTION_BLOCK FB_I
VAR T_X : INT; k : UDINT := SIZEOF(T_X); END_VAR
VAR_OUTPUT r : UDINT; END_VAR
r := k;
END_FUNCTION_BLOCK
PROGRAM Main
VAR k : UDINT := SIZEOF(T_X); T_X : SINT; fb : FB_I; fi : UDINT; END_VAR
fb(); fi := fb.r;
END_PROGRAM
`,
      ["K", "FI"],
    );
    expect(out).toBe("1 2");
  });

  it("measures the type when a FUNCTION, METHOD or ACTION has its name", () => {
    const out = run(
      "hidden_by_pou",
      `TYPE T_X : STRUCT a : LREAL; b : LREAL; END_STRUCT END_TYPE
TYPE T_Y : STRUCT a : LREAL; b : LREAL; c : LREAL; END_STRUCT END_TYPE
TYPE T_Z : STRUCT a : LREAL; END_STRUCT END_TYPE
FUNCTION T_X : INT
T_X := 1;
END_FUNCTION
FUNCTION_BLOCK FB_M
VAR_OUTPUT r : UDINT; END_VAR
METHOD T_Y : INT
T_Y := 2;
END_METHOD
r := SIZEOF(T_Y);
END_FUNCTION_BLOCK
PROGRAM Main
VAR a, m, c : UDINT; fb : FB_M; END_VAR
ACTION T_Z:
c := 0;
END_ACTION
a := SIZEOF(T_X);
fb(); m := fb.r;
c := SIZEOF(T_Z);
END_PROGRAM
`,
      ["A", "M", "C"],
    );
    expect(out).toBe("16 24 8");
  });

  it("measures the type in a STRUCT field default when a field has its name", () => {
    const out = run(
      "field_default",
      `TYPE E : (A, B); END_TYPE
TYPE T_X : STRUCT a : LREAL; b : LREAL; END_STRUCT END_TYPE
TYPE ST_D : STRUCT e : UDINT := SIZEOF(E); T_X : INT; n : UDINT := SIZEOF(T_X); END_STRUCT END_TYPE
PROGRAM Main
VAR d : ST_D; e1, n1 : UDINT; END_VAR
e1 := d.e; n1 := d.n;
END_PROGRAM
`,
      ["E1", "N1"],
    );
    expect(out).toBe("2 16");
  });

  it("emits a type a STRUCT field default measures before the STRUCT", () => {
    const out = run(
      "later_type",
      `TYPE ST_A : STRUCT n : UDINT := SIZEOF(ST_B); END_STRUCT END_TYPE
TYPE ST_B : STRUCT a : LREAL; b : LREAL; END_STRUCT END_TYPE
PROGRAM Main
VAR s : ST_A; a : UDINT; END_VAR
a := s.n;
END_PROGRAM
`,
      ["A"],
    );
    expect(out).toBe("16");
  });

  it("measures a type in a CONFIGURATION or global initial value, an INTERFACE in a STRUCT default", () => {
    const out = run(
      "global_initial_value",
      `TYPE T_X : STRUCT a : LREAL; b : LREAL; END_STRUCT END_TYPE
INTERFACE I_A
METHOD M : INT
END_METHOD
END_INTERFACE
TYPE ST_I : STRUCT i : UDINT := SIZEOF(I_A); END_STRUCT END_TYPE
VAR_GLOBAL g1 : UDINT := SIZEOF(T_X); g4 : UDINT := SIZEOF(I_A); END_VAR
PROGRAM Main
VAR c, d, e : UDINT; s : ST_I; END_VAR
c := g1; d := g4; e := s.i;
END_PROGRAM
CONFIGURATION C
VAR_GLOBAL cg : UDINT := SIZEOF(T_X); ch : UDINT := SIZEOF(LREAL); END_VAR
RESOURCE R ON PLC
TASK t(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM inst WITH t : Main;
END_RESOURCE
END_CONFIGURATION
`,
      ["C", "D", "E"],
      {},
      ` << strucpp::CG.value.get() << " " << strucpp::CH.value.get() << " " << sizeof(strucpp::IEC_ITF<strucpp::I_A>)`,
    );
    expect(out).toBe("16 8 8 16 8 8");
  });

  it("measures a platform type under platform_types", () => {
    const types = ["XINT", "UXINT", "__XINT", "__UXINT", "XWORD", "PVOID"];
    const out = run(
      "platform",
      `PROGRAM Main
VAR
${types.map((t, i) => `v${i} : ${t}; t${i}, s${i} : UDINT;`).join("\n")}
END_VAR
${types.map((t, i) => `t${i} := SIZEOF(${t}); s${i} := SIZEOF(v${i});`).join("\n")}
END_PROGRAM
`,
      types.flatMap((_, i) => [`T${i}`, `S${i}`]),
      { features: ["+platform_types"] },
    );
    expect(out).toBe("8 8 8 8 8 8 8 8 8 8 8 8");
  });

  it("emits a library FB class measured only by SIZEOF", () => {
    const out = run(
      "library_fb_only",
      `PROGRAM Main
VAR e : UDINT; END_VAR
e := SIZEOF(R_TRIG);
END_PROGRAM
`,
      ["E"],
      {},
      ` << sizeof(strucpp::R_TRIG)`,
    );
    const [measured, actual] = out.split(" ");
    expect(measured).toBe(actual);
  });

  it("measures LTIME, LDATE, LTOD, LDT, CHAR and WCHAR as a variable of the type", () => {
    const types = ["LTIME", "LDATE", "LTOD", "LDT", "CHAR", "WCHAR"];
    const out = run(
      "elementary",
      `PROGRAM Main
VAR
${types.map((t, i) => `v${i} : ${t}; t${i}, s${i} : UDINT;`).join("\n")}
END_VAR
${types.map((t, i) => `t${i} := SIZEOF(${t}); s${i} := SIZEOF(v${i});`).join("\n")}
END_PROGRAM
`,
      types.flatMap((_, i) => [`T${i}`, `S${i}`]),
    );
    expect(out).toBe("8 8 8 8 8 8 8 8 1 1 2 2");
  });
});

describe("SIZEOF(T) in a STRUCT field default that cannot be measured there", () => {
  const errors = (source: string): string[] =>
    compile(source, {
      headerFileName: "generated.hpp",
      libraries: LIBS,
    }).errors.map((e) => `${e.line}:${e.column} ${e.message}`);
  const ONLY =
    "only an elementary type, an INTERFACE, or a TYPE of this unit that holds no function block, can be measured there";

  it("refuses a FUNCTION_BLOCK and a library FB", () => {
    expect(
      errors(`FUNCTION_BLOCK FB1
VAR a : DINT; END_VAR
END_FUNCTION_BLOCK
TYPE ST_D : STRUCT
  n : UDINT := SIZEOF(FB1);
  t : UDINT := SIZEOF(TON);
END_STRUCT END_TYPE
PROGRAM Main
VAR d : ST_D; END_VAR
END_PROGRAM
`),
    ).toEqual([
      `5:23 SIZEOF(FB1) in the default of STRUCT field 'N': ${ONLY}`,
      `6:23 SIZEOF(TON) in the default of STRUCT field 'T': ${ONLY}`,
    ]);
  });

  it("refuses a FUNCTION_BLOCK and a library FB in a global's initial value", () => {
    expect(
      errors(`FUNCTION_BLOCK FB_A
VAR x : LREAL; END_VAR
END_FUNCTION_BLOCK
VAR_GLOBAL g3 : UDINT := SIZEOF(FB_A); END_VAR
PROGRAM Main
VAR a : UDINT; END_VAR
a := g3;
END_PROGRAM
CONFIGURATION C
VAR_GLOBAL g2 : UDINT := SIZEOF(TON); END_VAR
RESOURCE R ON PLC
TASK t(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM inst WITH t : Main;
END_RESOURCE
END_CONFIGURATION
`),
    ).toEqual([
      `4:33 SIZEOF(FB_A) in the initial value of global 'G3': ${ONLY}`,
      `10:33 SIZEOF(TON) in the initial value of global 'G2': ${ONLY}`,
    ]);
  });

  it("refuses a type that needs the STRUCT itself", () => {
    expect(
      errors(`TYPE ST_A : STRUCT a : LREAL; n : UDINT := SIZEOF(ST_B); END_STRUCT END_TYPE
TYPE ST_B : STRUCT a : LREAL; s : ST_A; END_STRUCT END_TYPE
PROGRAM Main
VAR s : ST_B; END_VAR
END_PROGRAM
`),
    ).toEqual([
      "1:51 SIZEOF(ST_B) in the default of STRUCT field 'N': 'ST_B' needs 'ST_A' complete, so 'ST_A' cannot measure it",
    ]);
  });
});
