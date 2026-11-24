// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Integer overflow lowering: an untyped constant expression past DINT is its
 * exact value, an integer `**` stored as an integer is an exact integer power,
 * and LTIME `/` an LTIME or an integer faults on a zero divisor.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

function compileOk(
  source: string,
  options: Record<string, unknown> = {},
): { cpp: string; header: string; warnings: string[] } {
  const result = compile(source, options);
  expect(result.errors.map((e) => e.message)).toEqual([]);
  return {
    cpp: result.cppCode,
    header: result.headerCode,
    warnings: result.warnings.map((w) => w.message),
  };
}

const program = (vars: string, body = ""): string =>
  `PROGRAM Main\nVAR\n${vars}\nEND_VAR\n${body}\nEND_PROGRAM\n`;

describe("untyped constant expressions past DINT", () => {
  it("folds an initial value to its exact value", () => {
    const { cpp } = compileOk(
      program(
        "l : LINT := 2147483647 + 1; u : UDINT := 4294967295 + 1; d : LINT := (2147483647 + 1) / 2 * 3;",
      ),
    );
    expect(cpp).toContain("L(2147483648)");
    expect(cpp).toContain("U(4294967296)");
    expect(cpp).toContain("D(3221225472)");
  });

  it("folds an assignment and a STRUCT element default", () => {
    const { cpp, header } = compileOk(
      `TYPE S : STRUCT a : DINT := 2147483647 + 1; b : LINT := -(2147483647 + 2); END_STRUCT END_TYPE
${program("s : S; l : LINT;", "l := 2147483647 * 4;")}`,
    );
    expect(cpp).toContain("L = 8589934588;");
    expect(header).toContain("IEC_DINT A = 2147483648;");
    expect(header).toContain("IEC_LINT B = (-2147483649);");
  });

  it("keeps a constant expression inside DINT as before", () => {
    const { cpp } = compileOk(program("d : DINT := 2147483646 + 1;"));
    expect(cpp).toContain("strucpp::iec_add<DINT_t>({2147483646, 1})");
  });

  it("wraps a value past 64 bits to 64 bits", () => {
    const { cpp } = compileOk(program("l : LINT := 9223372036854775807 * 4;"));
    expect(cpp).toContain("L((-4))");
  });

  for (const [label, options] of [
    ["no dialect", {}],
    ["iec-3", { dialect: "iec-3" }],
    ["strict", { strict: true }],
  ] as const) {
    it(`accepts an untyped integer constant expression into UDINT as a literal (${label})`, () => {
      const literal = compileOk(program("u : UDINT := 4294967296;"), options);
      const expr = compileOk(
        program("u : UDINT := 4294967295 + 1; v : UDINT := 1 + 1;"),
        options,
      );
      expect(expr.warnings).toEqual(literal.warnings);
    });
  }

  it("keeps the narrowing warning for an integer constant expression into BOOL", () => {
    const { warnings } = compileOk(program("b : BOOL := 1 + 1;"));
    expect(warnings).toContain(
      "Implicit narrowing conversion from INT to BOOL",
    );
  });
});

describe("integer ** stored as an integer", () => {
  it("is an exact integer power", () => {
    const { cpp } = compileOk(
      program(
        "l : LINT; i : INT := 3; n : INT; m : DINT;",
        "l := LINT#2 ** 63; n := i ** 3; m := (i ** 2) + 1;",
      ),
    );
    expect(cpp).toContain(
      "strucpp::iec_expt<LINT_t>(static_cast<IEC_LINT>(2), 63)",
    );
    expect(cpp).toContain("strucpp::iec_expt<DINT_t>(I, 3)");
    expect(cpp).toContain("strucpp::iec_expt<DINT_t>(I, 2)");
  });

  it("keeps pow for a REAL target, a negative constant exponent or a REAL operand", () => {
    const { cpp } = compileOk(
      program(
        "i : DINT := 2; r : REAL; d : DINT; x : REAL := 2.0;",
        "r := i ** 2; d := i ** -1; r := x ** i;",
      ),
    );
    expect(cpp).not.toContain("iec_expt");
    expect(cpp).toContain(
      "std::pow(static_cast<double>(I), static_cast<double>(-1))",
    );
  });
});

describe("LTIME division", () => {
  it("faults on a zero LTIME or integer divisor", () => {
    const { cpp } = compileOk(
      program(
        "a : LTIME := LTIME#5s; z : LTIME; n : DINT; q : LTIME;",
        "q := a / z;\nq := a / n;\nq := a / 2;",
      ),
    );
    expect(cpp).toContain('iec_div(A, Z, strucpp::iec_site{"MAIN", 5})');
    expect(cpp).toContain('iec_div(A, N, strucpp::iec_site{"MAIN", 6})');
    expect(cpp).toContain("Q = A / 2;");
  });
});
