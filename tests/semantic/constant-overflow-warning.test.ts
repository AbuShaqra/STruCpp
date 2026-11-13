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
});
