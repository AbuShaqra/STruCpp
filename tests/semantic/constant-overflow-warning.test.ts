/**
 * An untyped integer constant expression that does not fit its target wraps
 * at run time: a warning by default, an error under --strict and iec-3. A
 * typed one warns under --strict only.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const SOURCE = `PROGRAM Main
VAR a : INT := 32767 + 1; b : INT; c : SINT; d : DINT; u : USINT; k : INT := 3 * 4; END_VAR
b := 200 * 200;
d := 200 * 200;
u := 0 - 1;
b := INT#32767 + INT#1;
b := 32767;
END_PROGRAM
`;

describe("constant expression overflow", () => {
  const untyped = [
    "2:16 The constant expression is 32768, outside INT (-32768..32767): it wraps",
    "3:6 The constant expression is 40000, outside INT (-32768..32767): it wraps",
    "5:6 The constant expression is -1, outside USINT (0..255): it wraps",
  ];
  const at = (l: { line: number; column: number; message: string }[]) =>
    l.map((w) => `${w.line}:${w.column} ${w.message}`);

  it("is an error under --strict and iec-3 for an untyped one", () => {
    for (const options of [{ strict: true }, { dialect: "iec-3" }]) {
      const r = compile(SOURCE, options);
      expect(at(r.errors)).toEqual(untyped);
      expect(at(r.warnings)).toEqual([
        "5:6 Implicit narrowing conversion from INT to USINT",
        // typed: a warning, --strict only
        ...(options.strict === true
          ? [
              "6:6 The constant expression is 32768, outside INT (-32768..32767): it wraps",
            ]
          : []),
      ]);
    }
  });

  it("warns by default for an untyped one", () => {
    const r = compile(SOURCE);
    expect(r.errors).toEqual([]);
    expect(at(r.warnings)).toEqual([
      untyped[0],
      untyped[1],
      untyped[2],
      "5:6 Implicit narrowing conversion from INT to USINT",
    ]);
  });
  it("warns on an untyped literal, a typed expression and a call argument", () => {
    const r = compile(
      `FUNCTION F : INT
VAR_INPUT x : INT; END_VAR
F := x;
END_FUNCTION
FUNCTION_BLOCK FB
VAR_INPUT x : SINT; END_VAR
END_FUNCTION_BLOCK
PROGRAM Main
VAR i : INT := 40000; s : SINT; b : INT; d : DINT; fb1 : FB; ok : INT := 32767; w : UINT; END_VAR
s := 200;
b := INT#32767 + INT#1;
s := SINT#100 * SINT#2;
w := UINT#0 - UINT#1;
b := F(x := 200 * 200);
b := F(200 * 200);
fb1(x := 100 + 100);
END_PROGRAM
`,
      { strict: true },
    );
    const constants = (l: typeof r.errors) =>
      at(l.filter((w) => w.message.startsWith("The constant")));
    expect(constants(r.errors)).toEqual([
      "9:16 The constant expression is 40000, outside INT (-32768..32767): it wraps",
      "10:6 The constant expression is 200, outside SINT (-128..127): it wraps",
      "14:13 The constant expression is 40000, outside INT (-32768..32767): it wraps",
      "15:8 The constant expression is 40000, outside INT (-32768..32767): it wraps",
      "16:10 The constant expression is 200, outside SINT (-128..127): it wraps",
    ]);
    expect(constants(r.warnings)).toEqual([
      "11:6 The constant expression is 32768, outside INT (-32768..32767): it wraps",
      "12:6 The constant expression is 200, outside SINT (-128..127): it wraps",
      "13:6 The constant expression is -1, outside UINT (0..65535): it wraps",
    ]);
  });

  it("computes a typed expression in its common type, at least DINT, and checks the target", () => {
    const r = compile(
      `PROGRAM Main
VAR d : DINT; l : LINT; i : INT; s : SINT; END_VAR
d := INT#2 * DINT#100000;
l := DINT#1 + LINT#3000000000;
i := SINT#100 + INT#100;
d := INT#32767 + 1;
d := INT#32767 * INT#32767;
i := INT#32767 + 1;
s := SINT#100 + SINT#100;
l := DINT#2147483647 + 1;
END_PROGRAM
`,
      { strict: true },
    );
    expect(r.errors).toEqual([]);
    expect(
      r.warnings
        .filter((w) => w.message.startsWith("The constant"))
        .map((w) => `${w.line}:${w.column} ${w.message}`),
    ).toEqual([
      "8:6 The constant expression is 32768, outside INT (-32768..32767): it wraps",
      "9:6 The constant expression is 200, outside SINT (-128..127): it wraps",
      "10:6 The constant expression is 2147483648, outside DINT (-2147483648..2147483647): it wraps",
    ]);
  });
});
