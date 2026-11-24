// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * A STRING or WSTRING VAR_IN_OUT written without a length has the default
 * length of the compilation (254, or 80 with string_default_80). A variable
 * of that length binds to it by reference, with no warning; one of another
 * length is passed by copy-in / copy-out with a warning, for a user FUNCTION,
 * FUNCTION_BLOCK and METHOD alike.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const SOURCE = (type: "STRING" | "WSTRING", length: number): string => `
FUNCTION F2 : INT
VAR_IN_OUT s1 : ${type}; s2 : ${type}; END_VAR
F2 := LEN(s2);
END_FUNCTION
FUNCTION_BLOCK FB2
VAR_IN_OUT s : ${type}; END_VAR
METHOD M : INT
VAR_IN_OUT t : ${type}; END_VAR
M := LEN(t);
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main
VAR a : ${type}(${length}); n : INT; fb : FB2; END_VAR
n := F2(s1 := a, s2 := a);
fb(s := a);
n := fb.M(t := a);
END_PROGRAM
`;

function copies(
  type: "STRING" | "WSTRING",
  length: number,
  features: string[],
): { warnings: string[]; copied: boolean } {
  const r = compile(SOURCE(type, length), {
    headerFileName: "generated.hpp",
    features,
  });
  expect(r.errors).toEqual([]);
  return {
    warnings: r.warnings
      .map((w) => w.message)
      .filter((m) => m.includes("copy-in / copy-out")),
    copied: r.cppCode.includes("__gio_"),
  };
}

describe("a plain STRING / WSTRING VAR_IN_OUT", () => {
  for (const type of ["STRING", "WSTRING"] as const) {
    for (const [mode, features, same, other] of [
      ["254", [], 254, 80],
      ["string_default_80", ["+string_default_80"], 80, 254],
    ] as const) {
      it(`binds a ${type}(${same}) by reference (${mode})`, () => {
        expect(copies(type, same, [...features])).toEqual({
          warnings: [],
          copied: false,
        });
      });

      it(`copies a ${type}(${other}) with a warning (${mode})`, () => {
        const c = copies(type, other, [...features]);
        expect(c.copied).toBe(true);
        expect(c.warnings).toHaveLength(4);
        for (const w of c.warnings) {
          expect(w).toMatch(
            new RegExp(`is bound to a variable of type ${type}\\(${other}\\)`),
          );
        }
      });
    }
  }
});
