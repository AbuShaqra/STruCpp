// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * AND/OR/XOR of BOOL operands, and a bit read, emit a C++ `bool`: C++ gives
 * `bool & bool` an int and a bit read a uint64_t, which NOT() rejects or
 * complements. AND/OR/XOR/NOT of integers and bit strings are unchanged.
 */
import { describe, it, expect } from "vitest";
import { analyze, compile } from "../../src/index.js";
import type { AssignmentStatement } from "../../src/frontend/ast.js";

function body(decls: string, stmts: string): string {
  const result = compile(
    `PROGRAM P\nVAR ${decls} END_VAR\n${stmts}\nEND_PROGRAM\n`,
  );
  expect(result.errors).toEqual([]);
  expect(result.success).toBe(true);
  return result.cppCode!;
}

const VARS =
  "a, b : DINT; r : REAL; x, y, q : BOOL; w, w1, w2, rw : WORD; d : DINT;";

describe("BOOL logic codegen", () => {
  it("NOT over AND of two comparisons takes a bool", () => {
    const cpp = body(VARS, "q := NOT ((a >= DINT#6) AND (b >= DINT#6));");
    expect(cpp).toContain(
      "Q = NOT(static_cast<bool>(((A >= static_cast<IEC_DINT>(6))) & ((B >= static_cast<IEC_DINT>(6)))));",
    );
  });

  it("OR and XOR of comparisons are cast to bool", () => {
    const cpp = body(
      VARS,
      "q := (a > b) OR (r < 1.0);\nq := (a > b) XOR (r < 1.0);",
    );
    expect(cpp).toContain("Q = static_cast<bool>(((A > B)) | ((R < 1.0)));");
    expect(cpp).toContain("Q = static_cast<bool>(((A > B)) ^ ((R < 1.0)));");
  });

  it("nested BOOL logic is cast at each level", () => {
    const cpp = body(VARS, "q := NOT (((a > 0) AND x) OR NOT (b > 0));");
    expect(cpp).toContain(
      "Q = NOT(static_cast<bool>(((static_cast<bool>(((A > 0)) & (X)))) | (NOT(B > 0))));",
    );
  });

  it("an IF condition of AND of comparisons is a bool", () => {
    const cpp = body(
      VARS,
      "IF NOT ((a > 0) AND (b > 0)) THEN q := TRUE; END_IF;",
    );
    expect(cpp).toContain(
      "if (NOT(static_cast<bool>(((A > 0)) & ((B > 0))))) {",
    );
  });

  it("a bit read is a bool", () => {
    const cpp = body(VARS, "q := NOT (w.3);\nq := NOT (w.3 AND (a > 1));");
    expect(cpp).toContain(
      "Q = NOT(static_cast<bool>((static_cast<uint64_t>(W) >> 3) & 1));",
    );
    expect(cpp).toContain(
      "Q = NOT(static_cast<bool>((static_cast<bool>((static_cast<uint64_t>(W) >> 3) & 1)) & ((A > 1))));",
    );
  });

  it("integer and bit string AND/OR/XOR/NOT are unchanged", () => {
    const cpp = body(
      VARS,
      "rw := NOT (w1 AND w2);\nrw := w1 OR w2;\nrw := w1 XOR 16#00FF;\nd := d AND 7;",
    );
    expect(cpp).toContain("RW = NOT((W1) & (W2));");
    expect(cpp).toContain("RW = (W1) | (W2);");
    expect(cpp).toContain("RW = (W1) ^ (0x00FF);");
    expect(cpp).toContain("D = (D) & (7);");
    expect(cpp).not.toMatch(/RW = static_cast<bool>|D = static_cast<bool>/);
  });

  it("a BOOL initializer of AND of comparisons is a bool", () => {
    const result = compile(`
      TYPE ST_Cfg : STRUCT
        ok : BOOL := NOT ((3 > 1) AND (2 > 1));
      END_STRUCT END_TYPE
      PROGRAM P VAR c : ST_Cfg; END_VAR END_PROGRAM
    `);
    expect(result.errors).toEqual([]);
    expect(result.headerCode! + result.cppCode!).toContain(
      "static_cast<bool>(((3 > 1)) & ((2 > 1)))",
    );
  });
});

describe("BOOL logic typing", () => {
  it("types AND of two comparisons as BOOL (Table 68)", () => {
    const result = analyze(
      "PROGRAM P\nVAR a, b : DINT; q : BOOL; END_VAR\nq := (a >= 6) AND (b >= 6);\nEND_PROGRAM\n",
    );
    expect(result.errors).toEqual([]);
    const stmt = result.ast!.programs[0]!.body[0] as AssignmentStatement;
    const type = stmt.value.resolvedType;
    expect(type?.typeKind).toBe("elementary");
    expect(type && "name" in type ? type.name : undefined).toBe("BOOL");
  });
});
