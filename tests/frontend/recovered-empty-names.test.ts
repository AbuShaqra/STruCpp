// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * A name the parser could not read (an empty name after recovery) is refused
 * by the parse error alone: no diagnostic names it as ''.
 */
import { describe, it, expect } from "vitest";
import { analyze } from "../../src/index.js";

const FEATURES = [
  "+struct_extends",
  "+property",
  "+pointer_to",
  "+reference_to",
];
const all = (src: string): string[] => {
  const r = analyze(src, { features: FEATURES });
  return [...r.errors, ...r.warnings].map(
    (e) => `${e.line}:${e.column}: ${e.message}`,
  );
};
const unnamed = (src: string): string[] =>
  all(src).filter((m) => m.includes("''"));

const CORPUS = `TYPE E : (RED, GREEN := 5); END_TYPE
TYPE S : STRUCT a : INT; e : E; END_STRUCT END_TYPE
TYPE S2 EXTENDS S : STRUCT b : INT; END_STRUCT END_TYPE
TYPE AL : ARRAY[0..2] OF INT; END_TYPE
TYPE SR : INT(0..10); END_TYPE
INTERFACE I2
METHOD M2 : INT
END_METHOD
END_INTERFACE
INTERFACE I EXTENDS I2
PROPERTY P : INT
GET
END_GET
END_PROPERTY
END_INTERFACE
FUNCTION_BLOCK FB0
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB EXTENDS FB0 IMPLEMENTS I
VAR_INPUT i : INT; END_VAR
VAR_OUTPUT o : INT; END_VAR
VAR_IN_OUT io : INT; END_VAR
METHOD M2 : INT
M2 := i;
END_METHOD
PROPERTY P : INT
GET
P := o;
END_GET
END_PROPERTY
ACTION A
o := 1;
END_ACTION
END_FUNCTION_BLOCK
VAR_GLOBAL g : INT; gs : S; END_VAR
FUNCTION F : INT
VAR_INPUT a : INT; END_VAR
VAR t : TON; p : POINTER TO INT; r : REFERENCE TO INT; END_VAR
F := a;
END_FUNCTION
PROGRAM MAIN
VAR fb : FB; s : S; x : INT; arr : ARRAY[0..2] OF INT; END_VAR
fb(i := 1, io := x, o => x);
FOR x := 0 TO 2 BY 1 DO arr[x] := x; END_FOR
END_PROGRAM
CONFIGURATION C
VAR_GLOBAL cg : INT; END_VAR
RESOURCE R ON PLC
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM I1 WITH T : MAIN;
END_RESOURCE
END_CONFIGURATION
`;

describe("names the parser could not read", () => {
  it("are not reported as an undefined type, program type or instance", () => {
    expect(
      all("PROGRAM P\nVAR a : ARRAY[0..2] OF ; END_VAR\nEND_PROGRAM\n"),
    ).toEqual(["2:24: Expected `Identifier`, found `;`."]);
    expect(
      unnamed(
        "PROGRAM P\nEND_PROGRAM\nCONFIGURATION C\nRESOURCE R ON PLC\nTASK T(INTERVAL := T#10ms);\nPROGRAM I WITH T : ;\nEND_RESOURCE\nEND_CONFIGURATION\n",
      ),
    ).toEqual([]);
    expect(
      unnamed(
        "PROGRAM P\nEND_PROGRAM\nCONFIGURATION C\nRESOURCE R ON PLC\nTASK T(INTERVAL := T#10ms);\nPROGRAM : P;\nEND_RESOURCE\nEND_CONFIGURATION\n",
      ),
    ).toEqual([]);
  });

  it("are named in no diagnostic with any one token left out or doubled", () => {
    const found: string[] = [];
    for (const m of CORPUS.matchAll(/\w+|[^\s\w]/g)) {
      const at = m.index;
      for (const variant of [
        CORPUS.slice(0, at) + CORPUS.slice(at + m[0].length),
        CORPUS.slice(0, at) + m[0] + " " + CORPUS.slice(at),
      ]) {
        for (const message of unnamed(variant)) {
          found.push(`'${m[0]}' at ${at}: ${message}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});
