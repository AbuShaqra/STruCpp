// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * With the bundled libraries loaded, a standard function resolves to the
 * std-function library's entry and its arguments are still checked against
 * the IEC constraints; library functions of their own keep their signature.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { compile } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";

type Options = Parameters<typeof compile>[1];
const LIBS_DIR = path.resolve(__dirname, "../../libs");
const libsAvailable = fs.existsSync(
  path.join(LIBS_DIR, "iec-std-functions.stlib"),
);
const libraries = libsAvailable ? discoverStlibs(LIBS_DIR) : [];
const MODES: Array<[string, Options]> = [
  ["no dialect", { libraries }],
  ["iec-3", { libraries, dialect: "iec-3" }],
  ["strict", { libraries, strict: true }],
];

const errors = (body: string, options: Options): string[] =>
  compile(
    `TYPE E : (A, B); END_TYPE
PROGRAM Main
VAR s : STRING := 'ABC'; i : INT; e : E; x : REAL; r : REAL; END_VAR
${body}
END_PROGRAM
`,
    options,
  ).errors.map((e) => e.message);

describe.skipIf(!libsAvailable)(
  "standard function arguments with the bundled libraries",
  () => {
    for (const [label, options] of MODES) {
      describe(label, () => {
        it("refuses an argument outside the IEC constraint", () => {
          expect(errors("i := LEN(i);", options)).toEqual([
            "Argument 'IN' of 'LEN' expects ANY_STRING, got INT",
          ]);
          expect(errors("s := CONCAT(s, i);", options)).toEqual([
            "Argument 'IN2' of 'CONCAT' expects ANY_STRING, got INT",
          ]);
          expect(errors("s := MID(s, s, 2);", options)).toEqual([
            "Argument 'L' of 'MID' expects INT, got STRING",
          ]);
        });

        it("reports an enumeration ordering argument once", () => {
          expect(errors("e := MAX(e, E#B);", options)).toEqual([
            "Argument 'IN1' of 'MAX' expects ANY_ELEMENTARY, got E",
          ]);
        });

        it("accepts valid arguments and an unrefined generic result", () => {
          expect(
            errors(
              "i := LEN(s);\ns := CONCAT(s, 'x');\ni := TRUNC(LIMIT(0.0, x, 1.0));",
              options,
            ),
          ).toEqual([]);
        });

        it("keeps a library function's own signature", () => {
          expect(errors("x := ATAN2(x, r);", options)).toEqual([]);
        });
      });
    }
  },
);
