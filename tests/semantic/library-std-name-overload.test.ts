// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * A library FUNCTION named like a standard function (OSCAT's ROUND(IN, N)) is
 * called when the arguments fit only its signature; a call the standard
 * function takes keeps the standard function, whatever the library order.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { compile } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";

type Options = Parameters<typeof compile>[1];
const LIBS_DIR = path.resolve(__dirname, "../../libs");
const libsAvailable = fs.existsSync(path.join(LIBS_DIR, "oscat-basic.stlib"));
const libraries = libsAvailable ? discoverStlibs(LIBS_DIR) : [];
const reversed = [...libraries].reverse();
const MODES: Array<[string, Options]> = [
  ["no dialect", { libraries }],
  ["iec-3", { libraries, dialect: "iec-3" }],
  ["strict", { libraries, strict: true }],
  ["no dialect, libraries reversed", { libraries: reversed }],
];

const compileBody = (body: string, options: Options, decls = "") =>
  compile(
    `${decls}PROGRAM Main
VAR x : REAL := 3.14159; y : REAL; END_VAR
${body}
END_PROGRAM
`,
    options,
  );

describe.skipIf(!libsAvailable)("library FUNCTION of a standard name", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      it("calls the library ROUND(IN, N) for two arguments", () => {
        const r = compileBody(
          "y := ROUND(x, 2);\ny := ROUND(IN := x, N := 3);\ny := ROUND(N := 1, IN := x);",
          options,
        );
        expect(r.errors).toEqual([]);
        expect(r.cppCode).toContain("Y = ROUND(X, 2);");
      });

      it("keeps the standard ROUND for one argument", () => {
        const r = compileBody("y := ROUND(x);", options);
        expect(r.errors).toEqual([]);
        expect(r.cppCode).toContain("Y = ROUND(X);");
      });

      it("refuses arguments that fit neither signature", () => {
        expect(
          compileBody("y := ROUND(x, 2, 3);", options).errors.map(
            (e) => e.message,
          ),
        ).toEqual(["'ROUND' requires 1 argument(s), got 3"]);
        expect(
          compileBody("y := ROUND(IN := x, Q := 1);", options).errors.map(
            (e) => e.message,
          ),
        ).toEqual(["Function 'ROUND' has no parameter named 'Q'"]);
      });
    });
  }

  it("leaves a user FUNCTION ROUND in charge", () => {
    const decls = `FUNCTION ROUND : REAL
VAR_INPUT a : REAL; END_VAR
ROUND := a * 2.0;
END_FUNCTION
`;
    expect(
      compileBody(
        "y := ROUND(IN := x, N := 3);",
        { libraries },
        decls,
      ).errors.map((e) => e.message),
    ).toEqual([
      "Function 'ROUND' has no parameter named 'IN'",
      "Function 'ROUND' has no parameter named 'N'",
    ]);
  });
});
