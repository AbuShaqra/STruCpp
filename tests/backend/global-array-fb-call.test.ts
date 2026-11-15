/**
 * An FB instance in an element of a global array is invoked, also through
 * the array's global variable list name and through a member path.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { withoutSites } from "../support/fault-sites.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];

const SOURCE = `FUNCTION_BLOCK FB_U
VAR_INPUT k : INT; END_VAR
VAR_OUTPUT n : INT; END_VAR
n := n + k;
END_FUNCTION_BLOCK
PROGRAM Main
VAR x : INT; END_VAR
units[0](k := 2);
GVL_A.units[1](k := 3);
x := units[0].n;
END_PROGRAM
`;

describe("FB invocation in a global array element", () => {
  for (const [label, options] of MODES) {
    it(label, () => {
      const r = compile(SOURCE, {
        ...options,
        headerFileName: "generated.hpp",
        additionalSources: [
          {
            source: "VAR_GLOBAL units : ARRAY[0..1] OF FB_U; END_VAR\n",
            fileName: "gvl_a.st",
            globalListName: "GVL_A",
          },
        ],
        features: ["+named_global_lists"],
      });
      expect(r.errors).toEqual([]);
      expect(withoutSites(r.cppCode)).toContain("UNITS.at(0).K = 2;\n    UNITS.at(0)();");
      expect(withoutSites(r.cppCode)).toContain("UNITS.at(1).K = 3;\n    UNITS.at(1)();");
    });
  }
});
