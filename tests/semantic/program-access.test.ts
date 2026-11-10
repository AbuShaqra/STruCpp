/**
 * Reaching a PROGRAM by name from another POU (feature program_methods): its
 * methods and actions, its variables and its body. A program has one instance,
 * so these name it from anywhere; without the feature each stays refused.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const ON = { features: ["+program_methods"] };

const lines = (r: ReturnType<typeof compile>): string[] =>
  r.errors.map((e) => `${e.line}:${e.column}: ${e.message}`);

// Lines 1-17.
const PRG = `PROGRAM PRG_A
VAR_INPUT inp : INT; END_VAR
VAR_OUTPUT done : BOOL; END_VAR
VAR cnt : INT; END_VAR
VAR CONSTANT lim : INT := 9; END_VAR
VAR_TEMP tmp : INT; END_VAR
METHOD Bump : INT
VAR_INPUT k : INT; END_VAR
  cnt := cnt + k;
  Bump := cnt;
END_METHOD
METHOD PRIVATE Hidden
END_METHOD
  cnt := cnt + inp;
  done := cnt > lim;
  ACTION Reset: cnt := 0; END_ACTION
END_PROGRAM
`;

describe("reaching a PROGRAM by name with program_methods", () => {
  it("calls its methods and actions and reads its variables from MAIN, an FB, a FUNCTION and an FB method", () => {
    const src = `${PRG}PROGRAM MAIN
VAR x : INT; b : BOOL; END_VAR
  x := PRG_A.Bump(k := 5);
  PRG_A.Bump(1);
  PRG_A.Reset();
  x := PRG_A.cnt + PRG_A.inp + PRG_A.lim;
  b := PRG_A.done;
END_PROGRAM
FUNCTION_BLOCK FB_R
VAR_OUTPUT seen : INT; END_VAR
METHOD Peek : INT
  Peek := PRG_A.cnt;
END_METHOD
  seen := PRG_A.cnt;
END_FUNCTION_BLOCK
FUNCTION F : INT
  F := PRG_A.Bump(k := 2);
END_FUNCTION
`;
    expect(lines(compile(src, ON))).toEqual([]);
  });

  it("writes its VAR_INPUT and VAR, and captures into them with =>", () => {
    const src = `${PRG}FUNCTION_BLOCK Src
VAR_OUTPUT q : INT; END_VAR
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR s : Src; END_VAR
  PRG_A.inp := 3;
  PRG_A.cnt := 0;
  s(q => PRG_A.cnt);
END_PROGRAM
`;
    expect(lines(compile(src, ON))).toEqual([]);
  });

  it("refuses writing its VAR_OUTPUT or a CONSTANT", () => {
    const src = `${PRG}PROGRAM MAIN
  PRG_A.done := TRUE;
  PRG_A.lim := 1;
END_PROGRAM
`;
    expect(lines(compile(src, ON))).toEqual([
      "19:3: VAR_OUTPUT 'DONE' of PROGRAM PRG_A is read-only outside PRG_A",
      "20:3: Cannot assign to CONSTANT variable 'PRG_A.LIM'",
    ]);
  });

  it("refuses VAR_TEMP, an unknown member and an unknown method", () => {
    const src = `${PRG}PROGRAM MAIN
VAR x : INT; END_VAR
  x := PRG_A.tmp;
  x := PRG_A.nope;
  PRG_A.Missing();
END_PROGRAM
`;
    expect(lines(compile(src, ON))).toEqual([
      "20:8: VAR_TEMP 'TMP' of PROGRAM PRG_A cannot be reached from another POU",
      "21:8: PROGRAM PRG_A has no variable 'NOPE'",
      "22:3: PROGRAM PRG_A has no method or action 'MISSING'",
    ]);
  });

  it("refuses a PRIVATE method from outside", () => {
    const src = `${PRG}PROGRAM MAIN
  PRG_A.Hidden();
END_PROGRAM
`;
    expect(lines(compile(src, ON))).toEqual([
      "19:3: Cannot call PRIVATE method 'HIDDEN' of 'PRG_A' from outside 'PRG_A'.",
    ]);
  });

  it("type-checks a reached variable and a method's result", () => {
    const src = `${PRG}PROGRAM MAIN
VAR s : STRING; END_VAR
  s := PRG_A.cnt;
  s := PRG_A.Bump(1);
END_PROGRAM
`;
    expect(lines(compile(src, ON))).toEqual([
      "20:8: Cannot assign INT to STRING",
      "21:8: Cannot assign INT to STRING",
    ]);
  });

  it("calls the program body as a statement, with inputs and outputs", () => {
    const src = `${PRG}PROGRAM MAIN
VAR b : BOOL; END_VAR
  PRG_A();
  PRG_A(inp := 2, done => b);
  PRG_A(4);
END_PROGRAM
`;
    expect(lines(compile(src, ON))).toEqual([]);
  });

  it("refuses a body call with a wrong parameter or inside an expression", () => {
    const src = `${PRG}PROGRAM MAIN
VAR b : BOOL; x : INT; END_VAR
  PRG_A(cnt := 2);
  PRG_A(inp => x);
  PRG_A(1, 2);
  x := PRG_A();
END_PROGRAM
`;
    expect(lines(compile(src, ON))).toEqual([
      "20:3: PROGRAM PRG_A has no VAR_INPUT 'CNT'",
      "21:3: PROGRAM PRG_A has no VAR_OUTPUT 'INP'",
      "22:3: too many arguments in the call of PROGRAM PRG_A",
      "23:8: PROGRAM PRG_A has no result: call it as a statement",
    ]);
  });

  it("refuses a program calling its own body", () => {
    const src = `PROGRAM PRG_A
VAR n : INT; END_VAR
  n := n + 1;
  PRG_A();
END_PROGRAM
`;
    expect(lines(compile(src))).toEqual([
      "4:3: PROGRAM PRG_A cannot call itself",
    ]);
  });

  it("refuses a variable of the program's type once the program is reached", () => {
    const src = `${PRG}PROGRAM MAIN
VAR p : PRG_A; END_VAR
  PRG_A.Reset();
END_PROGRAM
`;
    expect(lines(compile(src, ON))).toEqual([
      "19:5: PROGRAM PRG_A has one instance, reached by name from other POUs; P cannot declare another",
    ]);
  });

  it("keeps a variable of the program's type when nothing reaches the program", () => {
    const src = `${PRG}PROGRAM MAIN
VAR p : PRG_A; END_VAR
END_PROGRAM
`;
    expect(lines(compile(src, ON))).toEqual([]);
  });

  it("refuses two CONFIGURATION instances of a reached program", () => {
    const src = `${PRG}PROGRAM MAIN
  PRG_A.Reset();
END_PROGRAM
CONFIGURATION C
  RESOURCE R ON PLC
    TASK T(INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM I1 WITH T : PRG_A;
    PROGRAM I2 WITH T : PRG_A;
    PROGRAM M WITH T : MAIN;
  END_RESOURCE
END_CONFIGURATION
`;
    const found = lines(compile(src, ON));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(
      /^25:\d+: PROGRAM PRG_A has one instance, reached by name from other POUs; the CONFIGURATION cannot run it as both I1 and I2$/,
    );
  });

  it("keeps two CONFIGURATION instances of a program nobody reaches", () => {
    const src = `${PRG}CONFIGURATION C
  RESOURCE R ON PLC
    TASK T(INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM I1 WITH T : PRG_A;
    PROGRAM I2 WITH T : PRG_A;
  END_RESOURCE
END_CONFIGURATION
`;
    expect(lines(compile(src, ON))).toEqual([]);
  });

  it("a local variable named like the program shadows it", () => {
    const src = `${PRG}TYPE S : STRUCT cnt : INT; END_STRUCT; END_TYPE
PROGRAM MAIN
VAR PRG_A : S; x : INT; END_VAR
  x := PRG_A.cnt;
END_PROGRAM
`;
    expect(lines(compile(src, ON))).toEqual([]);
  });
});

describe("reaching a PROGRAM by name without program_methods", () => {
  const ACT = `PROGRAM PRG_A
VAR cnt : INT; END_VAR
  cnt := cnt + 1;
  ACTION Reset: cnt := 0; END_ACTION
END_PROGRAM
`;
  for (const [mode, opts] of [
    ["no flag", {}],
    ["iec-3", { dialect: "iec-3" }],
  ] as const) {
    it(`refuses a variable, an action and the body (${mode})`, () => {
      const src = `${ACT}PROGRAM MAIN
VAR x : INT; END_VAR
  x := PRG_A.cnt;
  PRG_A.Reset();
  PRG_A();
END_PROGRAM
`;
      expect(lines(compile(src, opts))).toEqual([
        "8:8: Cannot access members of program 'PRG_A' directly — declare a variable of type 'PRG_A' first.",
        "9:3: the methods and actions of PROGRAM PRG_A can be called only inside PRG_A",
        "10:3: a call of PROGRAM PRG_A from another POU needs the feature program_methods",
      ]);
    });
  }
});

describe("a PROGRAM naming its own members (PRG_A.x inside PRG_A)", () => {
  /** PRG_A using its members with the prefix `p` (`PRG_A.` or none). Lines 1-25. */
  const self = (
    p: string,
  ): string => `TYPE ST : STRUCT a : INT; END_STRUCT END_TYPE
VAR_GLOBAL g : INT; END_VAR
FUNCTION_BLOCK FB_T
VAR_INPUT i : BOOL; END_VAR VAR_OUTPUT q : BOOL; END_VAR
  q := i;
END_FUNCTION_BLOCK
PROGRAM PRG_A
VAR_EXTERNAL g : INT; END_VAR
VAR_INPUT inp : INT; END_VAR
VAR x : INT; s : ST; arr : ARRAY[0..2] OF INT; t : FB_T; r : INT; END_VAR
VAR CONSTANT c : INT := 3; END_VAR
METHOD M
  ${p}x := ${p}x + 1;
END_METHOD
  ${p}x := ${p}inp + ${p}c;
  ${p}s.a := ${p}arr[1];
  ${p}t(i := TRUE);
  ${p}r := ${p}g;
  IF ${p}t.q THEN M(); END_IF
  ACTION Act: ${p}r := ${p}s.a; END_ACTION
END_PROGRAM
`;

  it("accepts members, STRUCT fields, array elements, FB calls and externals in the body, a method and an action", () => {
    expect(lines(compile(self("PRG_A."), ON))).toEqual([]);
  });

  it("emits the same C++ as the plain member names", () => {
    const a = compile(self("PRG_A."), ON);
    const b = compile(self(""), ON);
    expect(b.errors).toEqual([]);
    expect(a.cppCode).toBe(b.cppCode);
    expect(a.headerCode).toBe(b.headerCode);
  });

  it("still refuses a write to a CONSTANT member", () => {
    const src = `PROGRAM PRG_A
VAR CONSTANT c : INT := 3; END_VAR
  PRG_A.c := 4;
END_PROGRAM
`;
    expect(lines(compile(src, ON))).toEqual([
      "3:3: Cannot assign to CONSTANT variable 'C'",
    ]);
  });

  it("refuses PRG_A.x without the feature", () => {
    const src = `PROGRAM PRG_A
VAR x : INT; END_VAR
  PRG_A.x := 1;
END_PROGRAM
`;
    for (const r of [compile(src), compile(src, { dialect: "iec-3" })]) {
      expect(lines(r)).toEqual([
        "3:3: Cannot access members of program 'PRG_A' directly — declare a variable of type 'PRG_A' first.",
      ]);
    }
  });
});
