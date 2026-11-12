// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Ed. 3 forms in every dialect: STRUCT OVERLAP lowers as a UNION, the Table 46
 * typed timer names and an LTIME preset on TP/TON/TOF, and an untyped real
 * literal no LREAL holds is refused before the C++ compiler sees it.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { compile } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];
const LIBS_DIR = path.resolve(__dirname, "../../libs");
const libsAvailable = fs.existsSync(
  path.join(LIBS_DIR, "iec-standard-fb.stlib"),
);
const libraries = libsAvailable ? discoverStlibs(LIBS_DIR) : [];

describe("Ed. 3 leftovers", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      it("lowers STRUCT OVERLAP as a UNION, without the union feature", () => {
        const overlap = compile(
          "TYPE T : STRUCT OVERLAP a : DINT; b : ARRAY[0..3] OF BYTE; END_STRUCT END_TYPE\nPROGRAM Main\nVAR v : T; x : BYTE; END_VAR\nv.a := 1; x := v.b[0];\nEND_PROGRAM\n",
          options,
        );
        expect(overlap.errors).toEqual([]);
        const union = compile(
          "TYPE T : UNION a : DINT; b : ARRAY[0..3] OF BYTE; END_UNION END_TYPE\nPROGRAM Main\nVAR v : T; x : BYTE; END_VAR\nv.a := 1; x := v.b[0];\nEND_PROGRAM\n",
          { ...options, features: ["+union"] },
        );
        expect(union.errors).toEqual([]);
        expect(overlap.headerCode).toBe(union.headerCode);
        expect(overlap.cppCode).toBe(union.cppCode);
      });

      it("refuses an initial value for STRUCT OVERLAP and its members", () => {
        expect(
          compile(
            "TYPE U : STRUCT OVERLAP a : DINT; b : ARRAY[0..3] OF BYTE; END_STRUCT END_TYPE\nPROGRAM Main\nVAR u2 : U := (a := 1); END_VAR\nEND_PROGRAM\n",
            options,
          ).errors.map((e) => e.message),
        ).toEqual(["STRUCT OVERLAP 'U' cannot be initialized explicitly"]);
        expect(
          compile(
            "TYPE U : STRUCT OVERLAP a : DINT := 3; b : INT; END_STRUCT END_TYPE\nPROGRAM Main\nVAR u : U; END_VAR\nEND_PROGRAM\n",
            options,
          ).errors.map((e) => e.message),
        ).toEqual([
          "Member 'A' of STRUCT OVERLAP 'U' has an initial value: an overlapped structure cannot be initialized explicitly",
        ]);
      });

      it("takes a first member named by a keyword allowed as a field name", () => {
        // As a plain STRUCT does: strict mode refuses the reserved name in both.
        const errs = (kind: string): string[] =>
          compile(
            `TYPE U : ${kind} ON : BOOL; d : INT; END_STRUCT END_TYPE\nPROGRAM Main\nVAR u : U; END_VAR\nu.d := 1;\nEND_PROGRAM\n`,
            options,
          ).errors.map((e) => e.message);
        expect(errs("STRUCT OVERLAP")).toEqual(errs("STRUCT"));
        expect(errs("STRUCT OVERLAP").some((m) => /Expected/.test(m))).toBe(
          false,
        );
      });

      it("keeps a field named overlap", () => {
        expect(
          compile(
            "TYPE T : STRUCT overlap : INT; b : INT; END_STRUCT END_TYPE\nPROGRAM Main\nVAR v : T; END_VAR\nv.overlap := 1;\nEND_PROGRAM\n",
            options,
          ).errors,
        ).toEqual([]);
      });

      it("refuses an untyped real literal past LREAL", () => {
        expect(
          compile(
            "PROGRAM Main\nVAR l : LREAL; END_VAR\nl := 1E400;\nl := 1E-400;\nEND_PROGRAM\n",
            options,
          ).errors.map((e) => e.message),
        ).toEqual(["Real literal '1E400' is outside the LREAL range"]);
      });

      it.skipIf(!libsAvailable)(
        "takes the Table 46 timer names and an LTIME preset",
        () => {
          const r = compile(
            `TYPE S : STRUCT tm : TON; END_STRUCT END_TYPE
PROGRAM Main
VAR
  arr : ARRAY[0..2] OF TOF; s : S;
  a : TON_TIME; b : TON_LTIME; c : TOF_TIME; d : TOF_LTIME; e : TP_TIME; f : TP_LTIME;
  t : TON; p : LTIME := LT#1s; q : LTIME;
END_VAR
a(IN := TRUE, PT := T#1s);
b(IN := TRUE, PT := LT#1s);
c(IN := TRUE, PT := T#1s);
d(IN := TRUE, PT := LT#1s);
e(IN := TRUE, PT := T#1s);
f(IN := TRUE, PT := LT#1s);
t.PT := p;
arr[1].PT := p;
s.tm.PT := p;
t(IN := TRUE, PT := p);
q := t.ET;
q := b.ET;
END_PROGRAM
`,
            { ...options, libraries },
          );
          expect(r.errors).toEqual([]);
        },
      );
    });
  }
});
