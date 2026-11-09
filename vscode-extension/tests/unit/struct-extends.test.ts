// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * A derived STRUCT (`TYPE ST_B EXTENDS ST_A : STRUCT`, feature struct_extends)
 * in the language server: the outline lists its own fields, hover lists every
 * field, and an AST walk visits a base field once, not again in its copy.
 */
import { describe, it, expect } from "vitest";
import { analyze, walkAST } from "strucpp";
import type { AnalysisResult, VarDeclaration } from "strucpp";
import { getDocumentSymbols } from "../../server/src/symbols.js";
import { getHover } from "../../server/src/hover.js";

const SOURCE = `TYPE
  ST_A : STRUCT
    a1 : INT;
  END_STRUCT;
  ST_B EXTENDS ST_A : STRUCT b1 : INT; END_STRUCT;
END_TYPE
PROGRAM P
VAR b : ST_B; END_VAR
b.b1 := 3;
END_PROGRAM
`;
const URI = "file:///m.st";

function analysis(): AnalysisResult {
  const result = analyze(SOURCE, {
    fileName: "m.st",
    features: ["+struct_extends"],
  });
  expect(result.errors).toEqual([]);
  return result;
}

describe("a derived STRUCT in the language server", () => {
  it("outlines only the fields the STRUCT declares", () => {
    const symbols = getDocumentSymbols(analysis());
    const stA = symbols.find((s) => s.name === "ST_A");
    const stB = symbols.find((s) => s.name === "ST_B");
    expect(stA?.children?.map((c) => c.name.toUpperCase())).toEqual(["A1"]);
    expect(stB?.children?.map((c) => c.name.toUpperCase())).toEqual(["B1"]);
  });

  it("lists inherited and own fields on hover", () => {
    const hover = getHover(analysis(), "m.st", 9, 1);
    const text = JSON.stringify(hover?.contents);
    expect(text).toContain("A1 : INT");
    expect(text).toContain("B1 : INT");
  });

  it("walks the base field declaration once (the inherited copy is skipped)", () => {
    const result = analysis();
    let count = 0;
    walkAST(result.ast!, (node) => {
      if (
        node.kind === "VarDeclaration" &&
        (node as VarDeclaration).names.includes("A1")
      ) {
        count++;
      }
    });
    expect(count).toBe(1);
  });
});
