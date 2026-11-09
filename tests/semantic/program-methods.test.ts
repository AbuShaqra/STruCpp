/**
 * METHODs in a PROGRAM are the dialect feature program_methods: refused with
 * no dialect flag and under `iec-3` (at the METHOD line), accepted with
 * `--feature +program_methods` or a profile that has it. Strict mode is a
 * separate axis. A program's methods are callable inside the program and, by
 * the program's name, from any other POU (see program-access.test.ts).
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { nodeDialectIO } from "../../src/node/dialect-io.js";

const GOOD = "tests/fixtures/dialects/good";
const REFUSAL = "METHOD in a PROGRAM needs the feature program_methods";
const ON = { features: ["+program_methods"] };

// The METHOD keyword is on line 5, column 1.
const SRC = `PROGRAM MAIN
VAR
  n : INT;
END_VAR
METHOD Count
  n := n + 1;
END_METHOD
  Count();
END_PROGRAM
`;

const lines = (r: ReturnType<typeof compile>): string[] =>
  r.errors.map((e) => `${e.line}:${e.column}: ${e.message}`);

describe("the feature program_methods", () => {
  it("refused without the feature, at the METHOD line (no flag)", () => {
    const result = compile(SRC);
    expect(lines(result)).toEqual([`5:1: ${REFUSAL}`]);
    expect(result.success).toBe(false);
  });

  it("refused without the feature, at the METHOD line (iec-3)", () => {
    const result = compile(SRC, { dialect: "iec-3" });
    expect(lines(result)).toEqual([`5:1: ${REFUSAL}`]);
    expect(result.success).toBe(false);
  });

  it("each refused METHOD is reported at its own line", () => {
    const src = `PROGRAM MAIN
VAR n : INT; END_VAR
METHOD One
  n := 1;
END_METHOD
VAR m : INT; END_VAR
  METHOD Two
  m := 2;
END_METHOD
  One();
END_PROGRAM
`;
    expect(lines(compile(src, { dialect: "iec-3" }))).toEqual([
      `3:1: ${REFUSAL}`,
      `7:3: ${REFUSAL}`,
    ]);
  });

  it("accepted with --feature +program_methods", () => {
    expect(compile(SRC, ON).errors).toEqual([]);
    expect(compile(SRC, { dialect: "iec-3", ...ON }).errors).toEqual([]);
  });

  it("accepted under vendor-a from --dialect-path", () => {
    const result = compile(SRC, {
      dialect: "vendor-a",
      dialectPath: [GOOD],
      dialectIO: nodeDialectIO,
    });
    expect(result.errors).toEqual([]);
  });

  it("the refusal under iec-3 names (profiles: vendor-a)", () => {
    const result = compile(SRC, {
      dialect: "iec-3",
      dialectPath: [GOOD],
      dialectIO: nodeDialectIO,
    });
    expect(lines(result)).toEqual([`5:1: ${REFUSAL} (profiles: vendor-a)`]);
  });

  it("strict mode does not change it", () => {
    expect(lines(compile(SRC, { strict: true }))).toEqual([`5:1: ${REFUSAL}`]);
    expect(lines(compile(SRC, { strict: true, dialect: "iec-3" }))).toEqual([
      `5:1: ${REFUSAL}`,
    ]);
    expect(compile(SRC, { strict: true, ...ON }).errors).toEqual([]);
    expect(
      compile(SRC, { strict: true, dialect: "iec-3", ...ON }).errors,
    ).toEqual([]);
  });

  it("a PROGRAM without methods is untouched under iec-3", () => {
    const src = `PROGRAM MAIN
VAR n : INT; END_VAR
  n := n + 1;
END_PROGRAM
`;
    expect(compile(src, { dialect: "iec-3" }).errors).toEqual([]);
  });

  it("FUNCTION_BLOCK methods need no feature", () => {
    const src = `FUNCTION_BLOCK Fb
VAR n : INT; END_VAR
METHOD Count
  n := n + 1;
END_METHOD
  Count();
END_FUNCTION_BLOCK
`;
    expect(compile(src, { dialect: "iec-3" }).errors).toEqual([]);
  });

  it("a refused program method called from the body gives exactly one error", () => {
    const src = `PROGRAM MAIN
VAR n : INT; END_VAR
METHOD Count : INT
VAR_INPUT inc : INT; END_VAR
  n := n + inc;
  Count := n;
END_METHOD
  Count(inc := 1);
  n := Count(2) + 1;
END_PROGRAM
`;
    expect(lines(compile(src))).toEqual([`3:1: ${REFUSAL}`]);
    expect(lines(compile(src, { strict: true }))).toEqual([`3:1: ${REFUSAL}`]);
  });
});

describe("program methods with the feature on", () => {
  it("a method sees the program's VARs", () => {
    const src = `PROGRAM MAIN
VAR
  n : INT;
  speeds : ARRAY[1..3] OF REAL;
END_VAR
VAR_TEMP t : INT; END_VAR
METHOD Fill
VAR i : INT; END_VAR
  FOR i := 1 TO 3 DO
    speeds[i] := INT_TO_REAL(n);
  END_FOR
  n := n + t;
END_METHOD
  Fill();
END_PROGRAM
`;
    expect(compile(src, ON).errors).toEqual([]);
  });

  it("an undeclared name in a program method is still reported", () => {
    const src = `PROGRAM MAIN
VAR n : INT; END_VAR
METHOD Count
  n := zz;
END_METHOD
  Count();
END_PROGRAM
`;
    const result = compile(src, ON);
    const found = lines(result);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^4:\d+: .*zz/i);
    // Located in the method's own body, under the program's name.
    expect(result.errors[0]).toMatchObject({
      pouName: "MAIN",
      pouKind: "PROGRAM",
      section: "body",
      bodyLine: 1,
    });
  });

  it("Name() from the body resolves", () => {
    const src = `PROGRAM MAIN
VAR n : INT; d : DINT; END_VAR
METHOD Count
  n := n + 1;
END_METHOD
METHOD Twice : DINT
VAR_INPUT x : DINT; END_VAR
  Twice := x * 2;
END_METHOD
  Count();
  d := Twice(d);
  d := Twice(x := d) + 1;
END_PROGRAM
`;
    expect(compile(src, ON).errors).toEqual([]);
    expect(compile(src, { strict: true, ...ON }).errors).toEqual([]);
  });

  it("a method call resolves to the method's return type and inputs (strict)", () => {
    const src = `PROGRAM MAIN
VAR i : INT; d : DINT; END_VAR
METHOD Twice : DINT
VAR_INPUT x : INT; END_VAR
  Twice := x * 2;
END_METHOD
  i := Twice(i);
  d := Twice(d);
END_PROGRAM
`;
    expect(lines(compile(src, { strict: true, ...ON }))).toEqual([
      "7:8: Implicit conversion from DINT to INT is not allowed; use DINT_TO_INT",
      "8:14: Implicit conversion from DINT to INT is not allowed; use DINT_TO_INT",
    ]);
  });

  it("a method calls another method of the same program", () => {
    const src = `PROGRAM MAIN
VAR n : INT; END_VAR
METHOD Inc
  n := n + 1;
END_METHOD
METHOD IncTwice
  Inc();
  Inc();
END_METHOD
  IncTwice();
END_PROGRAM
`;
    expect(compile(src, ON).errors).toEqual([]);
  });

  it("strict checks apply inside a program method", () => {
    const src = `PROGRAM MAIN
VAR i : INT; END_VAR
METHOD Narrow
VAR d : DINT; END_VAR
  i := d;
END_METHOD
  Narrow();
END_PROGRAM
`;
    expect(lines(compile(src, { strict: true, ...ON }))).toEqual([
      "5:8: Implicit conversion from DINT to INT is not allowed; use DINT_TO_INT",
    ]);
    expect(compile(src, ON).errors).toEqual([]);
  });

  it("an inline-type VAR in a program method is lowered", () => {
    const src = `PROGRAM MAIN
VAR n : INT; END_VAR
METHOD Step
VAR
  mode : (Idle, Running) := Idle;
  buf : ARRAY[0..2] OF INT;
END_VAR
  IF mode = Idle THEN
    mode := Running;
  END_IF
  buf[0] := n;
END_METHOD
  Step();
END_PROGRAM
`;
    const result = compile(src, ON);
    expect(result.errors).toEqual([]);
  });

  it("an ABSTRACT or OVERRIDE program method is refused", () => {
    const src = `PROGRAM MAIN
METHOD ABSTRACT One
END_METHOD
METHOD OVERRIDE Two
END_METHOD
END_PROGRAM
`;
    const found = compile(src, ON).errors.map((e) => e.line);
    expect(found).toEqual([2, 4]);
  });
});

describe("who may call a program's methods (C12)", () => {
  const MAIN = `PROGRAM MAIN
VAR n : INT; END_VAR
METHOD Count
  n := n + 1;
END_METHOD
METHOD Value : INT
  Value := n;
END_METHOD
  Count();
END_PROGRAM
`;
  const MSG =
    "the methods and actions of PROGRAM MAIN can be called only inside MAIN";

  it("MAIN.Name() from a FUNCTION_BLOCK reaches MAIN's one instance", () => {
    const src = `${MAIN}FUNCTION_BLOCK Fb
VAR x : INT; END_VAR
  MAIN.Count();
  x := MAIN.Value();
END_FUNCTION_BLOCK
`;
    expect(lines(compile(src, ON))).toEqual([]);
  });

  it("MAIN.Name() from another PROGRAM, a FUNCTION and an FB method is allowed", () => {
    const src = `${MAIN}PROGRAM Other
  MAIN.Count();
END_PROGRAM
FUNCTION F : INT
  F := MAIN.Value();
END_FUNCTION
FUNCTION_BLOCK Fb
METHOD M
  IF MAIN.Value() > 0 THEN
    MAIN.Count();
  END_IF
END_METHOD
END_FUNCTION_BLOCK
`;
    expect(lines(compile(src, ON))).toEqual([]);
  });

  it("a call through a program-typed instance in another POU is refused (R16)", () => {
    const src = `${MAIN}FUNCTION_BLOCK Fb
VAR p : MAIN; END_VAR
  p.Count();
END_FUNCTION_BLOCK
`;
    expect(lines(compile(src, ON))).toEqual([`13:3: ${MSG}`]);
  });

  it("inside MAIN, its body and its methods may call them", () => {
    const src = `PROGRAM MAIN
VAR n : INT; END_VAR
METHOD Count
  n := n + 1;
END_METHOD
METHOD Twice
  Count();
  Count();
END_METHOD
  Count();
  Twice();
END_PROGRAM
`;
    expect(compile(src, ON).errors).toEqual([]);
  });

  it("a name that is not one of MAIN's methods is not this error", () => {
    const src = `${MAIN}FUNCTION_BLOCK Fb
VAR x : INT; END_VAR
  x := 1;
END_FUNCTION_BLOCK
`;
    expect(compile(src, ON).errors).toEqual([]);
  });
});
