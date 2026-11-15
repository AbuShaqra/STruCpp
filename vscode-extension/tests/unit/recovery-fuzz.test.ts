// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Every LSP provider answers on source the parser had to recover: unclosed or
 * unnamed POUs, empty enum members, keywords where names belong, and every
 * prefix of a few complete units.
 */
import { describe, it, expect } from "vitest";
import { analyze, type AnalysisResult } from "strucpp";
import { getCompletions } from "../../server/src/completion.js";
import { getHover } from "../../server/src/hover.js";
import {
  getDefinition,
  getTypeDefinition,
} from "../../server/src/definition.js";
import { getReferences } from "../../server/src/references.js";
import {
  getDocumentSymbols,
  getWorkspaceSymbols,
} from "../../server/src/symbols.js";
import { getSemanticTokens } from "../../server/src/semantic-tokens.js";
import { getSignatureHelp } from "../../server/src/signature-help.js";
import { prepareRename, getRenameEdits } from "../../server/src/rename.js";

const FILE = "fuzz.st";
const URI = "file:///fuzz.st";

/** An empty name or label, a negative position, or a token number that is no count. */
function badOutput(value: unknown, depth = 0): string | undefined {
  if (depth > 12 || value === null || typeof value !== "object") {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v === "number" && (!Number.isInteger(v) || v < 0)) {
        return `token number ${v}`;
      }
      const bad = badOutput(v, depth + 1);
      if (bad !== undefined) return bad;
    }
    return undefined;
  }
  for (const [k, v] of Object.entries(value)) {
    if ((k === "name" || k === "label") && v === "") return `empty ${k}`;
    if ((k === "line" || k === "character") && typeof v === "number" && v < 0) {
      return `negative ${k}`;
    }
    const bad = badOutput(v, depth + 1);
    if (bad !== undefined) return bad;
  }
  return undefined;
}

/** Every distinct provider throw on `source`, at each position of `onLines` (all when omitted). */
function throws(source: string, onLines?: ReadonlySet<number>): string[] {
  const found = new Map<string, string>();
  const note = (failure: string | undefined): void => {
    if (failure === undefined) return;
    const key = failure.replace(/ \d+:\d+:/, ":");
    if (!found.has(key)) found.set(key, failure);
  };
  let analysis: AnalysisResult;
  try {
    analysis = analyze(source, { fileName: FILE });
  } catch (e) {
    return [`analyze: ${String(e)}`];
  }
  const docs = new Map([[URI, { uri: URI, analysisResult: analysis }]]);
  const run = (what: string, f: () => unknown): string | undefined => {
    try {
      const bad = badOutput(f());
      return bad === undefined ? undefined : `${what}: ${bad}`;
    } catch (e) {
      return `${what}: ${e instanceof Error ? e.message : String(e)}`;
    }
  };
  note(run("documentSymbols", () => getDocumentSymbols(analysis, FILE)));
  note(
    run("workspaceSymbols", () =>
      getWorkspaceSymbols(new Map([[URI, analysis]]), ""),
    ),
  );
  note(run("semanticTokens", () => getSemanticTokens(analysis, FILE, source)));
  const lines = source.split("\n");
  for (let l = 0; l < lines.length; l++) {
    if (onLines !== undefined && !onLines.has(l + 1)) continue;
    for (let c = 1; c <= lines[l]!.length + 1; c++) {
      const at = `${l + 1}:${c}`;
      const calls: Array<[string, () => unknown]> = [
        [
          `completion ${at}`,
          () => getCompletions(analysis, FILE, l + 1, c, source),
        ],
        [
          `hover ${at}`,
          () => getHover(analysis, FILE, l + 1, c, undefined, source),
        ],
        [
          `definition ${at}`,
          () =>
            getDefinition(
              analysis,
              FILE,
              l + 1,
              c,
              URI,
              undefined,
              undefined,
              source,
            ),
        ],
        [
          `typeDefinition ${at}`,
          () => getTypeDefinition(analysis, FILE, l + 1, c, URI),
        ],
        [
          `references ${at}`,
          () => getReferences(analysis, FILE, l + 1, c, URI, docs),
        ],
        [
          `signatureHelp ${at}`,
          () => getSignatureHelp(analysis, FILE, l + 1, c, source),
        ],
        [`prepareRename ${at}`, () => prepareRename(analysis, FILE, l + 1, c)],
        [
          `rename ${at}`,
          () => getRenameEdits(analysis, FILE, l + 1, c, "ZZ", URI, docs),
        ],
      ];
      for (const [what, f] of calls) note(run(what, f));
    }
  }
  return [...found.values()];
}

const MALFORMED = [
  "FUNCTION_BLOCK F\nVAR x : INT; END_VAR\nMETHOD M : INT\nM := x;\nEND_METHOD\nMETHOD N\n",
  "FUNCTION_BLOCK F\nVAR x : INT; END_VAR\nMETHOD\nEND_METHOD\nEND_FUNCTION_BLOCK\n",
  "FUNCTION_BLOCK F\nMETHOD M : INT\nM := 1;\n",
  "TYPE T : (a, b, ); END_TYPE\n",
  "PROGRAM P\nVAR x2 : (a, IF, c); END_VAR\nEND_PROGRAM\n",
  "TYPE T : STRUCT a : INT; : INT; END_STRUCT END_TYPE\n",
  "PROGRAM P\nVAR a : ARRAY[0..2] OF ; END_VAR\nEND_PROGRAM\n",
  "CONFIGURATION C\nRESOURCE R ON PLC\nTASK T(INTERVAL := T#10ms);\nPROGRAM I WITH T : ;\nEND_RESOURCE\nEND_CONFIGURATION\n",
  "CONFIGURATION C\nRESOURCE R ON PLC\nPROGRAM : P;\nEND_RESOURCE\nEND_CONFIGURATION\n",
  "PROGRAM\nVAR x : INT; END_VAR\nEND_PROGRAM\n",
  "FUNCTION : INT\nEND_FUNCTION\n",
  "FUNCTION_BLOCK\nEND_FUNCTION_BLOCK\n",
  "INTERFACE I\nMETHOD\nEND_METHOD\nPROPERTY : INT\nEND_PROPERTY\nEND_INTERFACE\n",
  "FUNCTION_BLOCK F\nPROPERTY P : INT\nGET\nP := 1;\n",
  "PROGRAM P\nVAR fb : ; x : INT; END_VAR\nx := fb.;\nfb(a := , b => );\nEND_PROGRAM\n",
  "PROGRAM P\nVAR x : INT; END_VAR\nx := (1 + ;\nIF x THEN\nCASE x OF\n1: x := ;\nEND_PROGRAM\n",
  "VAR_GLOBAL\n : INT;\nEND_VAR\n",
  "TYPE : INT; END_TYPE\nTYPE E : (); END_TYPE\n",
  "PROGRAM P\nVAR s : STRUCT a : INT; END_STRUCT; END_VAR\nEND_PROGRAM\n",
  "FUNCTION F : INT\nVAR_INPUT : INT; END_VAR\nF := F(1, );\nEND_FUNCTION\n",
];

const COMPLETE = `TYPE E : (RED, GREEN := 5); END_TYPE
TYPE S : STRUCT a : INT; e : E; END_STRUCT END_TYPE
INTERFACE I
METHOD M : INT
VAR_INPUT q : INT; END_VAR
END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB IMPLEMENTS I
VAR_INPUT i : INT; END_VAR
VAR_OUTPUT o : INT; END_VAR
METHOD M : INT
VAR_INPUT q : INT; END_VAR
M := q + i;
END_METHOD
PROPERTY P : INT
GET
P := o;
END_GET
END_PROPERTY
END_FUNCTION_BLOCK
FUNCTION F : INT
VAR_INPUT a : INT; END_VAR
F := a;
END_FUNCTION
PROGRAM MAIN
VAR fb : FB; s : S; x : INT; END_VAR
fb(i := 1, o => x);
x := F(a := fb.M(2)) + s.a;
CASE x OF 1: s.e := RED; END_CASE
END_PROGRAM
CONFIGURATION C
RESOURCE R ON PLC
TASK T(INTERVAL := T#10ms);
PROGRAM I1 WITH T : MAIN;
END_RESOURCE
END_CONFIGURATION
`;

describe("LSP providers on recovered source", () => {
  it.each(MALFORMED.map((s, i) => [i, s] as const))(
    "never throw on malformed input %i",
    (_i, source) => {
      expect(throws(source)).toEqual([]);
    },
  );

  it(
    "never throw on any line prefix of a complete unit",
    { timeout: 120_000 },
    () => {
      const lines = COMPLETE.split("\n");
      const failures: string[] = [];
      for (let n = 1; n < lines.length; n++) {
        const prefix = lines.slice(0, n).join("\n") + "\n";
        for (const failure of throws(prefix)) {
          failures.push(`${n} lines: ${failure}`);
        }
      }
      expect(failures).toEqual([]);
    },
  );

  it(
    "never throw with any one token left out or doubled",
    { timeout: 300_000 },
    () => {
      const failures: string[] = [];
      for (const m of COMPLETE.matchAll(/\w+|[^\s\w]/g)) {
        const at = m.index;
        const line = COMPLETE.slice(0, at).split("\n").length;
        const variants = [
          COMPLETE.slice(0, at) + COMPLETE.slice(at + m[0].length),
          COMPLETE.slice(0, at) + m[0] + " " + COMPLETE.slice(at),
        ];
        for (const variant of variants) {
          for (const failure of throws(variant, new Set([line]))) {
            failures.push(`token '${m[0]}' at ${line}: ${failure}`);
          }
        }
      }
      expect(failures).toEqual([]);
    },
  );
});
