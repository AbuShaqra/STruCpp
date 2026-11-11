// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * A name is declared once among the VAR_GLOBAL blocks of a CONFIGURATION, and
 * once among those of each RESOURCE, whatever the type, value or CONSTANT.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];

const source = (
  configGlobals: string,
  resourceGlobals = "",
): string => `PROGRAM Main
VAR_EXTERNAL r : INT; END_VAR
VAR x : INT; END_VAR
x := r;
END_PROGRAM
CONFIGURATION Cfg
${configGlobals}
RESOURCE R1 ON PLC
${resourceGlobals}
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM inst WITH T : Main;
END_RESOURCE
END_CONFIGURATION
`;

const errors = (
  options: Options,
  configGlobals: string,
  resourceGlobals = "",
) =>
  compile(source(configGlobals, resourceGlobals), options).errors.map((e) => ({
    message: e.message,
    line: e.line,
    column: e.column,
  }));

describe("duplicate CONFIGURATION and RESOURCE globals", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      it("refuses a duplicate in one block, at the second declaration", () => {
        expect(
          errors(options, "VAR_GLOBAL r : INT := 1; r : INT := 2; END_VAR"),
        ).toEqual([
          {
            message: "Symbol 'R' already defined in scope 'CFG'",
            line: 7,
            column: 26,
          },
        ]);
      });

      it("refuses a duplicate in another block, of another type or CONSTANT", () => {
        for (const second of [
          "VAR_GLOBAL r : INT := 2; END_VAR",
          "VAR_GLOBAL R : DINT := 70000; END_VAR",
          "VAR_GLOBAL CONSTANT r : INT := 5; END_VAR",
        ]) {
          const found = errors(
            options,
            `VAR_GLOBAL r : INT := 1; END_VAR\n${second}`,
          );
          expect(found).toHaveLength(1);
          expect(found[0]!.message).toBe(
            "Symbol 'R' already defined in scope 'CFG'",
          );
          expect(found[0]!.line).toBe(8);
        }
      });

      it("refuses a name listed twice in one declaration", () => {
        expect(
          errors(options, "VAR_GLOBAL r, r : INT; END_VAR").map(
            (e) => e.message,
          ),
        ).toEqual(["Symbol 'R' already defined in scope 'CFG'"]);
      });

      it("refuses a duplicate within one RESOURCE", () => {
        expect(
          errors(
            options,
            "",
            "VAR_GLOBAL r : INT := 1; END_VAR\nVAR_GLOBAL r : INT := 2; END_VAR",
          ),
        ).toEqual([
          {
            message: "Symbol 'R' already defined in scope 'CFG.R1'",
            line: 10,
            column: 12,
          },
        ]);
      });

      it("accepts distinct names", () => {
        expect(
          errors(options, "VAR_GLOBAL r : INT := 1; s : INT := 2; END_VAR"),
        ).toEqual([]);
      });
    });
  }
});
