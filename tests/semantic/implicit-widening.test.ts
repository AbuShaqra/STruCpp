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

    it(`types AND, OR and XOR on bit strings as the wider bit string (${label})`, () => {
      const strict = label === "strict";
      const r = compile(
        "PROGRAM Main\nVAR b : BYTE; w : WORD; x, y : BOOL; i : INT; d : DWORD; END_VAR\nb := w OR b;\nx := w AND w;\ni := w XOR w;\nd := w AND b;\nx := x OR y;\nEND_PROGRAM\n",
        options,
      );
      if (strict) {
        expect(r.errors.map((e) => e.message)).toEqual([
          "Implicit conversion from WORD to BYTE is not allowed; use WORD_TO_BYTE",
          "Implicit conversion from WORD to BOOL is not allowed; use WORD_TO_BOOL",
          "Implicit conversion from WORD to INT is not allowed; use WORD_TO_INT",
        ]);
      } else {
        expect(r.errors).toEqual([]);
        expect(r.warnings.map((w) => w.message)).toEqual([
          "Implicit narrowing conversion from WORD to BYTE",
          "Implicit narrowing conversion from WORD to BOOL",
        ]);
      }
    });

    it(`checks an FB output capture as a FUNCTION's under --strict (${label})`, () => {
      const strict = label === "strict";
      const r = compile(
        "FUNCTION_BLOCK FB VAR_OUTPUT o : WORD; d : DINT; END_VAR END_FUNCTION_BLOCK\nPROGRAM Main\nVAR b : BYTE; s : SINT; fb : FB; l : LINT; dw : DWORD; END_VAR\nfb(o => b);\nfb(d => s);\nfb(d => l, o => dw);\nEND_PROGRAM\n",
        options,
      );
      expect(r.errors.map((e) => e.message)).toEqual(
        strict
          ? [
              "Implicit conversion from WORD to BYTE is not allowed; use WORD_TO_BYTE",
              "Implicit conversion from DINT to SINT is not allowed; use DINT_TO_SINT",
            ]
          : [],
      );
    });

    it(`checks the argument of a typed conversion under --strict only (${label})`, () => {
      const strict = label === "strict";
      const r = compile(
        "PROGRAM Main\nVAR b : BYTE; w : WORD; i : INT; r : REAL; d : DINT; u : UINT; END_VAR\ni := BYTE_TO_INT(w);\nb := INT_TO_BYTE(w);\ni := BYTE_TO_INT(r);\nb := INT_TO_BYTE(d);\ni := BYTE_TO_INT(b);\ni := BYTE_TO_INT(16#FF);\nr := INT_TO_REAL(i);\ni := UINT_TO_INT(u);\nEND_PROGRAM\n",
        options,
      );
      expect(r.errors.map((e) => e.message)).toEqual(
        strict
          ? [
              "Implicit conversion from WORD to BYTE is not allowed; use WORD_TO_BYTE",
              "Implicit conversion from WORD to INT is not allowed; use WORD_TO_INT",
              "Implicit conversion from REAL to BYTE is not allowed; use REAL_TO_BYTE",
              "Implicit conversion from DINT to INT is not allowed; use DINT_TO_INT",
            ]
          : [],
      );
    });

    it(`types AND, OR and XOR on integers as the integer, refused under iec-3 and --strict (${label})`, () => {
      const lax = label === "no dialect";
      const r = compile(
        "PROGRAM Main\nVAR i, j : INT; d : DINT; s : SINT; x, y : BOOL; w : WORD; b : BYTE; END_VAR\ni := i AND j;\nd := i OR d;\ns := i XOR j;\nx := x AND y;\nw := w AND 16#FF;\nb := b AND 1;\nEND_PROGRAM\n",
        options,
      );
      const table31 = (op: string): string =>
        `${op} takes bit strings or BOOL (ANY_BIT, IEC 61131-3 Table 31), not INT; convert it with INT_TO_WORD or the like`;
      expect(r.errors.map((e) => e.message)).toEqual(
        lax
          ? []
          : [
              table31("AND"),
              table31("OR"),
              table31("XOR"),
              ...(label === "strict"
                ? [
                    "Implicit conversion from INT to SINT is not allowed; use INT_TO_SINT",
                  ]
                : []),
            ],
      );
      if (label !== "strict") {
        expect(r.warnings.map((w) => w.message)).toContain(
          "Implicit narrowing conversion from INT to SINT",
        );
      }
    });

    it(`refuses a non-BOOL condition only under --strict (${label})`, () => {
      const r = compile(
        "PROGRAM Main\nVAR w : WORD; x : BOOL; i : INT; END_VAR\nIF w THEN i := 1; ELSIF w AND 1 THEN i := 2; ELSIF x THEN i := 3; END_IF;\nWHILE w DO w := 0; END_WHILE;\nREPEAT i := 0; UNTIL w END_REPEAT;\nIF (w AND 1) <> 0 THEN i := 4; END_IF;\nEND_PROGRAM\n",
        options,
      );
      expect(r.errors.map((e) => `${e.line}:${e.column} ${e.message}`)).toEqual(
        label === "strict"
          ? ["3:4", "3:25", "4:7", "5:22"].map(
              (at) =>
                `${at} Condition must be BOOL under --strict, got WORD; compare it, e.g. WORD <> 0`,
            )
          : [],
      );
    });

    it(`takes a method named like a conversion as the method under --strict (${label})`, () => {
      const r = compile(
        "FUNCTION_BLOCK FB\nMETHOD INT_TO_BYTE : BYTE VAR_INPUT v : DWORD; END_VAR INT_TO_BYTE := DWORD_TO_BYTE(v); END_METHOD\nMETHOD Run : BYTE VAR d : DWORD := 5; END_VAR Run := INT_TO_BYTE(d); END_METHOD\nEND_FUNCTION_BLOCK\nPROGRAM Main\nVAR fb : FB; b : BYTE; END_VAR\nb := fb.Run();\nEND_PROGRAM\n",
        options,
      );
      expect(r.errors).toEqual([]);
    });

    it(`checks duration, date and string conversion arguments under --strict only (${label})`, () => {
      const r = compile(
        "PROGRAM Main\nVAR t : TIME; lt : LTIME; d : DINT; da : DATE; ws : WSTRING; s : STRING; i : INT; END_VAR\nd := TIME_TO_DINT(t);\nd := LTIME_TO_DINT(t);\nd := TIME_TO_DINT(lt);\nt := DINT_TO_TIME(t);\nd := DATE_TO_DINT(t);\ni := STRING_TO_INT(ws);\ni := STRING_TO_INT(s);\ni := STRING_TO_INT('12');\nd := TIME_TO_DINT(T#1s);\nEND_PROGRAM\n",
        options,
      );
      expect(r.errors.map((e) => e.message)).toEqual(
        label === "strict"
          ? [
              "Implicit conversion from LTIME to TIME is not allowed; use LTIME_TO_TIME",
              "Implicit conversion from TIME to DINT is not allowed; use TIME_TO_DINT",
              "Implicit conversion from TIME to DATE is not allowed; use TIME_TO_DATE",
              "Implicit conversion from WSTRING to STRING is not allowed; use WSTRING_TO_STRING",
            ]
          : [],
      );
    });
  }
});
