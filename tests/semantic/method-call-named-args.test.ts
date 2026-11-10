/**
 * Named arguments of a method call (`inst.M(a := 1)`, `THIS.M`, `SUPER.M`,
 * `PRG.M`, a bare `M` of the enclosing block or program, through an
 * interface or a REFERENCE TO) must name a parameter of the method: the C++
 * binds arguments by name and silently dropped any other one.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const TYPES = `INTERFACE I_M
METHOD M : INT
VAR_INPUT a : INT; END_VAR
END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB_Base IMPLEMENTS I_M
METHOD M : INT
VAR_INPUT a : INT; END_VAR
M := a;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_D EXTENDS FB_Base
METHOD N : INT
VAR_INPUT b : INT; END_VAR
VAR_OUTPUT q : INT; END_VAR
VAR_IN_OUT io : INT; END_VAR
N := b;
END_METHOD
METHOD Body : INT
VAR v : INT; END_VAR
__CALL__
END_METHOD
END_FUNCTION_BLOCK
PROGRAM PRG
VAR y : INT; END_VAR
METHOD PM : INT
VAR_INPUT k : INT; END_VAR
PM := k;
END_METHOD
__PRG__
END_PROGRAM
PROGRAM MAIN
VAR d : FB_D; itf : I_M; r : REFERENCE TO FB_D; x : INT; END_VAR
itf := d;
__MAIN__
END_PROGRAM
`;

function errors(
  where: { call?: string; prg?: string; main?: string },
  dialect?: string,
): string[] {
  const src = TYPES.replace("__CALL__", where.call ?? "")
    .replace("__PRG__", where.prg ?? "")
    .replace("__MAIN__", where.main ?? "");
  const r = compile(src, {
    features: ["+program_methods"],
    ...(dialect !== undefined ? { dialect } : {}),
  });
  return r.errors.map((e) => e.message);
}

describe("method call named arguments", () => {
  for (const dialect of [undefined, "iec-3"]) {
    const label = dialect ?? "no dialect";
    it(`instance call refuses an unknown name (${label})`, () => {
      expect(errors({ main: "x := d.M(zz := 3);" }, dialect)).toContain(
        "Method 'M' of 'FB_D' has no parameter named 'ZZ'",
      );
    });
  }

  it("statement call on an instance", () => {
    expect(errors({ main: "d.N(b := 1, io := x, zz := 3);" })).toEqual([
      "Method 'N' of 'FB_D' has no parameter named 'ZZ'",
    ]);
  });

  it("bare, THIS and SUPER calls inside a block", () => {
    expect(
      errors({
        call: "Body := N(b := 1, io := v, zz := 1) + THIS.N(b := 1, io := v, yy := 1) + SUPER.M(xx := 1);",
      }),
    ).toEqual([
      "Method 'N' of 'FB_D' has no parameter named 'ZZ'",
      "Method 'N' of 'FB_D' has no parameter named 'YY'",
      "Method 'M' of 'FB_BASE' has no parameter named 'XX'",
    ]);
  });

  it("a program's own method, bare and by the program's name", () => {
    expect(errors({ prg: "y := PM(kk := 1) + PRG.PM(jj := 1);" })).toEqual([
      "Method 'PM' of 'PRG' has no parameter named 'KK'",
      "Method 'PM' of 'PRG' has no parameter named 'JJ'",
    ]);
  });

  it("through an interface and a REFERENCE TO", () => {
    expect(
      errors({
        main: "x := itf.M(b := 1); x := r.N(b := 1, io := x, c := 2);",
      }),
    ).toEqual([
      "Method 'M' of 'I_M' has no parameter named 'B'",
      "Method 'N' of 'FB_D' has no parameter named 'C'",
    ]);
  });

  it("accepts inputs, in/outs, outputs and EN/ENO", () => {
    expect(
      errors({
        call: "Body := N(EN := TRUE, io := v, q => v, b := 1) + SUPER.M(a := 1);",
        prg: "y := PM(k := 1);",
        main: "x := itf.M(a := 1) + d.M(a := 2) + r.N(b := 1, io := x);",
      }),
    ).toEqual([]);
  });
});
