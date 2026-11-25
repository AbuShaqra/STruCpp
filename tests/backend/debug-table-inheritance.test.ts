// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Debug table gaps: an instance of a FB that EXTENDS another lists the
 * inherited members (user and library bases, retained ones included);
 * `incomplete` retain warnings are one per declaration with their places; a
 * library type whose archive records no layout says so.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";

const CFG = `
CONFIGURATION C
RESOURCE R ON PLC
TASK T1(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM P1 WITH T1 : Main;
END_RESOURCE
END_CONFIGURATION
`;

const libs = () => discoverStlibs("libs");

/** An archive as built before locals were exported. */
const withoutLocals = (archives: ReturnType<typeof discoverStlibs>) =>
  archives.map((a) => ({
    ...a,
    manifest: {
      ...a.manifest,
      functionBlocks: a.manifest.functionBlocks.map(
        ({ locals: _locals, ...rest }) => rest,
      ),
    },
  }));

describe("debug table: inherited members", () => {
  const SOURCE = `
FUNCTION_BLOCK FB_Base
VAR_INPUT bIn : BOOL; END_VAR
VAR nB : INT; END_VAR
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Der EXTENDS FB_Base
VAR nD : INT; END_VAR
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Tn EXTENDS TON
VAR nT : INT; END_VAR
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Tn2 EXTENDS FB_Tn
VAR nT2 : INT; END_VAR
END_FUNCTION_BLOCK
PROGRAM Main
VAR d : FB_Der; t2 : FB_Tn2; END_VAR
VAR RETAIN tr : FB_Tn; END_VAR
END_PROGRAM
${CFG}`;

  it("lists a user base's members before the derived block's own", () => {
    const r = compile(SOURCE, { libraries: libs() });
    expect(r.errors).toEqual([]);
    const paths = r.debugMap!.leaves.map((l) => l.path);
    expect(paths.filter((p) => p.startsWith("P1.D."))).toEqual([
      "P1.D.BIN",
      "P1.D.NB",
      "P1.D.ND",
    ]);
  });

  it("lists a library base's interface through every level", () => {
    const r = compile(SOURCE, { libraries: libs() });
    const paths = r.debugMap!.leaves.map((l) => l.path);
    expect(paths.filter((p) => p.startsWith("P1.T2."))).toEqual([
      "P1.T2.IN",
      "P1.T2.PT",
      "P1.T2.Q",
      "P1.T2.ET",
      "P1.T2.NT",
      "P1.T2.NT2",
    ]);
  });

  it("retains a RETAIN derived instance's inherited state, library internals included", () => {
    const r = compile(SOURCE, { libraries: libs() });
    const retained = (r.debugMap!.retainVars ?? []).map((v) => v.path);
    expect(retained).toEqual([
      "P1.TR.IN",
      "P1.TR.PT",
      "P1.TR.Q",
      "P1.TR.ET",
      "P1.TR.STATE",
      "P1.TR.PREV_IN",
      "P1.TR.CURRENT_TIME",
      "P1.TR.START_TIME",
      "P1.TR.NT",
    ]);
  });
});

describe("debug table: partial retain warnings", () => {
  it("are one per declaration, naming the instance paths", () => {
    const r = compile(
      `PROGRAM Main
VAR RETAIN ts : ARRAY[1..10] OF TON; one : TON; END_VAR
END_PROGRAM
${CFG.replace("PROGRAM P1 WITH T1 : Main;", "PROGRAM P1 WITH T1 : Main;\nPROGRAM P2 WITH T1 : Main;")}`,
      { libraries: withoutLocals(libs()) },
    );
    expect(r.errors).toEqual([]);
    const partial = r.warnings
      .map((w) => w.message)
      .filter((m) => m.includes("retained in part"));
    expect(partial.map((m) => m.slice(0, m.indexOf(":")))).toEqual([
      "MAIN.TS (in 2 places",
      "MAIN.ONE (in 2 places",
    ]);
    expect(partial[0]).toContain("P1.TS[*], P2.TS[*]");
    expect(partial[0]).toContain(
      "is retained in part: RETAIN on TON: this library does not export",
    );
  });
});

describe("debug table: library types without a recorded layout", () => {
  it("say what their archive lacks", () => {
    const r = compile(
      `PROGRAM Main
VAR e : ESR_DATA; st : SMC_AXIS_STATE; END_VAR
END_PROGRAM
${CFG}`,
      { libraries: libs() },
    );
    expect(r.errors).toEqual([]);
    const debug = r.warnings
      .map((w) => w.message)
      .filter((m) => m.includes("not debuggable"));
    expect(debug).toContain(
      "P1.E.DATA is not debuggable: an array field of the library type ESR_DATA: its archive records no array shape, so its elements cannot be listed.",
    );
    expect(debug).toContain(
      "P1.ST is not debuggable: library type SMC_AXIS_STATE is opaque to the debugger: its archive records no layout for it (an enumeration's values, an array's shape).",
    );
  });
});
