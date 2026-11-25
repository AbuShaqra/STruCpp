// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * AND/OR/XOR of BOOL operands, and a bit read, emit a C++ `bool`: C++ gives
 * `bool & bool` an int and a bit read a uint64_t, which NOT() rejects or
 * complements. AND/OR/XOR/NOT of integers and bit strings are unchanged.
 */
import { describe, it, expect } from "vitest";
import { analyze, compile } from "../../src/index.js";
import type { AssignmentStatement } from "../../src/frontend/ast.js";
import { parseTestFile } from "../../src/testing/test-parser.js";
import {
  generateTestMain,
  buildPOUInfoFromAST,
} from "../../src/backend/test-main-gen.js";
import { uppercaseSource } from "../../src/frontend/lexer.js";
import { analyzeTestFile } from "../../src/semantic/analyzer.js";

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

const MEMBERS_SOURCE = `TYPE ST_S : STRUCT w : WORD; v : WORD; END_STRUCT END_TYPE
FUNCTION_BLOCK FB_O
VAR_OUTPUT wOut : WORD := 16#0F0F; END_VAR
END_FUNCTION_BLOCK
PROGRAM Main
VAR
  s : ST_S; ps : POINTER TO ST_S; fb : FB_O; a : DINT := 1; w : WORD := 16#0008;
  r1, r2, r3, r4 : WORD; q : BOOL;
END_VAR
VAR CONSTANT C_BIT : INT := 3; END_VAR
s.w := 16#00FF;
s.v := 16#0F0F;
ps := ADR(s);
r1 := s.w AND s.v;
r2 := fb.wOut OR 16#F0;
r3 := GVL.wx XOR GVL.wy;
r4 := ps^.w OR ps^.v;
q := NOT (w.C_BIT AND (a > 0));
END_PROGRAM
`;

const MEMBERS_OPTIONS = {
  fileName: "main.st",
  additionalSources: [
    {
      source:
        "VAR_GLOBAL wx : WORD := 16#00FF; wy : WORD := 16#0F0F; END_VAR\n",
      fileName: "GVL.st",
    },
  ],
  features: ["+named_global_lists"],
};

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

  it("a bit read through a pointer is a bool in AND/OR/XOR", () => {
    const cpp = body(
      "p : POINTER TO WORD; a : DINT; q : BOOL;",
      "q := NOT (p^.3 XOR (a > 0));\nq := NOT (p^.3 AND (a > 0));",
    );
    expect(cpp).toMatch(
      /Q = NOT\(static_cast<bool>\(\(static_cast<bool>\(.*>> 3\) & 1\)\) \^ \(\(A > 0\)\)\)\);/,
    );
    expect(cpp).toMatch(
      /Q = NOT\(static_cast<bool>\(\(static_cast<bool>\(.*>> 3\) & 1\)\) & \(\(A > 0\)\)\)\);/,
    );
  });

  it("a bit read shifted or rotated is a BOOL operand", () => {
    const cpp = body(VARS, "rw := SHL(w.3, 2);\nrw := ROL(w.3, 1);");
    expect(cpp).toContain(
      "RW = SHL(static_cast<bool>((static_cast<uint64_t>(W) >> 3) & 1), 2);",
    );
    expect(cpp).toContain(
      "RW = ROL(static_cast<bool>((static_cast<uint64_t>(W) >> 3) & 1), 1);",
    );
  });

  it("WORD members, FB outputs and list globals stay bitwise; a named bit is a bool", () => {
    const result = compile(MEMBERS_SOURCE, MEMBERS_OPTIONS);
    expect(result.errors).toEqual([]);
    const cpp = result.cppCode!;
    expect(cpp).toContain("R1 = (S.W) & (S.V);");
    expect(cpp).toContain("R2 = (FB.WOUT) | (0xF0);");
    expect(cpp).toContain("R3 = (WX) ^ (WY);");
    expect(cpp).toMatch(/R4 = \(.*\.W\) \| \(.*\.V\);/);
    expect(cpp).not.toMatch(/R[1-4] = static_cast<bool>/);
    expect(cpp).toContain(
      "Q = NOT(static_cast<bool>((static_cast<bool>((static_cast<uint64_t>(W) >> static_cast<uint64_t>(C_BIT)) & 1)) & ((A > 0))));",
    );
  });

  it("integer and bit string AND/OR/XOR stay bitwise; NOT is the complement in the type", () => {
    const cpp = body(
      VARS,
      "rw := NOT (w1 AND w2);\nrw := w1 OR w2;\nrw := w1 XOR 16#00FF;\nd := d AND 7;",
    );
    expect(cpp).toContain("RW = static_cast<WORD_t>(~static_cast<WORD_t>((W1) & (W2)));");
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

describe("BOOL logic in a test file", () => {
  it("casts AND/OR of a bit read of a test VAR and a comparison to bool", () => {
    const result = compile(
      "TYPE ST_M : STRUCT w : WORD; END_STRUCT END_TYPE\nPROGRAM P\nVAR x : INT; END_VAR\nEND_PROGRAM\n",
      { headerFileName: "generated.hpp" },
    );
    expect(result.success).toBe(true);
    const parsed = parseTestFile(
      uppercaseSource(
        "TEST 't'\nVAR w : WORD; m : ST_M; x : INT; END_VAR\n" +
          "ASSERT_TRUE(NOT (w.2 AND (x > 0)));\n" +
          "ASSERT_TRUE(NOT (m.w.2 AND (x > 0)));\n" +
          "ASSERT_FALSE(NOT (w.3 OR (x > 5)));\nEND_TEST\n",
      ),
      "t.st",
    );
    expect(parsed.errors).toEqual([]);
    expect(
      analyzeTestFile(parsed.testFile!, result.symbolTables!).errors,
    ).toEqual([]);
    const main = generateTestMain([parsed.testFile!], {
      headerFileName: "generated.hpp",
      pous: buildPOUInfoFromAST(result.ast!).pous,
      isTestBuild: false,
      ast: result.ast,
      libraryArchives: result.resolvedLibraries,
    });
    for (const line of [
      "NOT(static_cast<bool>((static_cast<bool>((static_cast<uint64_t>(W) >> 2) & 1)) & ((X > 0))))",
      "NOT(static_cast<bool>((static_cast<bool>((static_cast<uint64_t>(M.W) >> 2) & 1)) & ((X > 0))))",
      "NOT(static_cast<bool>((static_cast<bool>((static_cast<uint64_t>(W) >> 3) & 1)) | ((X > 5))))",
    ]) {
      expect(main).toContain(line);
    }
  });
});
