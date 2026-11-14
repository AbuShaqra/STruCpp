/** Under --strict an integer constant expression that does not fit its target warns; it wraps at run time. */
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
  it("warns under --strict", () => {
    const r = compile(SOURCE, { strict: true });
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((w) => `${w.line}:${w.column} ${w.message}`)).toEqual(
      [
        "2:16 The constant expression is 32768, outside INT (-32768..32767): it wraps",
        "3:6 The constant expression is 40000, outside INT (-32768..32767): it wraps",
        "5:6 The constant expression is -1, outside USINT (0..255): it wraps",
        "5:6 Implicit narrowing conversion from INT to USINT",
        "6:6 The constant expression is 32768, outside INT (-32768..32767): it wraps",
      ],
    );
  });

  it("says nothing new without --strict", () => {
    const r = compile(SOURCE);
    expect(r.warnings.map((w) => w.message)).toEqual([
      "Implicit narrowing conversion from INT to USINT",
    ]);
  });
  it("warns on an untyped literal, a typed subexpression and a call argument", () => {
    const r = compile(
      `FUNCTION F : INT
VAR_INPUT x : INT; END_VAR
F := x;
END_FUNCTION
FUNCTION_BLOCK FB
VAR_INPUT x : SINT; END_VAR
END_FUNCTION_BLOCK
PROGRAM Main
VAR i : INT := 40000; s : SINT; b : INT; d : DINT; fb1 : FB; ok : INT := 32767; END_VAR
s := 200;
d := INT#32767 + INT#1;
b := SINT#100 * SINT#2;
d := UINT#0 - UINT#1;
b := F(x := 200 * 200);
b := F(200 * 200);
fb1(x := 100 + 100);
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
      "9:16 The constant expression is 40000, outside INT (-32768..32767): it wraps",
      "10:6 The constant expression is 200, outside SINT (-128..127): it wraps",
      "11:6 The constant expression is 32768, outside INT (-32768..32767): it wraps",
      "12:6 The constant expression is 200, outside SINT (-128..127): it wraps",
      "13:6 The constant expression is -1, outside UINT (0..65535): it wraps",
      "14:13 The constant expression is 40000, outside INT (-32768..32767): it wraps",
      "15:8 The constant expression is 40000, outside INT (-32768..32767): it wraps",
      "16:10 The constant expression is 200, outside SINT (-128..127): it wraps",
    ]);
  });
});
