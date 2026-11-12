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
  }
});
