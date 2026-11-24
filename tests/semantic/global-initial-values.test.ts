/**
 * Global initial values: what an iec-3 / --strict constant expression reads,
 * the order a method call on a global FB imposes, the type check every
 * elementary global's initial value gets (as a POU variable's), and
 * VAR_EXTERNAL CONSTANT without an initial value.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const located = (r: ReturnType<typeof compile>): string[] =>
  r.errors.map((e) => `${e.line}:${e.column} ${e.message}`);

const refusal = (global: string, read: string): string =>
  `The initial value of global '${global}' reads global '${read}', which is no CONSTANT: an initial value is a constant expression`;

const STRICT_MODES = [
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
] as const;

const METHOD_CALL = `FUNCTION_BLOCK FB_A
VAR v : INT := 3; END_VAR
METHOD M : INT
M := v;
END_METHOD
END_FUNCTION_BLOCK
VAR_GLOBAL
  x : INT := f.M();
  f : FB_A;
END_VAR
PROGRAM Main VAR n : INT; END_VAR n := x; END_PROGRAM
`;

describe("global initial values", () => {
  it("accept a dereference inside ADR, and a method call on an FB global, with no dialect flag", () => {
    expect(
      compile(`VAR_GLOBAL x : INT := 5; p : POINTER TO INT := ADR(x);
pa : POINTER TO ARRAY[1..3] OF INT; q1 : POINTER TO INT := ADR(p^); q2 : POINTER TO INT := ADR(pa^[1]); END_VAR
PROGRAM Main VAR n : INT; END_VAR n := q1^; END_PROGRAM
`).errors,
    ).toEqual([]);
    expect(compile(METHOD_CALL).errors).toEqual([]);
  });

  it("emit a global calling a method of an FB global after it", () => {
    const r = compile(METHOD_CALL);
    expect(r.errors).toEqual([]);
    const f = r.headerCode.indexOf("FB_A F{}");
    const x = r.headerCode.indexOf("IEC_INT X = F.M()");
    expect(f).toBeGreaterThan(0);
    expect(x).toBeGreaterThan(f);
  });

  for (const [label, options] of STRICT_MODES) {
    it(`refuse a dereference of a non-CONSTANT pointer inside ADR (${label})`, () => {
      expect(
        located(
          compile(
            `VAR_GLOBAL x : INT := 5; p : POINTER TO INT := ADR(x);
pa : POINTER TO ARRAY[1..3] OF INT; q1 : POINTER TO INT := ADR(p^); q2 : POINTER TO INT := ADR(pa^[1]); END_VAR
PROGRAM Main VAR n : INT; END_VAR n := q1^; END_PROGRAM
`,
            { ...options, features: ["+pointer_to"] },
          ),
        ),
      ).toEqual([`2:64 ${refusal("Q1", "P")}`, `2:96 ${refusal("Q2", "PA")}`]);
    });

    it(`refuse a dereference of a non-CONSTANT reference inside REF (${label})`, () => {
      expect(
        located(
          compile(
            `VAR_GLOBAL x : INT := 5; r : REF_TO INT := REF(x); r2 : REF_TO INT := REF(r^); END_VAR
PROGRAM Main VAR n : INT; END_VAR n := r2^; END_PROGRAM
`,
            options,
          ),
        ),
      ).toEqual([`1:75 ${refusal("R2", "R")}`]);
    });

    it(`refuse a method call on a non-CONSTANT FB global (${label})`, () => {
      expect(located(compile(METHOD_CALL, options))).toEqual([
        `8:14 ${refusal("X", "F")}`,
      ]);
    });

    it(`accept standard functions with named arguments in any order (${label})`, () => {
      expect(
        compile(
          `VAR_GLOBAL CONSTANT d : DINT := 1; END_VAR
VAR_GLOBAL arr : ARRAY[1..3] OF INT; m2 : ARRAY[1..3, 0..5] OF INT;
u1 : DINT := UPPER_BOUND(DIM := d, ARR := arr);
u2 : DINT := LOWER_BOUND(DIM := 2, ARR := m2);
u3 : DINT := UPPER_BOUND(DIM := d + 1, ARR := m2);
l1 : INT := LIMIT(MX := 10, IN := 5, MN := 0);
s1 : INT := SEL(IN1 := 3, G := TRUE, IN0 := 2);
x1 : INT := MUX(IN1 := 3, K := 0, IN0 := 2);
m1 : INT := MAX(IN2 := 3, IN1 := 4);
END_VAR
PROGRAM Main VAR n : DINT; END_VAR n := u1 + u2 + u3; END_PROGRAM
`,
          options,
        ).errors,
      ).toEqual([]);
    });

    it(`report a duplicate RESOURCE global once, not as a non-CONSTANT read (${label})`, () => {
      const config = (outer: string, inner: string): string =>
        `VAR_GLOBAL CONSTANT k : INT := 1; END_VAR
CONFIGURATION C
${outer}
RESOURCE R ON PLC
${inner}
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM I WITH T : Main;
END_RESOURCE
END_CONFIGURATION
PROGRAM Main END_PROGRAM
`;
      const messages = (src: string): string[] =>
        compile(src, options).errors.map((e) => e.message);
      expect(
        messages(
          config(
            "",
            "VAR_GLOBAL CONSTANT a : INT := 1; END_VAR VAR_GLOBAL a : INT := 2; b : INT := a; END_VAR",
          ),
        ),
      ).toEqual(["Symbol 'A' already defined in scope 'C.R'"]);
      expect(
        messages(
          config(
            "VAR_GLOBAL CONSTANT a : INT := 1; END_VAR",
            "VAR_GLOBAL a : INT := 2; b : INT := a; END_VAR",
          ),
        ),
      ).toEqual([
        "Global 'A' of RESOURCE 'R' is also declared by CONFIGURATION 'C'; the globals of a configuration and its resources need distinct names",
      ]);
      expect(
        messages(config("", "VAR_GLOBAL k : INT := 2; b : INT := k; END_VAR")),
      ).toEqual([
        "Global 'K' of CONFIGURATION C is also declared in a top-level VAR_GLOBAL; rename one of them",
      ]);
    });
  }
});

describe("a call in a global's initial value", () => {
  const FBS = `INTERFACE I_A
METHOD M : INT
END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB_A IMPLEMENTS I_A
METHOD M : INT
M := gy;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_I
VAR it : I_A; END_VAR
METHOD M : INT
M := it.M();
END_METHOD
END_FUNCTION_BLOCK
`;

  it("creates the global after the globals the called method reads", () => {
    const r =
      compile(`${FBS}VAR_GLOBAL x : INT := f.M(); f : FB_A; gy : INT := 4; END_VAR
PROGRAM Main END_PROGRAM
`);
    expect(r.errors).toEqual([]);
    expect(r.headerCode.indexOf("IEC_INT X = F.M()")).toBeGreaterThan(
      r.headerCode.indexOf("IEC_INT GY = 4"),
    );
  });

  it("refuses a call whose reads cannot be followed", () => {
    expect(
      located(
        compile(`${FBS}VAR_GLOBAL
  z : INT := fi.M();
  w : INT := pa^.M();
  i : I_A := f;
  v : INT := i.M();
  f : FB_A; fi : FB_I; pa : POINTER TO FB_A := ADR(f); gy : INT := 4;
END_VAR
PROGRAM Main END_PROGRAM
`),
      ),
    ).toEqual([
      "17:14 The initial value of global 'Z' leads to a call through an interface (line 13), whose reads of other globals cannot be followed: the globals cannot be created in a known order; assign 'Z' in a program instead",
      "18:14 The initial value of global 'W' leads to a call through a pointer or reference (line 18), whose reads of other globals cannot be followed: the globals cannot be created in a known order; assign 'W' in a program instead",
      "20:14 The initial value of global 'V' leads to a call through an interface (line 20), whose reads of other globals cannot be followed: the globals cannot be created in a known order; assign 'V' in a program instead",
    ]);
  });

  it("refuses a call that reads the global itself", () => {
    expect(
      located(
        compile(`${FBS}FUNCTION_BLOCK FB_S
METHOD M : INT
M := xs;
END_METHOD
END_FUNCTION_BLOCK
VAR_GLOBAL xs : INT := fs.M(); fs : FB_S; END_VAR
PROGRAM Main END_PROGRAM
`),
      ),
    ).toEqual([
      "21:12 The initial value of global 'XS' reads 'XS' itself, through the code it calls",
    ]);
  });
});

describe("the type of a global's initial value", () => {
  const GLOBALS = `VAR_GLOBAL CONSTANT LC : LTIME := LTIME#2ms; END_VAR
VAR_GLOBAL
  t1 : TIME := LTIME#3ms;
  t2 : TIME := LC;
  d1 : DATE := LDATE#2020-01-01;
  r1 : REAL := LREAL#1.5;
  i1 : INT := DINT#7;
END_VAR
CONFIGURATION C
VAR_GLOBAL c1 : TIME := LTIME#3ms; END_VAR
RESOURCE R ON PLC
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM I WITH T : Main;
END_RESOURCE
END_CONFIGURATION
PROGRAM Main
VAR
  p1 : TIME := LTIME#3ms;
  p2 : TIME := LC;
  p3 : DATE := LDATE#2020-01-01;
  p4 : REAL := LREAL#1.5;
  p5 : INT := DINT#7;
END_VAR
END_PROGRAM
`;
  const diagnostics = (options: Parameters<typeof compile>[1]): string[] => {
    const r = compile(GLOBALS, options);
    return [
      ...r.errors.map((e) => `E ${e.line} ${e.message}`),
      ...r.warnings.map((w) => `W ${w.line} ${w.message}`),
    ];
  };

  it("is checked as a POU variable's is, with no dialect flag", () => {
    expect(diagnostics({})).toEqual([
      "E 3 Cannot assign LTIME to TIME",
      "E 4 Cannot assign LTIME to TIME",
      "E 5 Cannot assign LDATE to DATE",
      "E 10 Cannot assign LTIME to TIME",
      "E 18 Cannot assign LTIME to TIME",
      "E 19 Cannot assign LTIME to TIME",
      "E 20 Cannot assign LDATE to DATE",
      "W 6 Implicit narrowing conversion from LREAL to REAL",
      "W 7 Implicit narrowing conversion from DINT to INT",
      "W 21 Implicit narrowing conversion from LREAL to REAL",
      "W 22 Implicit narrowing conversion from DINT to INT",
    ]);
  });

  it("is checked as a POU variable's is, under --strict", () => {
    expect(diagnostics({ strict: true })).toEqual([
      "E 3 Cannot assign LTIME to TIME",
      "E 4 Cannot assign LTIME to TIME",
      "E 5 Cannot assign LDATE to DATE",
      "E 6 Implicit conversion from LREAL to REAL is not allowed; use LREAL_TO_REAL",
      "E 7 Implicit conversion from DINT to INT is not allowed; use DINT_TO_INT",
      "E 10 Cannot assign LTIME to TIME",
      "E 18 Cannot assign LTIME to TIME",
      "E 19 Cannot assign LTIME to TIME",
      "E 20 Cannot assign LDATE to DATE",
      "E 21 Implicit conversion from LREAL to REAL is not allowed; use LREAL_TO_REAL",
      "E 22 Implicit conversion from DINT to INT is not allowed; use DINT_TO_INT",
    ]);
  });

  it("leaves an address stored in an integer to its own check", () => {
    const r =
      compile(`VAR_GLOBAL x : INT; n : LWORD := ADR(x); s : UDINT := SIZEOF(x); END_VAR
PROGRAM Main END_PROGRAM
`);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});

describe("VAR_EXTERNAL CONSTANT", () => {
  for (const [label, options] of [
    ["no dialect flag", {}],
    ...STRICT_MODES,
  ] as const) {
    it(`takes no initial value: it names the global's (${label})`, () => {
      expect(
        compile(
          `VAR_GLOBAL CONSTANT K : INT := 7; END_VAR
PROGRAM Main
VAR_EXTERNAL CONSTANT K : INT; END_VAR
VAR y : INT; END_VAR
y := K;
END_PROGRAM
`,
          options,
        ).errors,
      ).toEqual([]);
    });
  }

  it("is still read-only", () => {
    expect(
      compile(`VAR_GLOBAL CONSTANT K : INT := 7; END_VAR
PROGRAM Main
VAR_EXTERNAL CONSTANT K : INT; END_VAR
K := 3;
END_PROGRAM
`).errors.length,
    ).toBeGreaterThan(0);
  });
});
