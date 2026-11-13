// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: a PROPERTY read and written through a function block instance held in
 * a global variable, with and without its global list's name, and through a
 * member of one (`GVL.h.inner.Mode`), calls the getter and setter.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const MAIN = `FUNCTION_BLOCK FB_Unit
VAR st : INT := 3; END_VAR
PROPERTY Mode : INT
GET Mode := st; END_GET
SET st := Mode; END_SET
END_PROPERTY
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Holder VAR PUBLIC inner : FB_Unit; END_VAR END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_User
VAR_OUTPUT seen : INT; END_VAR
seen := GVL_Plant.fbUnit.Mode * 10;
fbUnit.Mode := 4;
END_FUNCTION_BLOCK
PROGRAM Main
VAR u : FB_User; a, b, c, d, e : INT; END_VAR
a := fbUnit.Mode;
GVL_Plant.fbUnit.Mode := 7;
b := GVL_Plant.fbUnit.Mode;
GVL_Plant.h.inner.Mode := 9;
c := h.inner.Mode;
h.inner.Mode := h.inner.Mode + 1;
d := GVL_Plant.h.inner.Mode;
u();
e := fbUnit.Mode * 100 + u.seen;
END_PROGRAM
`;

describe.skipIf(!hasGpp)(
  "PROPERTY through a global FB instance — g++ e2e",
  () => {
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-propglobal-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    for (const [label, options] of [
      ["no dialect", {}],
      ["iec-3", { dialect: "iec-3" }],
      ["strict", { strict: true }],
    ] as const) {
      it(`calls the getter and setter (${label})`, () => {
        const result = compile(MAIN, {
          ...options,
          headerFileName: "generated.hpp",
          fileName: "main.st",
          additionalSources: [
            {
              source: "VAR_GLOBAL fbUnit : FB_Unit; h : FB_Holder; END_VAR\n",
              fileName: "gvl.st",
              globalListName: "GVL_Plant",
            },
          ],
          features: ["+named_global_lists", "+property"],
        });
        expect(result.errors).toEqual([]);
        const stdout = compileAndRunStandalone({
          tempDir,
          pchPath,
          headerCode: result.headerCode,
          cppCode: result.cppCode,
          testName: `propglobal_${label.replace(/\W/g, "_")}`,
          mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.A.get() << " " << p.B.get() << " " << p.C.get() << " " << p.D.get() << " "
              << p.E.get() << std::endl;
    return 0;
}
`,
        });
        expect(stdout).toBe("3 7 9 10 470");
      });
    }

    const SHADOWED = `FUNCTION_BLOCK FB_Unit
VAR st : INT := 3; END_VAR
PROPERTY Mode : INT
GET Mode := st; END_GET
SET st := Mode + 1000; END_SET
END_PROPERTY
END_FUNCTION_BLOCK
TYPE S_Mode : STRUCT Mode : INT := 42; END_STRUCT END_TYPE
FUNCTION_BLOCK FB_Other VAR_OUTPUT Mode : INT := 7; END_VAR END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Base
VAR fbUnit : S_Mode; END_VAR
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_D EXTENDS FB_Base
VAR_OUTPUT o1, o2 : INT; END_VAR
METHOD M : INT
fbUnit.Mode := fbUnit.Mode + 1; M := fbUnit.Mode;
END_METHOD
fbUnit.Mode := fbUnit.Mode + 1; o1 := fbUnit.Mode; o2 := M();
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Own
VAR fbUnit : FB_Other; END_VAR VAR_OUTPUT o : INT; END_VAR
METHOD Lm : INT VAR fbUnit : S_Mode; END_VAR fbUnit.Mode := fbUnit.Mode + 2; Lm := fbUnit.Mode; END_METHOD
ACTION Act: o := o + fbUnit.Mode * 100; END_ACTION
o := fbUnit.Mode + Lm(); Act();
END_FUNCTION_BLOCK
FUNCTION FLocal : INT VAR fbUnit : S_Mode; END_VAR fbUnit.Mode := 5; FLocal := fbUnit.Mode; END_FUNCTION
VAR_GLOBAL fbUnit : FB_Unit; END_VAR
PROGRAM MAIN
VAR d : FB_D; w : FB_Own; a, b, c, e, g, h : INT; pm : S_Mode; END_VAR
d(); a := d.o1; b := d.o2;
w(); c := w.o;
e := FLocal();
fbUnit.Mode := 1; g := fbUnit.Mode;
pm.Mode := 9; h := pm.Mode;
END_PROGRAM
`;
    const SHADOWED_PROGRAM = `FUNCTION_BLOCK FB_Unit
VAR st : INT := 3; END_VAR
PROPERTY Mode : INT
GET Mode := st; END_GET
SET st := Mode + 1000; END_SET
END_PROPERTY
END_FUNCTION_BLOCK
TYPE S_Mode : STRUCT Mode : INT := 42; END_STRUCT END_TYPE
FUNCTION_BLOCK FE VAR_EXTERNAL fbUnit : FB_Unit; END_VAR VAR_OUTPUT o : INT; END_VAR fbUnit.Mode := 4; o := fbUnit.Mode; END_FUNCTION_BLOCK
VAR_GLOBAL fbUnit : FB_Unit; END_VAR
PROGRAM MAIN
VAR fbUnit : S_Mode; fe : FE; a, b : INT; END_VAR
fbUnit.Mode := fbUnit.Mode + 1; a := fbUnit.Mode;
fe(); b := fe.o;
END_PROGRAM
`;
    for (const [label, options] of [
      ["no dialect", {}],
      ["iec-3", { dialect: "iec-3" }],
      ["strict", { strict: true }],
    ] as const) {
      it(`resolves a name a local, member, inherited member, method local, action, VAR_EXTERNAL or PROGRAM member shadows before the global (${label})`, () => {
        for (const [source, expected, vars] of [
          [SHADOWED, "43 44 751 5 1001 9", ["A", "B", "C", "E", "G", "H"]],
          [SHADOWED_PROGRAM, "43 1004", ["A", "B"]],
        ] as const) {
          const result = compile(source, {
            ...options,
            headerFileName: "generated.hpp",
            features: ["+property"],
          });
          expect(result.errors).toEqual([]);
          const stdout = compileAndRunStandalone({
            tempDir,
            pchPath,
            headerCode: result.headerCode,
            cppCode: result.cppCode,
            testName: `propshadow_${vars.length}_${label.replace(/\W/g, "_")}`,
            mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << ${vars.map((v) => `p.${v}.get()`).join(' << " " << ')} << std::endl;
    return 0;
}
`,
          });
          expect(stdout).toBe(expected);
        }
      });
    }
  },
);
