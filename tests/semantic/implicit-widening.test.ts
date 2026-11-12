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
  }
});
