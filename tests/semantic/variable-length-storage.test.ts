/**
 * ARRAY[*] has no size of its own (Ed. 3 6.5.3): only a FUNCTION or METHOD
 * VAR_INPUT, VAR_OUTPUT or VAR_IN_OUT, or a FUNCTION_BLOCK VAR_IN_OUT, takes
 * one. Every other declaration is refused, in every mode.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const MODES = [
  ["no dialect flag", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
] as const;

const TAIL =
  ": it needs fixed bounds there; ARRAY[*] is only a FUNCTION or METHOD VAR_INPUT, VAR_OUTPUT or VAR_IN_OUT, or a FUNCTION_BLOCK VAR_IN_OUT";

describe("ARRAY[*] outside a parameter", () => {
  it("names the RESOURCE that declares a global", () => {
    expect(
      compile(`CONFIGURATION C1
VAR_GLOBAL a : ARRAY[*] OF INT; END_VAR
RESOURCE R1 ON PLC
VAR_GLOBAL b : ARRAY[*] OF INT; END_VAR
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM I WITH T : Main;
END_RESOURCE
END_CONFIGURATION
PROGRAM Main END_PROGRAM
`).errors.map((e) => e.message),
    ).toEqual([
      `'a' is a variable-length ARRAY[*] in a VAR_GLOBAL of CONFIGURATION C1${TAIL}`,
      `'b' is a variable-length ARRAY[*] in a VAR_GLOBAL of RESOURCE R1 of CONFIGURATION C1${TAIL}`,
    ]);
  });

  for (const [label, options] of MODES) {
    it(`is refused in every storage declaration (${label})`, () => {
      const r = compile(
        `TYPE TV : ARRAY[*] OF INT; END_TYPE
TYPE S : STRUCT a : ARRAY[*] OF INT; END_STRUCT END_TYPE
VAR_GLOBAL v : ARRAY[*] OF INT; END_VAR
FUNCTION_BLOCK FB
VAR m : ARRAY[*] OF INT; END_VAR
VAR_INPUT i : ARRAY[*] OF INT; END_VAR
VAR_OUTPUT o : ARRAY[*] OF INT; END_VAR
END_FUNCTION_BLOCK
FUNCTION F : INT
VAR l : TV; END_VAR
VAR_TEMP t : ARRAY[*] OF INT; END_VAR
F := 1;
END_FUNCTION
PROGRAM Main
VAR w : ARRAY[*] OF INT; END_VAR
END_PROGRAM
`,
        options,
      );
      expect(r.errors.map((e) => `${e.line}:${e.column} ${e.message}`)).toEqual(
        [
          `15:9 'w' is a variable-length ARRAY[*] in a VAR of PROGRAM MAIN${TAIL}`,
          `10:9 'l' is a variable-length ARRAY[*] in a VAR of FUNCTION F${TAIL}`,
          `11:14 't' is a variable-length ARRAY[*] in a VAR_TEMP of FUNCTION F${TAIL}`,
          `5:9 'm' is a variable-length ARRAY[*] in a VAR of FUNCTION_BLOCK FB${TAIL}`,
          `6:15 'i' is a variable-length ARRAY[*] in a VAR_INPUT of FUNCTION_BLOCK FB${TAIL}`,
          `7:16 'o' is a variable-length ARRAY[*] in a VAR_OUTPUT of FUNCTION_BLOCK FB${TAIL}`,
          `3:16 'v' is a variable-length ARRAY[*] in a VAR_GLOBAL${TAIL}`,
          `2:21 'a' is a variable-length ARRAY[*] in STRUCT S${TAIL}`,
        ],
      );
    });

    it(`is accepted as a FUNCTION or METHOD parameter and an FB in/out (${label})`, () => {
      expect(
        compile(
          `TYPE TV : ARRAY[*] OF INT; END_TYPE
FUNCTION F : INT
VAR_INPUT a : TV; END_VAR
VAR_IN_OUT c : ARRAY[*, *] OF INT; END_VAR
VAR p : POINTER TO ARRAY[*] OF INT; END_VAR
F := a[LOWER_BOUND(a, 1)];
END_FUNCTION
FUNCTION_BLOCK FB
VAR_IN_OUT c : ARRAY[*] OF INT; END_VAR
METHOD M : INT
VAR_INPUT a : ARRAY[*] OF INT; END_VAR
M := a[LOWER_BOUND(a, 1)];
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main
VAR x : ARRAY[0..2] OF INT; y : ARRAY[0..1, 0..1] OF INT; inst : FB; n : INT; END_VAR
n := F(x, y);
inst(c := x);
n := inst.M(x);
END_PROGRAM
`,
          { ...options, features: ["+pointer_to"] },
        ).errors,
      ).toEqual([]);
    });
  }
});
