// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * LDATE, LTOD and LDT (IEC 61131-3 Ed. 3): their literals, the implicit
 * conversion of DATE, TOD and DT to them, their arithmetic with LTIME and the
 * explicit conversions between the temporal types.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];

const program = (body: string): string => `PROGRAM Main
VAR
  ld : LDATE; lt : LTOD; ldt : LDT; d : DATE; t : TOD; dt1 : DT;
  dur : LTIME; tm : TIME; n : LINT; x : BOOL;
END_VAR
${body}
END_PROGRAM
`;
const result = (body: string, options: Options) =>
  compile(program(body), { ...options, headerFileName: "generated.hpp" });
const errors = (body: string, options: Options): string[] =>
  result(body, options).errors.map((e) => e.message);

describe("LDATE, LTOD and LDT", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      it("takes every literal spelling", () => {
        const r = result(
          `ld := LDATE#2024-01-15;
ld := LD#2024-1-5;
lt := LTOD#12:30:15.5;
lt := LTIME_OF_DAY#1:2:3;
ldt := LDT#2024-01-15-12:30:00;
ldt := LDATE_AND_TIME#2024-01-16-00:00:00;`,
          options,
        );
        expect(r.errors).toEqual([]);
        expect(r.cppCode).toContain("LD = 19737LL;");
        expect(r.cppCode).toContain("LT = 45015500000000LL;");
        expect(r.cppCode).toContain("LDT = 1705321800000000000LL;");
        expect(r.headerCode).toContain("IEC_LDATE LD;");
        expect(r.headerCode).toContain("IEC_LTOD LT;");
        expect(r.headerCode).toContain("IEC_LDT LDT;");
      });

      it("converts the short forms to the long ones implicitly, not back", () => {
        expect(
          errors("ld := d;\nlt := t;\nldt := dt1;\nx := ldt > dt1;", options),
        ).toEqual([]);
        expect(errors("d := ld;", options)).toEqual([
          "Cannot assign LDATE to DATE",
        ]);
        expect(errors("dt1 := ldt;", options)).toEqual([
          "Cannot assign LDT to DT",
        ]);
      });

      it("gives LTIME for the difference of long instants, and moves them by a duration", () => {
        expect(
          errors(
            "dur := ldt - ldt;\ndur := ldt - dt1;\ndur := lt - lt;\ndur := ld - ld;\nldt := ldt + LT#1h;\nldt := dt1 + LT#1h;\nlt := lt - T#1s;\nld := ld + LT#1d;",
            options,
          ),
        ).toEqual([]);
        expect(errors("tm := ldt - ldt;", options)).toEqual([
          "Cannot assign LTIME to TIME",
        ]);
      });

      it("splits and joins long instants in conversions", () => {
        const r = result(
          "ld := LDT_TO_LDATE(ldt);\nlt := LDT_TO_LTOD(ldt);\nldt := LDATE_TO_LDT(ld);\nd := LDATE_TO_DATE(ld);\nldt := DT_TO_LDT(dt1);\nn := LDT_TO_LINT(ldt);\nn := LDATE_TO_LINT(ld);",
          options,
        );
        expect(r.errors).toEqual([]);
        expect(r.cppCode).toContain("LD = TO_LDATE(DATE_OF_DT(LDT));");
        expect(r.cppCode).toContain("LT = TO_LTOD(TOD_OF_DT(LDT));");
        expect(r.cppCode).toContain("LDT = TO_LDT(DATE_TO_NS(LD));");
        expect(r.cppCode).toContain("N = TO_LINT(DATE_TO_NS(LD));");
      });

      it("keeps a variable named like a long type", () => {
        expect(
          compile(
            "VAR_GLOBAL ldate : INT; END_VAR\nPROGRAM Main\nVAR_EXTERNAL ldate : INT; END_VAR\nVAR ltod : INT; END_VAR\nldate := 1; ltod := ldate;\nEND_PROGRAM\n",
            options,
          ).errors,
        ).toEqual([]);
      });
    });
  }
});
