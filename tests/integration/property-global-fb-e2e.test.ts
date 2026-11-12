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
              source:
                "VAR_GLOBAL fbUnit : FB_Unit; h : FB_Holder; END_VAR\n",
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
  },
);
