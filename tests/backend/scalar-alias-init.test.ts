// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * A variable of a TYPE that aliases an elementary or enumeration type, or of
 * a subrange, is the raw C++ value type: declared without an initial value it
 * is value-initialised (`{}`), a subrange to its lower bound (`{3}`), in a
 * PROGRAM, a function block, a method and a function.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const SRC = `TYPE T : INT; END_TYPE
TYPE T2 : T; END_TYPE
TYPE TT : TIME; END_TYPE
TYPE E2 : (A, B); END_TYPE
TYPE E2A : E2; END_TYPE
TYPE SRX : INT(3..10); END_TYPE
TYPE TS : STRING; END_TYPE
FUNCTION_BLOCK FB
VAR m : T; END_VAR
METHOD M : INT
VAR ml : T2; END_VAR
  M := ml;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION F : INT
VAR fl : SRX; END_VAR
  F := fl;
END_FUNCTION
PROGRAM Main
VAR x : T; x2 : T2; t : TT; e : E2A; r : SRX; s : TS; i : INT; xi : T := 5; d : E2; END_VAR
END_PROGRAM
`;

describe("codegen: value-initialised scalar alias variables", () => {
  const r = compile(SRC, { headerFileName: "generated.hpp" });
  const lines = (code: string): string[] =>
    code.split("\n").map((l) => l.trim());

  it("compiles", () => {
    expect(r.errors).toEqual([]);
  });

  it("initialises PROGRAM and FB members", () => {
    const h = lines(r.headerCode);
    for (const decl of [
      "T X{};",
      "T2 X2{};",
      "TT T_{};",
      "SRX R{3};",
      "T M{};",
    ]) {
      expect(h).toContain(decl);
    }
  });

  it("initialises method and function locals", () => {
    const c = lines(r.cppCode);
    expect(c).toContain("T2 ML{};");
    expect(c).toContain("SRX FL{3};");
  });

  it("leaves other types as they were", () => {
    const h = lines(r.headerCode);
    expect(h).toContain("TS S;");
    expect(h).toContain("IEC_INT I;");
    expect(h).toContain("T XI;");
    expect(h).toContain("IEC_E2 D;");
  });

  it("declares an enumeration alias variable as an enumeration variable", () => {
    const h = lines(r.headerCode);
    expect(h).toContain("IEC_E2A E{};");
    expect(h).not.toContain("E2A E{};");
  });
});
