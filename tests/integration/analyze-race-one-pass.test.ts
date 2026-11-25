// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * analyze() gives the shared-global race warnings code generation finds by
 * generating code on its own analysed tree, not by compiling the source a
 * second time: the warnings are the build's, and the tree it returns keeps
 * the ST names (no POU renamed like a runtime function).
 */
import { describe, it, expect, vi } from "vitest";
import { analyze, compile } from "../../src/index.js";

const parses = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../src/frontend/parser.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/frontend/parser.js")>();
  return {
    ...original,
    parse: (source: string) => {
      parses.count++;
      return original.parse(source);
    },
  };
});

const SOURCE = `FUNCTION_BLOCK Sub
VAR_OUTPUT q : INT; END_VAR
END_FUNCTION_BLOCK
FUNCTION Bump : INT
VAR_IN_OUT x : INT; END_VAR
x := x + 1; Bump := x;
END_FUNCTION
PROGRAM P1
VAR_EXTERNAL g : INT; END_VAR
VAR r : INT; s : Sub; END_VAR
r := Bump(x := g);
s();
END_PROGRAM
PROGRAM P2
VAR_EXTERNAL g : INT; END_VAR
g := g + 1;
END_PROGRAM
CONFIGURATION C
VAR_GLOBAL g : INT; END_VAR
RESOURCE R ON PLC
TASK T1(INTERVAL := T#10ms, PRIORITY := 1);
TASK T2(INTERVAL := T#20ms, PRIORITY := 2);
PROGRAM I1 WITH T1 : P1;
PROGRAM I2 WITH T2 : P2;
END_RESOURCE
END_CONFIGURATION
`;

const race = (r: { warnings: { line: number; message: string }[] }) =>
  r.warnings
    .filter((w) => w.message.includes("the shared global"))
    .map((w) => `${w.line}: ${w.message}`);

describe("analyze() and the shared-global race warning", () => {
  it("gives the warnings compile gives", () => {
    const analysed = analyze(SOURCE);
    expect(analysed.errors).toEqual([]);
    expect(race(analysed)).toHaveLength(1);
    expect(race(analysed)).toEqual(race(compile(SOURCE)));
  });

  it("parses the source once", () => {
    parses.count = 0;
    analyze(SOURCE);
    expect(parses.count).toBe(1);
  });

  it("returns its tree with the names as declared", () => {
    const analysed = analyze(SOURCE);
    expect(analysed.ast!.functionBlocks.map((f) => f.name)).toEqual(["SUB"]);
    // compile() renames the block colliding with the runtime's SUB
    expect(compile(SOURCE).headerCode).toMatch(/class SUB_\b/);
  });
});
