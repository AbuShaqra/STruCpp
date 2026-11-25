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
      "is retained in part: RETAIN on TON: the archive of library iec-standard-fb lists no internal variables of the block",
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

describe("debug table: a member a derived block declares again", () => {
  const SOURCE = `
FUNCTION_BLOCK FB_A
VAR_INPUT x : INT; END_VAR
VAR y : INT; END_VAR
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_B EXTENDS FB_A
VAR y : DINT; z : INT; END_VAR
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_T EXTENDS TON
VAR ET : TIME; END_VAR
END_FUNCTION_BLOCK
PROGRAM Main
VAR RETAIN b : FB_B; t : FB_T; END_VAR
END_PROGRAM
${CFG}`;

  it("lists the hidden base member once, qualified, and the derived one once", () => {
    const r = compile(SOURCE, { libraries: libs() });
    expect(r.errors).toEqual([]);
    const leaves = r.debugMap!.leaves.map((l) => `${l.path} ${l.type}`);
    expect(leaves.filter((l) => l.startsWith("P1.B."))).toEqual([
      "P1.B.X INT",
      "P1.B.FB_A::Y INT",
      "P1.B.Y DINT",
      "P1.B.Z INT",
    ]);
    expect(leaves.filter((l) => /^P1\.T\.(TON::)?ET /.test(l))).toEqual([
      "P1.T.TON::ET TIME",
      "P1.T.ET TIME",
    ]);
    expect(r.debugTableCpp).toContain(".B.FB_A::Y");
    // Both are retained, each once
    const retained = (r.debugMap!.retainVars ?? []).map((v) => v.path);
    expect(new Set(retained).size).toBe(retained.length);
    expect(retained).toEqual(
      expect.arrayContaining(["P1.B.FB_A::Y", "P1.B.Y", "P1.T.TON::ET", "P1.T.ET"]),
    );
  });

  it("is a warning by default and an error under iec-3 and --strict", () => {
    const messages = [
      "'y' of FUNCTION_BLOCK 'FB_B' redeclares the variable 'y' it inherits from 'FB_A', which it hides; rename one of them",
      "'ET' of FUNCTION_BLOCK 'FB_T' redeclares the variable 'ET' it inherits from 'TON', which it hides; rename one of them",
    ];
    const def = compile(SOURCE, { libraries: libs() });
    expect(def.errors).toEqual([]);
    expect(
      def.warnings.map((w) => w.message).filter((m) => m.includes("redeclares")),
    ).toEqual(messages);
    for (const opts of [{ strict: true }, { dialect: "iec-3" }]) {
      const r = compile(SOURCE, { libraries: libs(), ...opts });
      expect(
        r.errors.map((e) => e.message).filter((m) => m.includes("redeclares")),
      ).toEqual(messages);
    }
  });
});

describe("debug table: RETAIN of library blocks without internal variables", () => {
  it("says nothing when the archive records that the block has none", () => {
    const r = compile(
      `FUNCTION_BLOCK FB_Sr EXTENDS SR
VAR x : INT; END_VAR
END_FUNCTION_BLOCK
PROGRAM Main
VAR RETAIN a : FB_Sr; b : SR; c : ARRAY[0..2] OF FB_Sr; END_VAR
END_PROGRAM
${CFG}`,
      { libraries: libs() },
    );
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((w) => w.message).join("\n")).not.toMatch(
      /retained in part/,
    );
  });
});

describe("debug table: file-level VAR_GLOBAL (GVL)", () => {
  it("lists its globals, RETAIN ones retained", () => {
    const r = compile(
      `VAR_GLOBAL RETAIN
  gi : INT;
  gt : TON;
END_VAR
VAR_GLOBAL
  gp : BOOL;
END_VAR
PROGRAM Main
VAR_EXTERNAL gi : INT; END_VAR
gi := gi + 1;
END_PROGRAM
${CFG}`,
      { libraries: libs() },
    );
    expect(r.errors).toEqual([]);
    expect(r.debugMap!.leaves.map((l) => l.path)).toEqual(
      expect.arrayContaining(["GI", "GT.ET", "GT.START_TIME", "GP"]),
    );
    const retained = (r.debugMap!.retainVars ?? []).map((v) => v.path);
    expect(retained).toContain("GI");
    expect(retained).toContain("GT.START_TIME");
    expect(retained).not.toContain("GP");
    expect(r.debugTableCpp).toContain("GT_");
  });
});

describe("debug table: file-level globals it cannot list", () => {
  it("are warned about only when RETAIN", () => {
    const r = compile(
      `VAR_GLOBAL
  gp : POINTER TO INT;
  gs : STRING(10);
END_VAR
VAR_GLOBAL RETAIN
  rp : POINTER TO INT;
END_VAR
PROGRAM Main
VAR x : INT; END_VAR
x := 1;
END_PROGRAM
${CFG}`,
      { libraries: libs() },
    );
    expect(r.errors).toEqual([]);
    expect(
      r.warnings.map((w) => w.message).filter((m) => m.includes("not debuggable")),
    ).toEqual([
      "RP is not debuggable: a POINTER TO holds an address, which the debugger cannot show or write.",
    ]);
  });
});
