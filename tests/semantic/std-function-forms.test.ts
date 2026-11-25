// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Checks of standard-function, date/time and test-file forms (S15 batch D):
 * what builds by default, what iec-3 and --strict refuse, and the refusals
 * that replace a late g++ failure.
 */
import { describe, it, expect } from "vitest";
import { compile, type CompileOptions } from "../../src/index.js";
import { parseTestFile } from "../../src/testing/test-parser.js";
import { analyzeTestFile } from "../../src/semantic/analyzer.js";

const MODES: Array<[string, Partial<CompileOptions>]> = [
  ["default", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["--strict", { strict: true }],
];

function diags(
  source: string,
  options: Partial<CompileOptions> = {},
): { errors: string[]; warnings: string[] } {
  const r = compile(source, { headerFileName: "generated.hpp", ...options });
  const fmt = (e: {
    line?: number;
    column?: number;
    message: string;
  }): string => `${e.line}:${e.column}: ${e.message}`;
  return { errors: r.errors.map(fmt), warnings: r.warnings.map(fmt) };
}

function body(decls: string, stmts: string): string {
  return `PROGRAM P\nVAR ${decls} END_VAR\n${stmts}\nEND_PROGRAM\n`;
}

describe("functional AND/OR/XOR on a signed integer", () => {
  const src = body(
    "i : INT := -6; d : DINT; r : INT; w : WORD; rw : WORD;",
    "r := AND(i, 3);\nd := OR(d, 16#10);\nr := XOR(i, i);\nrw := AND(w, 3);",
  );
  it("builds by default, as the infix forms do", () => {
    expect(diags(src).errors).toEqual([]);
  });
  it("is refused under iec-3 and --strict (Table 31)", () => {
    for (const [, options] of MODES.slice(1)) {
      expect(diags(src, options).errors).toEqual([
        "3:10: AND takes bit strings or BOOL (ANY_BIT, IEC 61131-3 Table 31), not INT; convert it with INT_TO_WORD or the like",
        "4:9: OR takes bit strings or BOOL (ANY_BIT, IEC 61131-3 Table 31), not DINT; convert it with DINT_TO_WORD or the like",
        "5:10: XOR takes bit strings or BOOL (ANY_BIT, IEC 61131-3 Table 31), not INT; convert it with INT_TO_WORD or the like",
      ]);
    }
  });
});

describe("EXPT of a bit string", () => {
  it("is refused in every mode with the reason and the conversion", () => {
    const src = body("w : WORD := 3; r : REAL;", "r := EXPT(w + 1, 2);");
    for (const [, options] of MODES) {
      expect(diags(src, options).errors).toContain(
        "3:11: Argument 'IN1' of 'EXPT' expects ANY_REAL, got WORD; a bit string is not a number (the base of EXPT is ANY_REAL, IEC 61131-3 Table 29 note f): convert it with WORD_TO_REAL or WORD_TO_LREAL",
      );
    }
  });
});

describe("SEL and MUX nested in a generic call", () => {
  it("type the call from the selected inputs", () => {
    const r = compile(
      body(
        "b : BOOL; i : INT; j : INT; r : INT;",
        "r := MAX(SEL(b, i, j), 3);\nr := MOD(SEL(b, i, j), 2);\nr := MOD(MUX(1, i, j), 2);",
      ),
      { headerFileName: "generated.hpp" },
    );
    expect(r.errors).toEqual([]);
    expect(r.cppCode).not.toContain("IEC_ANY");
    expect(r.cppCode).toContain("static_cast<IEC_INT>(2)");
  });
  it("leaves SEL of constants only to its use (no --strict refusal)", () => {
    expect(
      diags(body("b : BOOL; u : UDINT;", "u := SEL(b, 1, 2);"), {
        strict: true,
      }).errors,
    ).toEqual([]);
  });
});

describe("an enumeration where a standard function takes a number", () => {
  it("is refused in every mode (MUX's selector, ABS)", () => {
    const src =
      "TYPE E : (A, B, C); END_TYPE\n" +
      body(
        "e1 : E; r : INT;",
        "r := MUX(e1, 10, 20, 30);\nr := ABS(TO_INT(e1));\nr := MUX(TO_INT(e1), 1, 2, 3);",
      );
    for (const [, options] of MODES) {
      expect(diags(src, options).errors).toEqual([
        "4:10: Argument 'K' of 'MUX' expects INT, got E; an enumeration is not an integer: convert it with TO_INT or the like",
      ]);
    }
  });
});

describe("date and time forms", () => {
  it("types a number + an L form as the L form; refused under iec-3 and --strict", () => {
    const src = body(
      "ldt : LDT; r : LDT; lt : LTIME; q : LTIME;",
      "r := 1 + ldt;\nq := 2 + lt;",
    );
    expect(diags(src).errors).toEqual([]);
    for (const [, options] of MODES.slice(1)) {
      expect(diags(src, options).errors.length).toBe(2);
      expect(diags(src, options).errors[0]).toContain(
        "Operator '+' does not apply to INT and LDT",
      );
    }
  });
  it("accepts MUL and DIV of a TIME or LTIME by a number (Table 35) in every mode", () => {
    const src = body(
      "t : TIME; lt : LTIME; n : INT; r : REAL;",
      "t := DIV(t, 2);\nt := MUL(IN1 := t, IN2 := r);\nlt := DIV(lt, n);\nlt := MUL(lt, 3);",
    );
    for (const [, options] of MODES) {
      expect(diags(src, options).errors).toEqual([]);
    }
  });
  it("still refuses DIV of a TIME by a TIME through the function", () => {
    expect(diags(body("t : TIME;", "t := DIV(t, t);")).errors).toEqual([
      "3:10: Argument 'IN1' of 'DIV' expects ANY_NUM, got TIME",
      "3:13: Argument 'IN2' of 'DIV' expects ANY_NUM, got TIME",
    ]);
  });
});

describe("integer powers", () => {
  it("computes a negative constant exponent and a bit-string target exactly", () => {
    const r = compile(
      body(
        "i : INT; j : DINT; w : WORD; lw : LWORD;",
        "j := i ** -1;\nw := i ** 3;\nlw := INT#3 ** 39;",
      ),
      { headerFileName: "generated.hpp" },
    );
    expect(r.errors).toEqual([]);
    expect(r.cppCode).toContain("strucpp::iec_expt<DINT_t>(I, -1)");
    expect(r.cppCode).toContain("W = strucpp::iec_expt<DINT_t>(I, 3)");
    expect(r.cppCode).toContain("strucpp::iec_expt<LWORD_t>(");
    expect(r.cppCode).not.toContain("std::pow");
  });
  it("adapts an untyped constant power to its target under --strict, as 1 + 1", () => {
    expect(
      diags(body("u : UDINT;", "u := 2 ** 3;\nu := 1 + 1;"), { strict: true })
        .errors,
    ).toEqual([]);
  });
});

describe("a VAR_EXTERNAL STRING of another length than its global", () => {
  it("is refused (the pointer is to the global's own type)", () => {
    const src = `
CONFIGURATION C
VAR_GLOBAL g5 : STRING(5); g : STRING; END_VAR
RESOURCE R ON PLC
TASK t(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM p WITH t : Main;
END_RESOURCE
END_CONFIGURATION
PROGRAM Main
VAR_EXTERNAL g5 : STRING; g : STRING(254); END_VAR
END_PROGRAM
`;
    expect(diags(src).errors).toEqual([
      "10:14: Type mismatch for VAR_EXTERNAL 'G5' in program 'MAIN': expected 'STRING(5)' but found 'STRING'",
    ]);
  });
});

function testFileDiags(
  testST: string,
  options: Partial<CompileOptions> = {},
): { errors: string[]; warnings: string[] } {
  const src = compile("PROGRAM P\nEND_PROGRAM\n", options);
  const parsed = parseTestFile(
    testST,
    "t.st",
    options.dialect !== undefined ? { dialect: options.dialect } : undefined,
  );
  expect(parsed.errors).toEqual([]);
  const r = analyzeTestFile(parsed.testFile!, src.symbolTables!, src.ast);
  const fmt = (e: {
    line?: number;
    column?: number;
    message: string;
  }): string => `${e.line}:${e.column}: ${e.message}`;
  return { errors: r.errors.map(fmt), warnings: r.warnings.map(fmt) };
}

describe("ADVANCE_TIME operand", () => {
  const TEST = `TEST 'a'
VAR b : BOOL; t : TIME; n : DINT; r : REAL; s : STRING; END_VAR
ADVANCE_TIME(TRUE);
ADVANCE_TIME(t);
ADVANCE_TIME(LTIME#1ms);
ADVANCE_TIME(100);
ADVANCE_TIME(n);
ADVANCE_TIME(r);
ADVANCE_TIME(s);
END_TEST
`;
  const msg = (at: string, type: string): string =>
    `${at}: ADVANCE_TIME takes a TIME, an LTIME or a number of nanoseconds (an integer), not ${type}`;
  it("warns on a BOOL or REAL (built as ns) and refuses a STRING by default", () => {
    const d = testFileDiags(TEST);
    expect(d.errors).toEqual([msg("9:14", "STRING")]);
    expect(d.warnings).toEqual([msg("3:14", "BOOL"), msg("8:14", "REAL")]);
  });
  it("refuses all three under iec-3", () => {
    const d = testFileDiags(TEST, { dialect: "iec-3" });
    expect(d.errors).toEqual([
      msg("3:14", "BOOL"),
      msg("8:14", "REAL"),
      msg("9:14", "STRING"),
    ]);
  });
});

describe("a list-qualified global in a test file", () => {
  it("reports an unknown member once, and a test variable hiding the global", () => {
    const options: Partial<CompileOptions> = {
      features: ["+named_global_lists"],
      additionalSources: [
        { source: "VAR_GLOBAL x : INT; END_VAR\n", fileName: "GVL.st" },
      ],
    };
    const src = compile("PROGRAM P\nEND_PROGRAM\n", options);
    expect(src.errors).toEqual([]);
    const parsed = parseTestFile(
      "TEST 'a'\nVAR v : INT := GVL.x; x : INT; END_VAR\nv := GVL.y;\nv := GVL.x;\nEND_TEST\n",
      "t.st",
      { features: ["+named_global_lists"] },
    );
    expect(parsed.errors).toEqual([]);
    const r = analyzeTestFile(parsed.testFile!, src.symbolTables!, src.ast);
    expect(r.errors.map((e) => `${e.line}:${e.column}: ${e.message}`)).toEqual([
      "2:16: 'GVL.X' is hidden by a test variable named X; rename it",
      "3:6: 'Y' is not a variable of global variable list 'GVL'",
      "4:6: 'GVL.X' is hidden by a test variable named X; rename it",
    ]);
  });
});
