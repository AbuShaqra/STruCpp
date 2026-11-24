// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * TIME, DATE, TOD and DT are 32-bit, as on the PLC: a typed literal outside
 * their range, a negative TIME or a TIME below a millisecond is refused at
 * compile time, in sources and in test files; LTIME keeps its range, and
 * LDATE and LDT their dates before 1970. A literal digit below the resolution
 * of a TOD, DT, LTOD or LDT is a warning, an error under iec-3 and --strict.
 */
import { describe, it, expect } from "vitest";
import { compile, type CompileOptions } from "../../src/index.js";
import { parseTestFile } from "../../src/testing/test-parser.js";
import { analyzeTestFile } from "../../src/semantic/analyzer.js";

const errors = (decls: string, opts: Partial<CompileOptions> = {}): string[] =>
  compile(`PROGRAM P\nVAR\n${decls}\nEND_VAR\nEND_PROGRAM\n`, opts).errors.map(
    (e) => `${e.line}:${e.column}: ${e.message}`,
  );

const MODES: Array<[string, Partial<CompileOptions>]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];

describe("32-bit date and time literals", () => {
  for (const [label, opts] of MODES) {
    describe(label, () => {
      it("accepts the ends of each range", () => {
        expect(
          errors(
            `a : TIME := T#0ms; b : TIME := T#49d17h2m47s295ms;
c : DATE := D#1970-01-01; d : DATE := D#2106-02-07;
e : DT := DT#1970-01-01-00:00:00; f : DT := DT#2106-02-07-06:28:15;
g : TOD := TOD#23:59:59.999; h : LTIME := LTIME#-5s; i : LTIME := LTIME#1us;`,
            opts,
          ),
        ).toEqual([]);
      });

      it("refuses a TIME that is negative, below a millisecond or too long", () => {
        expect(
          errors(
            "a : TIME := T#-5s;\nb : TIME := T#1ms500us;\nc : TIME := T#49d17h2m47s296ms;",
            opts,
          ),
        ).toEqual([
          "3:13: TIME literal 'T#-5S' is negative; a TIME holds T#0ms to T#49d17h2m47s295ms (an LTIME can be negative)",
          "4:13: TIME literal 'T#1MS500US' has a part below a millisecond, which a TIME cannot hold; use an LTIME literal (LTIME#...)",
          "5:13: TIME literal 'T#49D17H2M47S296MS' is outside the TIME range (T#0ms to T#49d17h2m47s295ms)",
        ]);
      });

      it("refuses a DATE, DT or TOD outside its range", () => {
        expect(
          errors(
            "a : DATE := D#1969-12-31;\nb : DATE := D#2106-02-08;\nc : DT := DT#2106-02-07-06:28:16;\nd : DT := DT#1969-12-31-23:59:59;\ne : TOD := TOD#24:00:00;",
            opts,
          ),
        ).toEqual([
          "3:13: DATE literal 'D#1969-12-31': a DATE before 1970-01-01 is out of range for a 32-bit DATE (D#1970-01-01 to D#2106-02-07); use LDATE",
          "4:13: DATE literal 'D#2106-02-08' is outside the DATE range (D#1970-01-01 to D#2106-02-07)",
          "5:11: DT literal 'DT#2106-02-07-06:28:16' is outside the DT range (DT#1970-01-01-00:00:00 to DT#2106-02-07-06:28:15)",
          "6:11: DT literal 'DT#1969-12-31-23:59:59': a DT before 1970-01-01 is out of range for a 32-bit DT (DT#1970-01-01-00:00:00 to DT#2106-02-07-06:28:15); use LDT",
          "7:12: TOD literal 'TOD#24:00:00' is outside the TOD range (TOD#00:00:00 to TOD#23:59:59.999)",
        ]);
      });
    });
  }

  it("keeps LDATE and LDT before 1970 (signed 64-bit)", () => {
    for (const [, opts] of MODES) {
      expect(
        errors(
          "a : LDATE := LDATE#1969-12-31; b : LDT := LDT#1900-03-01-12:00:00.5;",
          opts,
        ),
      ).toEqual([]);
    }
  });

  describe("digits below the resolution of a TOD, DT, LTOD or LDT literal", () => {
    const decls =
      "a : TOD := TOD#12:00:00.1234;\nb : DT := DT#2020-01-01-00:00:00.5;\nc : LTOD := LTOD#12:00:00.1234567891;\nd : LDT := LDT#2020-01-01-00:00:00.0000000001;\ne : TOD := TOD#12:00:00.1230; f : DT := DT#2020-01-01-00:00:00.000;";
    const diags = (
      list: "errors" | "warnings",
      opts: Partial<CompileOptions>,
    ): string[] =>
      compile(`PROGRAM P\nVAR\n${decls}\nEND_VAR\nEND_PROGRAM\n`, opts)[
        list
      ].map((e) => `${e.line}:${e.column}: ${e.message}`);
    const heads = [
      "3:12: TOD literal 'TOD#12:00:00.1234' has digits below a millisecond, the TOD resolution",
      "4:11: DT literal 'DT#2020-01-01-00:00:00.5' has digits below a second, the DT resolution",
      "5:13: LTOD literal 'LTOD#12:00:00.1234567891' has digits below a nanosecond, the LTOD resolution",
      "6:12: LDT literal 'LDT#2020-01-01-00:00:00.0000000001' has digits below a nanosecond, the LDT resolution",
    ];

    it("warns and drops them with no dialect", () => {
      expect(diags("errors", {})).toEqual([]);
      expect(diags("warnings", {})).toEqual(
        heads.map(
          (h) => `${h}; digits below the type's resolution are dropped`,
        ),
      );
    });

    for (const [label, opts] of MODES.slice(1)) {
      it(`refuses them under ${label}`, () => {
        expect(diags("errors", opts)).toEqual(
          heads.map((h) => `${h}, which it cannot hold`),
        );
      });
    }
  });

  it("refuses them in a test file too", () => {
    const src = compile("PROGRAM P\nEND_PROGRAM\n");
    expect(src.errors).toEqual([]);
    const parsed = parseTestFile(
      "TEST 'a'\nVAR t : TIME; END_VAR\nt := T#-1s;\nt := T#1us;\nEND_TEST\n",
      "t.st",
    );
    expect(parsed.errors).toEqual([]);
    expect(
      analyzeTestFile(parsed.testFile!, src.symbolTables!, src.ast).errors.map(
        (e) => `${e.line}:${e.column}: ${e.message}`,
      ),
    ).toEqual([
      "3:6: TIME literal 'T#-1S' is negative; a TIME holds T#0ms to T#49d17h2m47s295ms (an LTIME can be negative)",
      "4:6: TIME literal 'T#1US' has a part below a millisecond, which a TIME cannot hold; use an LTIME literal (LTIME#...)",
    ]);
  });
});
