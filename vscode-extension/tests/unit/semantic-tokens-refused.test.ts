// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
import { describe, it, expect } from "vitest";
import { analyze } from "strucpp";
import { getSemanticTokens } from "../../server/src/semantic-tokens.js";
import { toLspDiagnostics } from "../../server/src/diagnostics.js";

const A = String.fromCodePoint(0xe4);
const E = String.fromCodePoint(0x1f600);
const SRC = `PROGRAM P\nVAR\n  x${A}a : INT;\n  qq : INT;\nEND_VAR\nqq := x${A}a + ${E}qq;\nEND_PROGRAM\n`;

/** Absolute [line, col, length] of each token. */
function decode(data: number[]): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  let line = 0;
  let col = 0;
  for (let i = 0; i < data.length; i += 5) {
    line += data[i]!;
    col = data[i] === 0 ? col + data[i + 1]! : data[i + 1]!;
    out.push([line, col, data[i + 2]!]);
  }
  return out;
}

describe("names holding refused characters", () => {
  it("gives a semantic token the name's source length", () => {
    const tokens = decode(
      getSemanticTokens(analyze(SRC, { fileName: "main.st" }), "main.st", SRC),
    );
    expect(tokens).toContainEqual([2, 2, 3]);
    expect(tokens).toContainEqual([5, 6, 3]);
  });

  it("gives a refusal's diagnostic range the whole character", () => {
    const r = analyze(SRC, { fileName: "main.st" });
    const emoji = toLspDiagnostics(r.errors, r.warnings, "main.st").find((d) =>
      d.message.includes("U+1F600"),
    );
    expect(emoji?.range).toEqual({
      start: { line: 5, character: 12 },
      end: { line: 5, character: 14 },
    });
  });
});
