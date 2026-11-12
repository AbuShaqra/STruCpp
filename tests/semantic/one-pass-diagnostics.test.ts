// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * A file's literal range errors are reported in the same pass as its type
 * errors and its undefined types, not only once those are fixed.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { compile } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";

type Options = Parameters<typeof compile>[1];
const LIBS_DIR = path.resolve(__dirname, "../../libs");
const libraries = fs.existsSync(LIBS_DIR) ? discoverStlibs(LIBS_DIR) : [];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];

const messages = (source: string, options: Options): string[] =>
  compile(source, { ...options, libraries }).errors.map((e) => e.message);

describe("one-pass diagnostics", () => {
  for (const [label, options] of MODES) {
    it(`reports out-of-range literals with a type error (${label})`, () => {
      expect(
        messages(
          "PROGRAM Main\nVAR i : INT; n : INT; s : SINT; b : BYTE; END_VAR\nn := LEN(i);\ns := SINT#200;\nb := BYTE#256;\nEND_PROGRAM\n",
          options,
        ),
      ).toEqual([
        "Argument 'IN' of 'LEN' expects ANY_STRING, got INT",
        "Typed literal 'SINT#200' is outside the range of SINT (-128 to 127).",
        "Typed literal 'BYTE#256' is outside the range of BYTE (0 to 255).",
      ]);
    });

    it(`reports out-of-range literals with an undefined type (${label})`, () => {
      const found = messages(
        "PROGRAM Main\nVAR x : NOPE; s : SINT; END_VAR\ns := SINT#200;\nEND_PROGRAM\n",
        options,
      );
      expect(found).toContain(
        "Typed literal 'SINT#200' is outside the range of SINT (-128 to 127).",
      );
      expect(found.some((m) => m.includes("NOPE"))).toBe(true);
    });

    it(`reports a literal the type checks refused once (${label})`, () => {
      for (const body of [
        "VAR n : INT; END_VAR\nn := '☃';",
        "VAR w : WCHAR; END_VAR\nw := '☃';",
        "VAR c : CHAR; END_VAR\nc := '☃x';",
      ]) {
        const r = compile(`PROGRAM P\n${body}\nEND_PROGRAM\n`, {
          ...options,
          libraries,
        });
        expect(r.errors, body).toHaveLength(1);
        expect(r.errors[0]!.message, body).toMatch(/^Cannot assign STRING to /);
      }
    });

    it(`gives a CHAR literal its own message after a declaration error (${label})`, () => {
      const r = compile(
        "PROGRAM P\nVAR\n  c : CHAR;\n  x : INT;\n  x : INT;\nEND_VAR\nc := '☃';\nEND_PROGRAM\n",
        { ...options, libraries },
      );
      expect(
        r.errors.map((e) => `${e.line}:${e.column}: ${e.message}`),
      ).toEqual([
        "5:3: Symbol 'X' already defined in scope 'P'",
        "7:6: CHAR#'☃' holds a character Windows-1252 lacks, which a CHAR cannot store; use a WCHAR literal (WCHAR#\"...\") for it",
      ]);
    });

    it(`gives literals into WCHAR, WSTRING, CHAR inputs and CHAR their own messages after a declaration error (${label})`, () => {
      const body = (dup: boolean): string =>
        `FUNCTION F : INT\nVAR_INPUT c : CHAR; END_VAR\nF := 0;\nEND_FUNCTION\nPROGRAM P\nVAR ${dup ? "x : INT; x : INT; " : ""}r : INT; w : WCHAR; c : CHAR; ws : WSTRING; END_VAR\nr := F(c := '☃');\nw := '☃';\nc := '☃☃';\nws := '☃';\nr := F('é');\nEND_PROGRAM\n`;
      const list = (dup: boolean): string[] =>
        compile(body(dup), { ...options, libraries })
          .errors.map((e) => `${e.line}:${e.column}: ${e.message}`)
          .filter((m) => !m.includes("already defined"))
          .sort();
      const expected = [
        "10:7: Cannot assign STRING to WSTRING",
        "7:13: CHAR#'☃' holds a character Windows-1252 lacks, which a CHAR cannot store; use a WCHAR literal (WCHAR#\"...\") for it",
        "8:6: Cannot assign STRING to WCHAR",
        "9:6: Cannot assign STRING to CHAR",
      ];
      expect(list(true)).toEqual(expected);
      expect(list(false)).toEqual(expected);
    });

    it(`binds positional and method calls in the fallback as a clean compile does (${label})`, () => {
      const sources = [
        "FUNCTION F : INT\nVAR_IN_OUT io : INT; END_VAR\nVAR_INPUT s : STRING; c : CHAR; END_VAR\nF := LEN(s) * 1000 + CHAR_TO_INT(c);\nEND_FUNCTION\nPROGRAM P\nVAR r : INT; END_VAR\nr := F(r, 'hello', 'a');\n",
        "FUNCTION F : INT\nVAR_INPUT c : CHAR; END_VAR\nF := 1;\nEND_FUNCTION\nFUNCTION_BLOCK FB\nVAR_OUTPUT o : INT; END_VAR\nMETHOD F : INT\nVAR_INPUT c : STRING; END_VAR\nF := LEN(c);\nEND_METHOD\no := F('hello');\nEND_FUNCTION_BLOCK\nPROGRAM P\nVAR f1 : FB; r : INT; END_VAR\nf1();\n",
        "FUNCTION F : INT\nVAR_IN_OUT io : INT; END_VAR\nVAR_INPUT c : CHAR; ws : WSTRING; END_VAR\nF := 0;\nEND_FUNCTION\nPROGRAM P\nVAR r : INT; END_VAR\nr := F(r, 'ab', \"é\");\n",
      ];
      for (const head of sources) {
        const errors = (extra: string): string[] =>
          compile(`${head}${extra}END_PROGRAM\n`, { ...options, libraries })
            .errors.map((e) => `${e.line}:${e.column}: ${e.message}`)
            .filter((m) => !m.includes("Cannot assign TIME to INT"));
        expect(errors("r := T#1s;\n")).toEqual(errors(""));
      }
    });
  }
});
