// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Implicit conversions of IEC 61131-3 Ed. 3 Figures 11 and 12: every one is
 * accepted in every mode, an unsigned integer into a wider signed one
 * included; the conversions they do not list stay as before.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { isUnsignedToWiderSigned } from "../../src/semantic/type-utils.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];

/** The implicit cells of Figure 11 (source to targets), Figure 12's paths. */
const FIGURE: Record<string, string[]> = {
  REAL: ["LREAL"],
  DINT: ["LREAL", "LINT"],
  INT: ["LREAL", "REAL", "LINT", "DINT"],
  SINT: ["LREAL", "REAL", "LINT", "DINT", "INT"],
  UDINT: ["LREAL", "LINT", "ULINT"],
  UINT: ["LREAL", "REAL", "LINT", "DINT", "ULINT", "UDINT"],
  USINT: ["LREAL", "REAL", "LINT", "DINT", "INT", "ULINT", "UDINT", "UINT"],
  DWORD: ["LWORD"],
  WORD: ["LWORD", "DWORD"],
  BYTE: ["LWORD", "DWORD", "WORD"],
  BOOL: ["LWORD", "DWORD", "WORD", "BYTE"],
  TIME: ["LTIME"],
  DT: ["LDT"],
  DATE: ["LDATE"],
  TOD: ["LTOD"],
};

/**
 * Conversions the figures do not list that involve a bit string: refused under
 * --strict, and accepted (ok) or warned (W) as before in the other modes.
 */
const BIT_STRING_CELLS: Array<[string, string, "ok" | "W"]> = [
  ["LREAL", "LWORD", "W"],
  ["LREAL", "DWORD", "W"],
  ["LREAL", "WORD", "W"],
  ["LREAL", "BYTE", "W"],
  ["REAL", "LWORD", "W"],
  ["REAL", "DWORD", "W"],
  ["REAL", "WORD", "W"],
  ["REAL", "BYTE", "W"],
  ["LINT", "LWORD", "ok"],
  ["LINT", "DWORD", "W"],
  ["LINT", "WORD", "W"],
  ["LINT", "BYTE", "W"],
  ["DINT", "LWORD", "ok"],
  ["DINT", "DWORD", "ok"],
  ["DINT", "WORD", "W"],
  ["DINT", "BYTE", "W"],
  ["INT", "LWORD", "ok"],
  ["INT", "DWORD", "ok"],
  ["INT", "WORD", "ok"],
  ["INT", "BYTE", "W"],
  ["SINT", "LWORD", "ok"],
  ["SINT", "DWORD", "ok"],
  ["SINT", "WORD", "ok"],
  ["SINT", "BYTE", "ok"],
  ["ULINT", "LWORD", "ok"],
  ["ULINT", "DWORD", "W"],
  ["ULINT", "WORD", "W"],
  ["ULINT", "BYTE", "W"],
  ["UDINT", "LWORD", "ok"],
  ["UDINT", "DWORD", "ok"],
  ["UDINT", "WORD", "W"],
  ["UDINT", "BYTE", "W"],
  ["UINT", "LWORD", "ok"],
  ["UINT", "DWORD", "ok"],
  ["UINT", "WORD", "ok"],
  ["UINT", "BYTE", "W"],
  ["USINT", "LWORD", "ok"],
  ["USINT", "DWORD", "ok"],
  ["USINT", "WORD", "ok"],
  ["USINT", "BYTE", "ok"],
  ["LWORD", "LREAL", "ok"],
  ["LWORD", "REAL", "W"],
  ["LWORD", "LINT", "ok"],
  ["LWORD", "DINT", "W"],
  ["LWORD", "INT", "W"],
  ["LWORD", "SINT", "W"],
  ["LWORD", "ULINT", "ok"],
  ["LWORD", "UDINT", "W"],
  ["LWORD", "UINT", "W"],
  ["LWORD", "USINT", "W"],
  ["LWORD", "DWORD", "W"],
  ["LWORD", "WORD", "W"],
  ["LWORD", "BYTE", "W"],
  ["LWORD", "BOOL", "W"],
  ["DWORD", "LREAL", "ok"],
  ["DWORD", "REAL", "ok"],
  ["DWORD", "LINT", "ok"],
  ["DWORD", "DINT", "ok"],
  ["DWORD", "INT", "W"],
  ["DWORD", "SINT", "W"],
  ["DWORD", "ULINT", "ok"],
  ["DWORD", "UDINT", "ok"],
  ["DWORD", "UINT", "W"],
  ["DWORD", "USINT", "W"],
  ["DWORD", "WORD", "W"],
  ["DWORD", "BYTE", "W"],
  ["DWORD", "BOOL", "W"],
  ["WORD", "LREAL", "ok"],
  ["WORD", "REAL", "ok"],
  ["WORD", "LINT", "ok"],
  ["WORD", "DINT", "ok"],
  ["WORD", "INT", "ok"],
  ["WORD", "SINT", "W"],
  ["WORD", "ULINT", "ok"],
  ["WORD", "UDINT", "ok"],
  ["WORD", "UINT", "ok"],
  ["WORD", "USINT", "W"],
  ["WORD", "BYTE", "W"],
  ["WORD", "BOOL", "W"],
  ["BYTE", "LREAL", "ok"],
  ["BYTE", "REAL", "ok"],
  ["BYTE", "LINT", "ok"],
  ["BYTE", "DINT", "ok"],
  ["BYTE", "INT", "ok"],
  ["BYTE", "SINT", "ok"],
  ["BYTE", "ULINT", "ok"],
  ["BYTE", "UDINT", "ok"],
  ["BYTE", "UINT", "ok"],
  ["BYTE", "USINT", "ok"],
  ["BYTE", "BOOL", "W"],
];

const assign = (from: string, to: string, options: Options) =>
  compile(
    `PROGRAM Main\nVAR a : ${from}; b : ${to}; END_VAR\nb := a;\nEND_PROGRAM\n`,
    options,
  );

describe("implicit widening (Figures 11 and 12)", () => {
  it("names the unsigned to wider signed conversions", () => {
    expect(isUnsignedToWiderSigned("USINT", "INT")).toBe(true);
    expect(isUnsignedToWiderSigned("UDINT", "LINT")).toBe(true);
    expect(isUnsignedToWiderSigned("UINT", "INT")).toBe(false);
    expect(isUnsignedToWiderSigned("INT", "UDINT")).toBe(false);
    expect(isUnsignedToWiderSigned("BYTE", "INT")).toBe(false);
  });

  for (const [label, options] of MODES) {
    it(`accepts every implicit conversion of the figure without a warning (${label})`, () => {
      for (const [from, targets] of Object.entries(FIGURE)) {
        for (const to of targets) {
          const r = assign(from, to, options);
          expect(r.errors, `${from} -> ${to}`).toEqual([]);
          expect(
            r.warnings.filter((w) => /narrowing/i.test(w.message)),
            `${from} -> ${to}`,
          ).toEqual([]);
        }
      }
    });

    it(`still refuses or warns where the figure has no implicit conversion (${label})`, () => {
      const strict = label === "strict";
      expect(assign("INT", "UDINT", options).errors.length).toBe(1);
      expect(
        assign("UINT", "INT", options).warnings.map((w) => w.message),
      ).toEqual(
        strict ? [] : ["Implicit narrowing conversion from UINT to INT"],
      );
      expect(
        assign("LTIME", "TIME", options).errors.map((e) => e.message),
      ).toEqual(["Cannot assign LTIME to TIME"]);
      expect(assign("UINT", "INT", options).errors.length > 0).toBe(strict);
    });

    it(`refuses a bit string conversion the figure does not list only under --strict (${label})`, () => {
      const strict = label === "strict";
      for (const [from, to, lax] of BIT_STRING_CELLS) {
        const r = assign(from, to, options);
        if (strict) {
          expect(
            r.errors.map((e) => e.message),
            `${from} -> ${to}`,
          ).toEqual([
            `Implicit conversion from ${from} to ${to} is not allowed; use ${from}_TO_${to}`,
          ]);
        } else {
          expect(r.errors, `${from} -> ${to}`).toEqual([]);
          expect(
            r.warnings.some((w) => /narrowing/i.test(w.message)),
            `${from} -> ${to}`,
          ).toBe(lax === "W");
        }
      }
      const constants = compile(
        "PROGRAM Main\nVAR w : WORD; b : BYTE; d : DWORD; END_VAR\nw := 16#FF; b := TRUE; w := w AND 16#F0; d := w OR 1;\nEND_PROGRAM\n",
        options,
      );
      expect(constants.errors).toEqual([]);
    });
  }
});
