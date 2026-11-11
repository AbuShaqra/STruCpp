/**
 * Interface-typed variables: locals, FB members, inputs, outputs and globals
 * that refer to an instance of an implementing function block. Standard IEC
 * (interface variables), so accepted in every dialect. Covers assignment from
 * an implementing or derived instance, from another interface variable and
 * NULL, equality with NULL and between interface variables, method calls
 * through the variable, and the positioned refusals.
 */
import { describe, it, expect } from "vitest";
import { analyze, compile } from "../../src/index.js";

type Options = Parameters<typeof compile>[1];

const MODES: { name: string; options: Options }[] = [
  { name: "no dialect", options: {} },
  { name: "iec-3", options: { dialect: "iec-3" } },
];

const TYPES = `INTERFACE IA
METHOD GetA : INT
END_METHOD
END_INTERFACE
INTERFACE IB
METHOD GetB : INT
END_METHOD
END_INTERFACE
INTERFACE IC EXTENDS IA, IB
METHOD GetC : INT
END_METHOD
END_INTERFACE
INTERFACE IX
METHOD GetX : INT
END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB_A IMPLEMENTS IA
VAR n : INT := 1; END_VAR
METHOD GetA : INT
  GetA := n;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_A2 EXTENDS FB_A
METHOD OVERRIDE GetA : INT
  GetA := 100 + n;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_C IMPLEMENTS IC
METHOD GetA : INT
  GetA := 10;
END_METHOD
METHOD GetB : INT
  GetB := 20;
END_METHOD
METHOD GetC : INT
  GetC := 30;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Plain
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_User
VAR_INPUT src : IA; END_VAR
VAR_OUTPUT last : IA; END_VAR
VAR PUBLIC held : IA; END_VAR
VAR v : INT; END_VAR
METHOD Take : INT
VAR_INPUT x : IA; END_VAR
VAR tmp : IA; END_VAR
  tmp := x;
  Take := tmp.GetA();
END_METHOD
  held := src;
  last := held;
  IF held <> NULL THEN
    v := held.GetA();
  END_IF;
END_FUNCTION_BLOCK
FUNCTION ReadA : INT
VAR_INPUT x : IA; END_VAR
  IF x = NULL THEN
    ReadA := -1;
  ELSE
    ReadA := x.GetA();
  END_IF;
END_FUNCTION
VAR_GLOBAL
  gItf : IA;
END_VAR
`;

/** Line of the first body statement in {@link program}. */
const BODY_LINE = TYPES.split("\n").length + 6;

function program(body: string): string {
  return `${TYPES}PROGRAM MAIN
VAR_EXTERNAL gItf : IA; END_VAR
VAR
  a : FB_A; a2 : FB_A2; c : FB_C; p : FB_Plain; u : FB_User;
  ia : IA; ib : IB; ic : IC; ix : IX; r : INT; b : BOOL;
END_VAR
${body}
END_PROGRAM
`;
}

function messages(source: string, options: Options = {}): string[] {
  return compile(source, options).errors.map(
    (e) => `${e.line}:${e.column} ${e.message}`,
  );
}

const ACCEPTED = `ia := a;
ia := a2;
ia := c;
ic := c;
ia := ic;
ib := ic;
ia := NULL;
b := ia = NULL;
b := ia <> NULL;
b := ia = ic;
b := ia = gItf;
IF ia <> NULL THEN r := ia.GetA(); END_IF;
r := ic.GetB() + ic.GetA();
gItf := a2;
r := gItf.GetA();
u(src := a);
u(src := ic);
ia := u.last;
r := u.Take(a2);
r := u.Take(x := ic);
r := ReadA(a);
r := ReadA(x := ia);
r := u.held.GetA();`;

describe("interface-typed variables are accepted", () => {
  for (const mode of MODES) {
    it(`every form, ${mode.name}`, () => {
      const source = program(ACCEPTED);
      expect(messages(source, mode.options)).toEqual([]);
      expect(analyze(source, mode.options).errors).toEqual([]);
    });
  }

  it("THIS passed into an interface-typed input", () => {
    const source = `${TYPES}FUNCTION_BLOCK FB_Self IMPLEMENTS IA
VAR u : FB_User; END_VAR
METHOD GetA : INT
  GetA := 7;
END_METHOD
  u(src := THIS);
END_FUNCTION_BLOCK
`;
    for (const mode of MODES) {
      expect(messages(source, mode.options)).toEqual([]);
    }
  });

  it("an interface variable inherited through a base FB's IMPLEMENTS", () => {
    const source = `${TYPES}FUNCTION_BLOCK FB_Sub EXTENDS FB_A
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR s : FB_Sub; ia : IA; END_VAR
  ia := s;
END_PROGRAM
`;
    expect(messages(source, { dialect: "iec-3" })).toEqual([]);
  });

  it("a NULL initializer", () => {
    const source = `${TYPES}PROGRAM MAIN
VAR ia : IA := NULL; END_VAR
END_PROGRAM
`;
    expect(messages(source, { dialect: "iec-3" })).toEqual([]);
  });
});

describe("interface-typed variables: refusals", () => {
  for (const mode of MODES) {
    it(`an FB that does not implement the interface, ${mode.name}`, () => {
      expect(messages(program("ia := p;"), mode.options)).toEqual([
        `${BODY_LINE}:7 Cannot assign FB_PLAIN to IA: FB_PLAIN does not implement IA`,
      ]);
    });
  }

  it("an FB implementing only a base of the target interface", () => {
    expect(messages(program("ic := a;"), { dialect: "iec-3" })).toEqual([
      `${BODY_LINE}:7 Cannot assign FB_A to IC: FB_A does not implement IC`,
    ]);
  });

  // Narrows only the check: an interface local never built before this step.
  it("an unrelated interface", () => {
    expect(messages(program("ix := ia;"), { dialect: "iec-3" })).toEqual([
      `${BODY_LINE}:7 Cannot assign IA to IX: IA does not extend IX`,
    ]);
  });

  it("a base interface into an extending one", () => {
    expect(messages(program("ic := ia;"), { dialect: "iec-3" })).toEqual([
      `${BODY_LINE}:7 Cannot assign IA to IC: IA does not extend IC`,
    ]);
  });

  // Narrows only the check: an interface local never built before this step.
  it("a number", () => {
    expect(messages(program("ia := 5;"), { dialect: "iec-3" })).toEqual([
      `${BODY_LINE}:7 Cannot assign INT to IA`,
    ]);
  });

  it("an FB that does not implement the interface into an input", () => {
    expect(messages(program("u(src := p);"), { dialect: "iec-3" })).toEqual([
      `${BODY_LINE}:10 Cannot assign FB_PLAIN to IA: FB_PLAIN does not implement IA`,
    ]);
  });

  it("an unrelated interface into a function input", () => {
    expect(messages(program("r := ReadA(ix);"), { dialect: "iec-3" })).toEqual([
      `${BODY_LINE}:12 Cannot assign IX to IA: IX does not extend IA`,
    ]);
  });

  it("a non-NULL initializer", () => {
    const source = `${TYPES}PROGRAM MAIN
VAR a : FB_A; ia : IA := a; END_VAR
END_PROGRAM
`;
    const line = TYPES.split("\n").length + 1;
    expect(messages(source, { dialect: "iec-3" })).toEqual([
      `${line}:26 Interface initializers other than NULL are not supported; assign 'IA' in the body instead`,
    ]);
  });

  it("errors carry the file name", () => {
    const result = compile(program("ia := p;"), {
      dialect: "iec-3",
      fileName: "main.st",
    });
    expect(result.errors.map((e) => e.file)).toEqual(["main.st"]);
  });
});
