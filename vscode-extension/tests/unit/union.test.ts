// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * A UNION (`TYPE U_A : UNION ... END_UNION`, feature union) in the language
 * server: the outline marks it UNION and lists its members, and hover shows
 * the UNION with its members.
 */
import { describe, it, expect } from "vitest";
import { analyze } from "strucpp";
import type { AnalysisResult } from "strucpp";
import { getDocumentSymbols } from "../../server/src/symbols.js";
import { getHover } from "../../server/src/hover.js";

const SOURCE = `TYPE
  U_A : UNION
    f : REAL;
    d : DWORD;
  END_UNION;
END_TYPE
PROGRAM P
VAR u : U_A; END_VAR
u.f := 1.5;
END_PROGRAM
`;

function analysis(): AnalysisResult {
  const result = analyze(SOURCE, { fileName: "m.st", features: ["+union"] });
  expect(result.errors).toEqual([]);
  return result;
}

describe("a UNION in the language server", () => {
  it("outlines it as a UNION with its members", () => {
    const symbol = getDocumentSymbols(analysis()).find((s) => s.name === "U_A");
    expect(symbol?.detail).toBe("UNION");
    expect(symbol?.children?.map((c) => c.name.toUpperCase())).toEqual([
      "F",
      "D",
    ]);
  });

  it("shows UNION ... END_UNION on hover over a variable of the type", () => {
    const text = JSON.stringify(getHover(analysis(), "m.st", 9, 1)?.contents);
    expect(text).toContain("UNION");
    expect(text).toContain("END_UNION");
    expect(text).toContain("F : REAL");
    expect(text).not.toContain("END_STRUCT");
  });
});
