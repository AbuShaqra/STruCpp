// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Interfaces, properties and call results: what the checker accepts, refuses
 * and types (`itf = fb`, a variable named like a method, `FP()^`, `F().M();`,
 * selectors after `THIS^.M()`, argument types through interface receivers,
 * property bits and `h.P^`, a bit of a constant in a STRUCT default) and the
 * debug-table warnings grouped per declaration; a FUNCTION result is checked
 * as the variable it is.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];
const CALL_RESULTS: Options = {
  features: ["+call_result_access", "+self_caret"],
};

const errorsOf = (src: string, options: Options = {}): string[] =>
  compile(src, { headerFileName: "g.hpp", ...options }).errors.map(
    (e) => e.message,
  );

const ITF = `INTERFACE I_A
  METHOD Get : INT
  END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB_A IMPLEMENTS I_A
  METHOD Get : INT
    Get := 7;
  END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_B
END_FUNCTION_BLOCK
`;

describe("itf = fb compares the instance", () => {
  for (const [label, options] of MODES) {
    it(`accepts an implementing instance on either side (${label})`, () => {
      expect(
        errorsOf(
          `${ITF}
PROGRAM Main
VAR fb : FB_A; itf : I_A; b : BOOL; END_VAR
itf := fb;
b := itf = fb;
b := fb <> itf;
END_PROGRAM
`,
          options,
        ),
      ).toEqual([]);
    });
  }

  it("refuses an FB that does not implement it, or a value", () => {
    expect(
      errorsOf(`${ITF}
PROGRAM Main
VAR fb : FB_B; itf : I_A; b : BOOL; i : INT; END_VAR
b := itf = fb;
b := itf = i;
b := fb <> itf;
END_PROGRAM
`),
    ).toEqual([
      "Cannot compare I_A with FB_B: FB_B does not implement I_A",
      "Cannot compare I_A with INT",
      "Cannot compare I_A with FB_B: FB_B does not implement I_A",
    ]);
  });
});

describe("a variable named like a method of its block", () => {
  it("is refused for a method of the block itself", () => {
    expect(
      errorsOf(`FUNCTION_BLOCK FB_L
VAR level : INT; END_VAR
VAR_OUTPUT run : BOOL; END_VAR
  METHOD Level : INT
  END_METHOD
  METHOD Run : INT
  END_METHOD
END_FUNCTION_BLOCK
`),
    ).toEqual([
      "Variable 'LEVEL' in FUNCTION_BLOCK 'FB_L' has the same name as method 'LEVEL'",
      "Variable 'RUN' in FUNCTION_BLOCK 'FB_L' has the same name as method 'RUN'",
    ]);
  });

  it("stays accepted for a method of an implemented interface (renamed in C++)", () => {
    expect(
      errorsOf(`INTERFACE IMotor
  METHOD Start : BOOL
  END_METHOD
END_INTERFACE
FUNCTION_BLOCK Drive IMPLEMENTS IMotor
VAR_INPUT Start : BOOL; END_VAR
  METHOD Start : BOOL
    Start := TRUE;
  END_METHOD
END_FUNCTION_BLOCK
`),
    ).toEqual([]);
  });
});

const PTR = `TYPE S : STRUCT x : INT; END_STRUCT END_TYPE
VAR_GLOBAL gs : S; gi : INT; END_VAR
FUNCTION FP : POINTER TO S
FP := ADR(gs);
END_FUNCTION
FUNCTION FR : REFERENCE TO INT
FR REF= gi;
END_FUNCTION
FUNCTION FS : S
END_FUNCTION
`;

describe("^ after a call", () => {
  it("is typed as the pointer's target and may be written", () => {
    expect(
      errorsOf(
        `${PTR}
PROGRAM Main
VAR a : INT; t : TIME; END_VAR
a := FP()^.x;
FP()^.x := 3;
t := FP()^.x;
END_PROGRAM
`,
        CALL_RESULTS,
      ),
    ).toEqual(["Cannot assign INT to TIME"]);
  });

  it("needs the feature call_result_access", () => {
    expect(
      errorsOf(`${PTR}
PROGRAM Main
VAR a : INT; END_VAR
a := FP()^.x;
END_PROGRAM
`),
    ).toEqual([
      "A dereference of a call result needs the feature call_result_access; assign the result to a variable first",
    ]);
  });

  it("is refused on a REFERENCE TO or a value result, and a write without ^ stays refused", () => {
    expect(
      errorsOf(
        `${PTR}
PROGRAM Main
VAR a : INT; END_VAR
a := FR()^;
a := FS()^.x;
FS().x := 1;
END_PROGRAM
`,
        CALL_RESULTS,
      ),
    ).toEqual([
      "A dereference of a call result needs a POINTER TO or REF_TO a named type, not a REFERENCE TO (dereferenced implicitly); assign the result to a variable first",
      "A dereference of a call result needs a POINTER TO or REF_TO a named type, not S; assign the result to a variable first",
      "A call result cannot be written: it is a temporary value; assign the result to a variable first",
    ]);
  });
});

const OOP = `INTERFACE I_M
  METHOD M : INT
  VAR_INPUT a : INT; END_VAR
  END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB_M IMPLEMENTS I_M
  METHOD M : INT
  VAR_INPUT a : INT; END_VAR
    M := a;
  END_METHOD
  METHOD Me : I_M
    Me := THIS^;
  END_METHOD
  METHOD Run
    THIS^.Me().M(1);
    THIS.Me().M('x');
  END_METHOD
END_FUNCTION_BLOCK
TYPE S : STRUCT f : FB_M; END_STRUCT END_TYPE
VAR_GLOBAL gs : S; END_VAR
FUNCTION GetI : I_M
GetI := gs.f;
END_FUNCTION
`;

describe("method calls on call results and through interface receivers", () => {
  for (const [label, options] of MODES) {
    it(`parses F().M(); and checks argument types on every receiver (${label})`, () => {
      expect(
        errorsOf(
          `${OOP}
PROGRAM Main
VAR fb : FB_M; x : INT; arr : ARRAY[1..2] OF I_M; END_VAR
GetI().M(1);
GetI().M('s1');
x := fb.Me().M('s2');
x := arr[1].M('s3');
x := gs.f.Me().M('s4');
END_PROGRAM
`,
          { ...options, features: ["+self_caret", "+bare_self_caret"] },
        ),
      ).toEqual(Array(5).fill("Cannot assign STRING to INT"));
    });
  }

  it("takes selectors after THIS^.M() in an expression", () => {
    expect(
      errorsOf(
        `TYPE S : STRUCT x : INT; END_STRUCT END_TYPE
FUNCTION_BLOCK FB
VAR t : TIME; n : INT; END_VAR
  METHOD GetS : S
  END_METHOD
  METHOD Run
    n := THIS^.GetS().x;
    t := THIS^.GetS().x;
  END_METHOD
END_FUNCTION_BLOCK
`,
        CALL_RESULTS,
      ),
    ).toEqual(["Cannot assign INT to TIME"]);
  });
});

describe("a method result through a scalar interface variable", () => {
  it("has the method's type, also stored in a FUNCTION's result", () => {
    expect(
      errorsOf(`TYPE E_St : (Idle, Busy); END_TYPE
INTERFACE I_S
  METHOD State : E_St
  END_METHOD
END_INTERFACE
FUNCTION F2 : INT
VAR_INPUT vi : I_S; END_VAR
VAR_IN_OUT vio : I_S; END_VAR
F2 := vi.State();
F2 := vio.State();
END_FUNCTION
PROGRAM Main
VAR one : I_S; n : INT; END_VAR
n := one.State();
END_PROGRAM
`),
    ).toEqual(Array(3).fill("Cannot assign E_ST to INT"));
  });
});

describe("a FUNCTION result is checked as a variable of its type", () => {
  for (const [label, options] of MODES) {
    it(`refuses what a local of that type refuses (${label})`, () => {
      expect(
        errorsOf(
          `TYPE E_St : (Idle, Busy); END_TYPE
TYPE S : STRUCT a : INT; END_STRUCT END_TYPE
FUNCTION F1 : INT
VAR t : TIME; e : E_St; END_VAR
F1 := t;
F1 := e;
F1 := 5;
END_FUNCTION
FUNCTION F2 : S
VAR s : S; t : TIME; END_VAR
F2 := s;
F2 := t;
END_FUNCTION
`,
          options,
        ),
      ).toEqual([
        "Cannot assign TIME to INT",
        "Cannot assign E_ST to INT",
        "Cannot assign TIME to S",
      ]);
    });
  }
});

describe("a FUNCTION result store C++ builds as it stands", () => {
  const SRC = `FUNCTION F : UDINT
VAR i : INT; END_VAR
F := i;
END_FUNCTION
FUNCTION G : INT
VAR c : CHAR; END_VAR
G := c;
END_FUNCTION
`;
  it("warns by default", () => {
    const r = compile(SRC, { headerFileName: "g.hpp" });
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((w) => w.message)).toEqual([
      "Cannot assign INT to UDINT",
      "Cannot assign CHAR to INT",
    ]);
  });

  it("is an error under iec-3 and --strict", () => {
    expect(errorsOf(SRC, { dialect: "iec-3" })).toEqual([
      "Cannot assign INT to UDINT",
      "Cannot assign CHAR to INT",
    ]);
    expect(errorsOf(SRC, { strict: true })).toEqual([
      "Implicit conversion from INT to UDINT is not allowed; use INT_TO_UDINT",
      "Cannot assign CHAR to INT",
    ]);
  });
});

describe("a METHOD result of POINTER TO type", () => {
  it("takes ADR as a FUNCTION result does", () => {
    expect(
      errorsOf(`TYPE S_R : STRUCT a : INT; END_STRUCT END_TYPE
FUNCTION_BLOCK FB
VAR s : S_R; END_VAR
  METHOD PS : POINTER TO S_R
    PS := ADR(s);
  END_METHOD
END_FUNCTION_BLOCK
`),
    ).toEqual([]);
  });
});

describe("properties: bits and POINTER TO values", () => {
  const PROP = `FUNCTION_BLOCK FB_P
VAR w : WORD; v : INT; END_VAR
  PROPERTY P : WORD
    GET P := w; END_GET
  END_PROPERTY
  PROPERTY Q : POINTER TO INT
    GET Q := ADR(v); END_GET
  END_PROPERTY
END_FUNCTION_BLOCK
`;
  it("reads a bit of a property and writes through a POINTER TO property", () => {
    expect(
      errorsOf(`${PROP}
PROGRAM Main
VAR fb : FB_P; b : BOOL; END_VAR
b := fb.P.4;
fb.Q^ := 3;
END_PROGRAM
`),
    ).toEqual([]);
  });

  it("refuses a bit written to a property without SET", () => {
    expect(
      errorsOf(`${PROP}
PROGRAM Main
VAR fb : FB_P; END_VAR
fb.P.4 := TRUE;
END_PROGRAM
`),
    ).toEqual(["Property 'P' of 'FB_P' is read-only (no SET accessor)."]);
  });
});

describe("a bit of a global constant in a STRUCT default", () => {
  it("is folded to its value", () => {
    const r = compile(
      `VAR_GLOBAL CONSTANT GC : WORD := 16#0018; END_VAR
TYPE S : STRUCT f1 : BOOL := GC.3; f2 : BOOL := GC.0; END_STRUCT END_TYPE
`,
      { headerFileName: "g.hpp" },
    );
    expect(r.errors).toEqual([]);
    expect(r.headerCode).toContain("IEC_BOOL F1 = true;");
    expect(r.headerCode).toContain("IEC_BOOL F2 = false;");
  });

  it("is refused when the constant's value is no integer literal", () => {
    expect(
      errorsOf(`VAR_GLOBAL CONSTANT GC : WORD := 16#10 OR 16#08; END_VAR
TYPE S : STRUCT f1 : BOOL := GC.3; END_STRUCT END_TYPE
`),
    ).toEqual([
      "The default of STRUCT field 'S.F1' reads bit 3 of 'GC', whose value is not an integer literal; use a BOOL constant instead",
    ]);
  });
});

describe("debug-table warnings", () => {
  it("are one per declaration, naming its places", () => {
    const r = compile(
      `INTERFACE I_A
END_INTERFACE
FUNCTION_BLOCK FB_X
VAR a : I_A; END_VAR
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Y
VAR xs : ARRAY[1..3] OF FB_X; one : FB_X; END_VAR
END_FUNCTION_BLOCK
PROGRAM Main
VAR ys : ARRAY[0..4] OF FB_Y; x : FB_X; END_VAR
END_PROGRAM
CONFIGURATION C
RESOURCE R ON PLC
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM P1 WITH T : Main;
PROGRAM P2 WITH T : Main;
END_RESOURCE
END_CONFIGURATION
`,
      { headerFileName: "g.hpp" },
    );
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((w) => w.message)).toEqual([
      "FB_X.A (in 6 places: P1.YS[*].XS[*].A, P1.YS[*].ONE.A and 4 more) is not debuggable: an interface reference (I_A) holds an address, which the debugger cannot show or write.",
    ]);
  });
});
