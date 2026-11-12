// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Table 26: DT_TO_DATE and DT_TO_TOD take the date or the time of day of a
 * date-and-time; Table 35: DATE - DATE is a TIME. A DATE holds days and a
 * duration nanoseconds, so codegen splits and scales. Before this, the
 * conversions copied the raw nanosecond count and DATE - DATE gave days.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];

const cpp = (body: string, options: Options): string => {
  const r = compile(
    `PROGRAM Main\nVAR dt1 : DT; d : DATE; d2 : DATE; t : TOD; tm : TIME; END_VAR\n${body}\nEND_PROGRAM\n`,
    options,
  );
  expect(r.errors).toEqual([]);
  return r.cppCode;
};

describe("DT_TO_DATE, DT_TO_TOD and DATE arithmetic", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      it("splits a DT into its date and its time of day", () => {
        const code = cpp(
          "d := DT_TO_DATE(dt1);\nt := DT_TO_TOD(dt1);\nd := DATE_AND_TIME_TO_DATE(dt1);\nt := DATE_AND_TIME_TO_TIME_OF_DAY(dt1);\nd := TO_DATE(dt1);",
          options,
        );
        expect(code).toContain("D = TO_DATE(DATE_OF_DT(DT1));");
        expect(code).toContain("T = TO_TOD(TOD_OF_DT(DT1));");
        expect(code).not.toContain("TO_DATE(DT1)");
        expect(code).not.toContain("TO_TOD(DT1)");
      });

      it("gives DATE - DATE in nanoseconds and moves a DATE by whole days", () => {
        const code = cpp(
          "tm := d2 - d;\nd := d + T#1d;\nd := d - T#2d;",
          options,
        );
        expect(code).toContain(
          "TM = ((DATE_TO_DAYS(D2) - DATE_TO_DAYS(D)) * 86400000000000LL);",
        );
        expect(code).toContain(
          "D = DATE_FROM_DAYS(DATE_TO_DAYS(D) + iec_unwrap(86400000000000LL) / 86400000000000LL);",
        );
        expect(code).toContain(
          "D = DATE_FROM_DAYS(DATE_TO_DAYS(D) - iec_unwrap(172800000000000LL) / 86400000000000LL);",
        );
      });

      it("classifies through aliases, dereferences and results", () => {
        const r = compile(
          `TYPE MyDate : DATE; END_TYPE
TYPE MyDT : DT; END_TYPE
FUNCTION GetD : DATE GetD := D#2024-01-20; END_FUNCTION
PROGRAM Main
VAR m1 : MyDate; m2 : MyDate; m : MyDT; t : TOD; d : DATE; tm : TIME; END_VAR
tm := m2 - m1;
tm := GetD() - d;
d := TO_DATE(m);
t := TO_TOD(CONCAT_DATE_TOD(d, t));
END_PROGRAM
`,
          options,
        );
        expect(r.errors).toEqual([]);
        expect(r.cppCode).toContain(
          "TM = ((DATE_TO_DAYS(M2) - DATE_TO_DAYS(M1)) * 86400000000000LL);",
        );
        expect(r.cppCode).toContain("TO_DATE(DATE_OF_DT(M))");
        expect(r.cppCode).toContain("TO_TOD(TOD_OF_DT(CONCAT_DATE_TOD(D, T)))");
      });
    });
  }
});
