/**
 * A non-BOOL value bound to a BOOL input of a FUNCTION, FB or METHOD gets the
 * narrowing warning its assignment gets, in every mode (an error under --strict).
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const SOURCE = `FUNCTION F : INT
VAR_INPUT b : BOOL; END_VAR
F := 0;
END_FUNCTION
FUNCTION_BLOCK FB
VAR_INPUT b : BOOL; END_VAR
METHOD M : INT
VAR_INPUT q : BOOL; END_VAR
M := 0;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main
VAR i : INT := 5; r : INT; fb : FB; x : BOOL; END_VAR
r := F(i);
r := F(b := i);
fb(b := i);
r := fb.M(i);
x := i;
r := F(1);
r := F(x);
fb(b := TRUE);
END_PROGRAM
`;

describe("BOOL input narrowing", () => {
  for (const [label, options] of [
    ["no dialect", {}],
    ["iec-3", { dialect: "iec-3" }],
  ] as const) {
    it(`warns as the assignment does (${label})`, () => {
      const r = compile(SOURCE, options);
      expect(r.errors).toEqual([]);
      expect(
        r.warnings.map((w) => `${w.line}:${w.column} ${w.message}`),
      ).toEqual([
        "14:8 Implicit narrowing conversion from INT to BOOL",
        "15:13 Implicit narrowing conversion from INT to BOOL",
        "16:9 Implicit narrowing conversion from INT to BOOL",
        "17:11 Implicit narrowing conversion from INT to BOOL",
        "18:6 Implicit narrowing conversion from INT to BOOL",
      ]);
    });
  }

  it("refuses it under --strict", () => {
    const r = compile(SOURCE, { strict: true });
    expect(r.errors.map((e) => e.message)).toEqual(
      Array(5).fill(
        "Implicit conversion from INT to BOOL is not allowed; use INT_TO_BOOL",
      ),
    );
  });
  for (const [label, options] of [
    ["no dialect", {}],
    ["iec-3", { dialect: "iec-3" }],
  ] as const) {
    it(`binds a positional argument past a VAR_OUTPUT to its own input (${label})`, () => {
      const r = compile(
        `FUNCTION H : INT
VAR_INPUT n : INT; END_VAR
VAR_OUTPUT o : INT; END_VAR
VAR_INPUT b : BOOL; END_VAR
o := n + 10;
IF b THEN H := 1; ELSE H := 2; END_IF;
END_FUNCTION
FUNCTION_BLOCK FB
METHOD M : INT
VAR_INPUT n : INT; END_VAR
VAR_OUTPUT o : INT; END_VAR
VAR_INPUT b : BOOL; END_VAR
M := n;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main
VAR i : INT := 3; x : BOOL; r : INT; o : INT; f : FB; END_VAR
r := H(i, o, x);
r := f.M(i, o, x);
r := H(i, o, i);
END_PROGRAM
`,
        options,
      );
      expect(r.errors).toEqual([]);
      expect(
        r.warnings.map((w) => `${w.line}:${w.column} ${w.message}`),
      ).toEqual(["20:14 Implicit narrowing conversion from INT to BOOL"]);
    });
  }

  it("gives a VAR_IN_OUT BOOL bound to an INT only its own diagnostic", () => {
    const source = `FUNCTION FIO : INT
VAR_IN_OUT b : BOOL; END_VAR
FIO := 0;
END_FUNCTION
PROGRAM Main
VAR i : INT; r : INT; END_VAR
r := FIO(i);
END_PROGRAM
`;
    expect(
      compile(source).warnings.filter((w) => w.message.includes("narrowing")),
    ).toEqual([]);
    expect(
      compile(source, { dialect: "iec-3" }).warnings.filter((w) =>
        w.message.includes("narrowing"),
      ),
    ).toEqual([]);
  });
});
