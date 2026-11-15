// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * EN and ENO are honoured only on a call written as a statement or as the
 * whole right-hand side of an assignment. Anywhere else (inside an
 * expression, a condition, another call's argument, an initial value) they
 * were ignored or passed as data inputs; they are now an error at the EN/ENO
 * argument, in every mode. CHAR/WCHAR MAX, MIN, LIMIT, comparisons, SEL and
 * MUX keep their nested EN/ENO.
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
  [
    "strict, vendor features",
    {
      strict: true,
      dialect: "iec-3",
      features: ["+program_methods", "+pointer_to", "+reference_to"],
    },
  ],
];

const MESSAGE =
  "EN/ENO are only supported on a call written as a statement or as the whole right-hand side of an assignment";

const DECLS = `FUNCTION Tr : INT
VAR_INPUT id : INT; END_VAR
VAR_IN_OUT log : INT; END_VAR
log := log * 10 + id;
Tr := id;
END_FUNCTION
FUNCTION F : INT
VAR_INPUT x : INT; END_VAR
F := x + 1;
END_FUNCTION
FUNCTION G : INT
VAR_INPUT x : INT; END_VAR
G := x;
END_FUNCTION
FUNCTION_BLOCK FB1
VAR_INPUT k : INT; END_VAR
METHOD M : INT
VAR_INPUT x : INT; END_VAR
M := x * 2;
END_METHOD
END_FUNCTION_BLOCK
TYPE ST_H : STRUCT fb : FB1; END_STRUCT END_TYPE
`;

const program = (body: string, extraVars = ""): string =>
  `${DECLS}PROGRAM Main
VAR
  r, a, c, n : INT; l : INT; ok, ok2 : BOOL; b : BOOL;
  i : FB1; arr : ARRAY[1..2] OF FB1; s : ST_H;
  c1, c2, c3 : CHAR; w1, w2 : WCHAR; t : BOOL;
  ${extraVars}
END_VAR
${body}
END_PROGRAM
`;

/** Line and column of each reported error, as `line:col`. */
const errorsAt = (code: string, options: Options): string[] => {
  const r = compile(code, options);
  return r.errors.map((e) => {
    expect(e.message).toBe(MESSAGE);
    return `${e.line}:${e.column}`;
  });
};

// The body starts on this line of `program(...)`.
const BODY_LINE = DECLS.split("\n").length + 7;

const REFUSED: Array<[string, string, number]> = [
  [
    "a user FUNCTION in an expression",
    "r := 1 + Tr(EN := FALSE, id := Tr(1, a), log := l, ENO => ok2);",
    13,
  ],
  [
    "MAX in an expression",
    "r := 1 + MAX(EN := FALSE, IN1 := Tr(1, c), IN2 := 2, ENO => ok2);",
    14,
  ],
  [
    "SEL in an expression",
    "r := 1 + SEL(EN := FALSE, G := FALSE, IN0 := 1, IN1 := 2, ENO => ok2);",
    14,
  ],
  ["MIN in an expression", "r := 1 + MIN(EN := b, IN1 := 1, IN2 := 2);", 14],
  [
    "LIMIT in an expression",
    "r := 1 + LIMIT(EN := b, MN := 0, IN := 1, MX := 2);",
    16,
  ],
  [
    "MUX in an expression",
    "r := 1 + MUX(EN := b, K := 0, IN0 := 1, IN1 := 2);",
    14,
  ],
  ["ADD in an expression", "r := 1 + ADD(EN := b, IN1 := 1, IN2 := 2);", 14],
  ["a conversion in an expression", "r := 1 + TO_INT(EN := b, IN := n);", 17],
  ["a typed conversion", "r := 1 + DINT_TO_INT(EN := b, IN := 5);", 22],
  ["only ENO in an expression", "r := 1 + F(x := 1, ENO => ok);", 20],
  ["a condition", "IF F(EN := b, x := 1) > 0 THEN r := 0; END_IF;", 6],
  [
    "a WHILE condition",
    "WHILE F(EN := b, x := 1) > 9 DO r := 0; END_WHILE;",
    9,
  ],
  ["an argument of another call", "r := G(F(EN := b, x := 1));", 10],
  ["an FB input", "i(k := F(EN := b, x := 1));", 10],
  ["a parenthesised right-hand side", "r := (F(EN := b, x := 1));", 9],
  [
    "a method of an instance in an expression",
    "r := 1 + i.M(EN := b, x := 3);",
    14,
  ],
  [
    "a method of an array element in an expression",
    "r := 1 + arr[1].M(EN := b, x := 3);",
    19,
  ],
  [
    "a method of a STRUCT member in an expression",
    "r := 1 + s.fb.M(EN := b, x := 3);",
    17,
  ],
  [
    "a non-CHAR MAX in a comparison",
    "t := MAX(EN := b, IN1 := 1, IN2 := 2) > 0;",
    10,
  ],
];

describe("EN/ENO on a call inside an expression", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      for (const [what, body, col] of REFUSED) {
        it(`is refused in ${what}`, () => {
          expect(errorsAt(program(body), options)).toEqual([
            `${BODY_LINE}:${col}`,
          ]);
        });
      }

      it("is refused in an initial value", () => {
        const code = program("r := 0;", "init : INT := F(EN := TRUE, x := 1);");
        expect(errorsAt(code, options)).toEqual([`${BODY_LINE - 2}:19`]);
      });

      it("is refused in a FUNCTION body too", () => {
        const r = compile(
          `${DECLS}FUNCTION H : INT
VAR_INPUT b : BOOL; END_VAR
H := 2 * F(EN := b, x := 1);
END_FUNCTION
`,
          options,
        );
        expect(r.errors.map((e) => e.message)).toEqual([MESSAGE]);
      });

      it("accepts a call statement, a whole right-hand side and nested CHAR forms", () => {
        const r = compile(
          program(`${
            // Strict refuses an unused FUNCTION result
            options?.strict === true ? "" : "F(EN := b, x := 1, ENO => ok);"
          }
r := F(EN := b, x := 1, ENO => ok);
r := Tr(EN := FALSE, id := Tr(1, a), log := l, ENO => ok2);
r := MAX(EN := b, IN1 := 1, IN2 := 2);
r := SEL(EN := b, G := TRUE, IN0 := 1, IN1 := 2, ENO => ok);
r := TO_INT(EN := b, IN := n, ENO => ok);
r := i.M(EN := b, x := 3, ENO => ok);
i.M(EN := b, x := 3, ENO => ok);
r := arr[1].M(EN := b, x := 3, ENO => ok);
arr[1].M(EN := b, x := 3, ENO => ok);
r := s.fb.M(EN := b, x := 3, ENO => ok);
s.fb.M(EN := b, x := 3, ENO => ok);
i(EN := b, k := 1, ENO => ok);
c1 := MAX(c2, MAX(EN := b, IN1 := c2, IN2 := c3, ENO => ok));
t := GT(EN := b, IN1 := c1, IN2 := c2, ENO => ok) AND t;
w1 := SEL(t, w2, MIN(EN := b, IN1 := w1, IN2 := w2, ENO => ok));`),
          options,
        );
        expect(r.errors).toEqual([]);
      });

      it("reports the error from --check analysis as well", async () => {
        const { analyze } = await import("../../src/index.js");
        const r = analyze(program("r := 1 + F(EN := b, x := 1);"), options);
        expect(r.errors.map((e) => e.message)).toEqual([MESSAGE]);
      });
    });
  }
});

const LIBS_DIR = path.resolve(__dirname, "../../libs");
const libsAvailable = fs.existsSync(path.join(LIBS_DIR, "oscat-basic.stlib"));

describe.skipIf(!libsAvailable)("EN/ENO on a library FUNCTION", () => {
  const libraries = libsAvailable ? discoverStlibs(LIBS_DIR) : [];
  const source = (body: string): string => `PROGRAM Main
VAR x : REAL := 3.14159; y : REAL; b, ok : BOOL; END_VAR
${body}
END_PROGRAM
`;

  it("is refused inside an expression", () => {
    const r = compile(source("y := 1.0 + ROUND(EN := b, IN := x, N := 2);"), {
      libraries,
    });
    expect(r.errors.map((e) => `${e.line}:${e.column} ${e.message}`)).toEqual([
      `3:18 ${MESSAGE}`,
    ]);
  });

  it("is accepted as the whole right-hand side", () => {
    const r = compile(
      source("y := ROUND(EN := b, IN := x, N := 2, ENO => ok);"),
      { libraries },
    );
    expect(r.errors).toEqual([]);
  });
});
