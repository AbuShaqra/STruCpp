// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * The Ed. 3 Table 36 date and time functions of the bundled library, in every
 * dialect, and their precedence: a user FUNCTION of the name, or another
 * library's (OSCAT's DAY_OF_WEEK), is the one called.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { compile, compileStlib } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";

type Options = Parameters<typeof compile>[1];
const LIBS_DIR = path.resolve(__dirname, "../../libs");
const libsAvailable = fs.existsSync(path.join(LIBS_DIR, "oscat-basic.stlib"));
const all = libsAvailable ? discoverStlibs(LIBS_DIR) : [];
const noOscat = all.filter((a) => a.manifest.name !== "oscat-basic");
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];

const SOURCE = `PROGRAM Main
VAR
  d : DATE; t : TOD; lt : LTOD; dt : DT; ldt : LDT; x : INT; ok : BOOL;
  y : UINT; mo : USINT; dd : USINT; h : USINT; mi : USINT; s : USINT; ms : UINT;
END_VAR
d := CONCAT_DATE(2024, 2, 29);
t := CONCAT_TOD(12, 30, 15, 250);
lt := CONCAT_LTOD(12, 30, 15, 250);
dt := CONCAT_DT(2024, 2, 29, 12, 30, 15, 250);
ldt := CONCAT_LDT(2024, 2, 29, 12, 30, 15, 250);
ldt := CONCAT_DATE_LTOD(d, lt);
ok := SPLIT_DATE(IN := d, YEAR => y, MONTH => mo, DAY => dd);
ok := SPLIT_TOD(IN := t, HOUR => h, MINUTE => mi, SECOND => s, MILLISECOND => ms);
ok := SPLIT_LTOD(IN := lt, HOUR => h, MINUTE => mi, SECOND => s, MILLISECOND => ms);
ok := SPLIT_DT(IN := dt, YEAR => y, MONTH => mo, DAY => dd, HOUR => h, MINUTE => mi, SECOND => s, MILLISECOND => ms);
ok := SPLIT_LDT(IN := ldt, YEAR => y, MONTH => mo, DAY => dd, HOUR => h, MINUTE => mi, SECOND => s, MILLISECOND => ms);
x := DAY_OF_WEEK(d);
END_PROGRAM
`;
const dayOfWeekBody = (cpp: string): string =>
  (cpp.match(/DAY_OF_WEEK_result = [^;]*;/) ?? [""])[0];

describe.skipIf(!libsAvailable)("Table 36 date and time functions", () => {
  for (const [label, options] of MODES) {
    it(`compiles every function (${label})`, () => {
      const r = compile(SOURCE, { ...options, libraries: noOscat });
      expect(r.errors).toEqual([]);
      expect(dayOfWeekBody(r.cppCode)).toContain("% 7) + 7 + 4) % 7");
    });
  }

  it("gives way to OSCAT's DAY_OF_WEEK, in any library order", () => {
    for (const libraries of [all, [...all].reverse()]) {
      const r = compile(SOURCE, { libraries });
      expect(r.errors).toEqual([]);
      expect(dayOfWeekBody(r.cppCode)).toBe(
        "DAY_OF_WEEK_result = TO_INT((TO_DWORD(DATE_TO_SECONDS(IDATE)) / 86400 + 3) % 7) + 1;",
      );
      expect(r.cppCode.match(/IEC_INT DAY_OF_WEEK\(/g)).toHaveLength(1);
    }
  });

  it("keeps OSCAT's own DAY_OF_WEEK behind its chunks' dependencies", () => {
    const oscat = all.find((a) => a.manifest.name === "oscat-basic")!;
    const workWeek = oscat.chunks.find((c) => c.name === "WORK_WEEK")!;
    expect(workWeek.deps).toContainEqual({
      library: "oscat-basic",
      name: "DAY_OF_WEEK",
    });
  });

  it("gives way to a user FUNCTION of the name", () => {
    const r = compile(
      `FUNCTION SPLIT_DATE : INT\nVAR_INPUT IN : DATE; END_VAR\nSPLIT_DATE := 42;\nEND_FUNCTION\nPROGRAM Main\nVAR x : INT; END_VAR\nx := SPLIT_DATE(D#2024-01-01);\nEND_PROGRAM\n`,
      { libraries: noOscat },
    );
    expect(r.errors).toEqual([]);
    expect(r.cppCode).toContain("SPLIT_DATE_result = 42;");
    expect(r.cppCode).not.toContain("YEAR");
  });

  it("gives way to another library's FUNCTION_BLOCK or TYPE of the name, in any order", () => {
    const lib = compileStlib(
      [
        {
          fileName: "a.st",
          source:
            "FUNCTION_BLOCK SPLIT_TOD\nVAR_INPUT IN : INT; END_VAR\nVAR_OUTPUT o : INT; END_VAR\no := IN;\nEND_FUNCTION_BLOCK\nTYPE CONCAT_DATE : STRUCT a : INT; END_STRUCT; END_TYPE\nFUNCTION_BLOCK UseIt\nVAR c : CONCAT_DATE; END_VAR\nEND_FUNCTION_BLOCK\n",
        },
      ],
      {
        name: "zlib3",
        version: "1.0.0",
        namespace: "strucpp",
        dependencies: all,
      },
    );
    expect(lib.errors).toEqual([]);
    const clean =
      "PROGRAM Main\nVAR f : SPLIT_TOD; r : INT; c : CONCAT_DATE; END_VAR\nf(IN := 42); r := f.o; c.a := 1;\nEND_PROGRAM\n";
    for (const libraries of [
      [...noOscat, lib.archive],
      [lib.archive, ...noOscat],
    ]) {
      expect(compile(clean, { libraries }).errors).toEqual([]);
    }
  });

  for (const [label, options] of MODES) {
    const strict = label === "strict";
    it(`binds a SPLIT_* part as the assignment of it would (${label})`, () => {
      const wide = compile(
        "PROGRAM Main\nVAR ok : BOOL; y : UDINT; m : UINT; d : ULINT; END_VAR\nok := SPLIT_DATE(IN := D#2024-03-05, YEAR => y, MONTH => m, DAY => d);\nEND_PROGRAM\n",
        { ...options, libraries: noOscat },
      );
      expect(wide.errors).toEqual([]);
      expect(wide.cppCode).toContain(
        "auto& __gio_0_ref = Y; IEC_UINT __gio_0; __gio_0 = __gio_0_ref;",
      );
      const signed = compile(
        "PROGRAM Main\nVAR ok : BOOL; y : DINT; m : INT; END_VAR\nok := SPLIT_DATE(IN := D#2024-03-05, YEAR => y, MONTH => m);\nEND_PROGRAM\n",
        { ...options, libraries: noOscat },
      );
      // UINT into DINT is refused as an assignment outside --strict.
      expect(signed.errors.map((e) => e.message)).toEqual(
        strict
          ? []
          : ["Cannot assign UINT to DINT", "Cannot assign USINT to INT"],
      );
      const narrow = compile(
        "PROGRAM Main\nVAR ok : BOOL; m : SINT; END_VAR\nok := SPLIT_DATE(IN := D#2024-03-05, MONTH => m);\nEND_PROGRAM\n",
        { ...options, libraries: noOscat },
      );
      if (strict) {
        expect(narrow.errors.map((e) => e.message)).toEqual([
          "Implicit conversion from USINT to SINT is not allowed; use USINT_TO_SINT",
        ]);
      } else {
        expect(narrow.errors).toEqual([]);
        expect(narrow.warnings.map((w) => w.message)).toContain(
          "Implicit narrowing conversion from USINT to SINT",
        );
      }
    });

    it(`binds a user FUNCTION's output as an assignment, positional and THIS.x too (${label})`, () => {
      const r = compile(
        `TYPE MyU : UINT; END_TYPE
FUNCTION F : BOOL VAR_INPUT a : INT; END_VAR VAR_OUTPUT o : USINT; END_VAR o := 9; F := TRUE; END_FUNCTION
FUNCTION FL : BOOL VAR_OUTPUT o : LTIME; END_VAR FL := TRUE; END_FUNCTION
FUNCTION_BLOCK FB VAR_OUTPUT x : UINT; END_VAR VAR ok : BOOL; END_VAR ok := F(1, THIS.x); END_FUNCTION_BLOCK
PROGRAM Main
VAR ok : BOOL; u : UINT; mu : MyU; t : TIME; END_VAR
ok := F(1, u);
ok := F(a := 1, o => mu);
ok := FL(o => t);
END_PROGRAM
`,
        { ...options, libraries: noOscat },
      );
      expect(r.errors.map((e) => e.message)).toEqual([
        "Cannot assign LTIME to TIME",
      ]);
    });
  }

  it("keeps the other Table 36 functions when a library declares one name", () => {
    const lib = compileStlib(
      [
        {
          fileName: "a.st",
          source:
            "TYPE CONCAT_DATE : STRUCT a : INT; END_STRUCT; END_TYPE\nTYPE SPLIT_DATE : STRUCT b : INT; END_STRUCT; END_TYPE\nFUNCTION_BLOCK UseIt\nVAR_INPUT c : CONCAT_DATE; s : SPLIT_DATE; END_VAR\nEND_FUNCTION_BLOCK\n",
        },
      ],
      {
        name: "zlib4",
        version: "1.0.0",
        namespace: "strucpp",
        dependencies: all,
      },
    );
    expect(lib.errors).toEqual([]);
    const r = compile(
      "PROGRAM Main\nVAR dt1 : DT; ldt1 : LDT; ok : BOOL; y : UINT; END_VAR\ndt1 := CONCAT_DT(2024, 2, 29, 12, 30, 15, 250);\nldt1 := CONCAT_LDT(2024, 2, 29, 12, 30, 15, 250);\nok := SPLIT_DT(IN := dt1, YEAR => y);\nok := SPLIT_LDT(IN := ldt1, YEAR => y);\nEND_PROGRAM\n",
      { libraries: [...noOscat, lib.archive] },
    );
    expect(r.errors).toEqual([]);
  });

  it("has no Table 36 function call another", () => {
    const std = all.find((a) => a.manifest.name === "iec-standard-fb")!;
    const names = new Set([
      "CONCAT_DATE",
      "CONCAT_TOD",
      "CONCAT_LTOD",
      "CONCAT_DT",
      "CONCAT_LDT",
      "CONCAT_DATE_LTOD",
      "SPLIT_DATE",
      "SPLIT_TOD",
      "SPLIT_LTOD",
      "SPLIT_DT",
      "SPLIT_LDT",
      "DAY_OF_WEEK",
    ]);
    for (const chunk of std.chunks.filter((c) => names.has(c.name))) {
      expect(chunk.deps.filter((d) => names.has(d.name.toUpperCase()))).toEqual(
        [],
      );
    }
  });
});
