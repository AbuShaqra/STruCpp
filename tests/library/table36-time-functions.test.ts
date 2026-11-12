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
import { compile } from "../../src/index.js";
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

  it("gives way to a user FUNCTION of the name", () => {
    const r = compile(
      `FUNCTION SPLIT_DATE : INT\nVAR_INPUT IN : DATE; END_VAR\nSPLIT_DATE := 42;\nEND_FUNCTION\nPROGRAM Main\nVAR x : INT; END_VAR\nx := SPLIT_DATE(D#2024-01-01);\nEND_PROGRAM\n`,
      { libraries: noOscat },
    );
    expect(r.errors).toEqual([]);
    expect(r.cppCode).toContain("SPLIT_DATE_result = 42;");
    expect(r.cppCode).not.toContain("YEAR");
  });
});
