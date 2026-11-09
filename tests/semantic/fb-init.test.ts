/**
 * The feature fb_init (in neither the default set nor `iec-3`): init
 * arguments after an FB instance's type, `fb : FB_A(p := 1);`, and a METHOD
 * FB_init that runs at start-up. With the feature off, init arguments are
 * refused and a declared FB_init gets a warning that it never runs. Language
 * errors are reported by analysis; what code generation cannot do yet is
 * refused by compile only, so `--check` accepts it.
 */
import { describe, it, expect } from "vitest";
import { analyze, compile } from "../../src/index.js";
import type { DialectProfile } from "../../src/dialect.js";

type Options = Parameters<typeof compile>[1];

const ON: Options = { features: ["+fb_init"] };

const MODES: { name: string; options: Options }[] = [
  { name: "no dialect", options: {} },
  { name: "iec-3", options: { dialect: "iec-3" } },
];

const PROFILE: DialectProfile = {
  id: "inits",
  name: "inits",
  extends: "iec-3",
  features: ["fb_init"],
  semantics: {},
};

/** An FB with an FB_init that takes `p : INT` and `s : STRING`. */
const FB_A = `FUNCTION_BLOCK FB_A
VAR v : INT; END_VAR
METHOD FB_init : BOOL
VAR_INPUT bInitRetains : BOOL; bInCopyCode : BOOL; p : INT; s : STRING; END_VAR
v := p;
END_METHOD
END_FUNCTION_BLOCK
`;

/** Analysis diagnostics as `line:col message`. */
function check(source: string, options: Options = ON): string[] {
  return analyze(source, options).errors.map(
    (e) => `${e.line}:${e.column} ${e.message}`,
  );
}

/** Analysis warnings as `line:col message`. */
function warnings(source: string, options: Options = ON): string[] {
  return analyze(source, options).warnings.map(
    (e) => `${e.line}:${e.column} ${e.message}`,
  );
}

/** Compile errors as `line:col message`. */
function compileErrors(source: string, options: Options = ON): string[] {
  return compile(source, options).errors.map(
    (e) => `${e.line}:${e.column} ${e.message}`,
  );
}

/** FB_A, then a program declaring `vars` (line 9 onwards). */
function program(vars: string, body = ""): string {
  return `${FB_A}PROGRAM P
VAR ${vars} END_VAR
${body}
END_PROGRAM
`;
}

describe("fb_init off", () => {
  for (const mode of MODES) {
    it(`refuses init arguments at '(' (${mode.name})`, () => {
      expect(check(program("f : FB_A(p := 1);"), mode.options)).toEqual([
        "9:13 The init argument list of 'F' needs the feature fb_init",
      ]);
    });

    it(`warns at the name of a METHOD FB_init, and accepts it (${mode.name})`, () => {
      const src = program("f : FB_A;");
      expect(check(src, mode.options)).toEqual([]);
      expect(warnings(src, mode.options)).toEqual([
        "3:8 FB_init is not run unless the feature fb_init is on",
      ]);
      expect(compile(src, mode.options).success).toBe(true);
    });
  }

  it("names the loaded profiles that have the feature", () => {
    expect(
      check(program("f : FB_A(p := 1);"), {
        dialect: "iec-3",
        dialectFiles: ["inits.json"],
        dialectIO: {
          readFile: () => JSON.stringify(PROFILE),
          listDir: () => [],
        },
      }),
    ).toEqual([
      "9:13 The init argument list of 'F' needs the feature fb_init (profiles: inits)",
    ]);
  });

  it("does not warn for a method of another name, or FB_init in a PROGRAM", () => {
    expect(
      warnings(
        `FUNCTION_BLOCK FB_X
METHOD FB_initX : BOOL
END_METHOD
END_FUNCTION_BLOCK
`,
        {},
      ),
    ).toEqual([]);
  });

  it("leaves the IEC instance initialisation unchanged", () => {
    for (const mode of [...MODES, { name: "on", options: ON }]) {
      expect(
        check(
          `FUNCTION_BLOCK FB_B VAR_INPUT p : INT; END_VAR END_FUNCTION_BLOCK
PROGRAM P VAR f : FB_B := (p := 3); END_VAR END_PROGRAM
`,
          mode.options,
        ),
      ).toEqual([]);
    }
  });
});

describe("fb_init on: what is accepted", () => {
  it("named init arguments for globals, program and FB members, arrays, through a profile", () => {
    const src = `${FB_A}VAR_GLOBAL g : FB_A(p := 1, s := 'x'); END_VAR
FUNCTION_BLOCK FB_H
VAR_INPUT k : INT; END_VAR
VAR m : FB_A(p := k + 1); END_VAR
VAR_OUTPUT o : FB_A(s := 'o'); END_VAR
END_FUNCTION_BLOCK
PROGRAM P
VAR
  f : FB_A(p := 2) := (v := 1);
  arr : ARRAY[0..2] OF FB_A(p := 3);
  h : FB_H;
  plain : FB_A;
END_VAR
END_PROGRAM
`;
    expect(check(src)).toEqual([]);
    expect(warnings(src)).toEqual([]);
    expect(check(src, { dialect: PROFILE })).toEqual([]);
    expect(compileErrors(src)).toEqual([]);
  });

  it("injects the two flags when FB_init does not declare them", () => {
    const src = `FUNCTION_BLOCK FB_N
VAR r, c : BOOL; n : INT; END_VAR
METHOD FB_init
VAR_INPUT n0 : INT; END_VAR
r := bInitRetains; c := bInCopyCode; n := n0;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM P VAR f : FB_N(n0 := 4); END_VAR END_PROGRAM
`;
    expect(check(src)).toEqual([]);
    expect(compileErrors(src)).toEqual([]);
  });

  it("an init argument binds to any FB_init of the chain that declares it", () => {
    const src = `FUNCTION_BLOCK FB_B EXTENDS FB_A
METHOD FB_init : BOOL
VAR_INPUT bInitRetains : BOOL; bInCopyCode : BOOL; q : INT; END_VAR
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_C EXTENDS FB_B
END_FUNCTION_BLOCK
PROGRAM P VAR c : FB_C(p := 1, q := 2); END_VAR END_PROGRAM
`;
    expect(check(FB_A + src)).toEqual([]);
    expect(compileErrors(FB_A + src)).toEqual([]);
  });

  it("a member's init argument may name an input of its holder's FB_init chain", () => {
    const src = `${FB_A}FUNCTION_BLOCK FB_H0
METHOD FB_init
VAR_INPUT base : INT; END_VAR
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_H EXTENDS FB_H0
VAR m : FB_A(p := q + base, s := t); END_VAR
METHOD FB_init
VAR_INPUT q : INT; t : STRING; END_VAR
END_METHOD
END_FUNCTION_BLOCK
PROGRAM P VAR h : FB_H(q := 1, base := 2, t := 'x'); END_VAR END_PROGRAM
`;
    expect(check(src)).toEqual([]);
    expect(warnings(src)).toEqual([]);
    expect(compileErrors(src)).toEqual([]);
  });

  it("an FB_init input shadows a holder member and a global of the same name", () => {
    // Member k and global g are STRINGs; the INT inputs win, so p := k and p := g type-check.
    expect(
      check(`${FB_A}VAR_GLOBAL g : STRING; END_VAR
FUNCTION_BLOCK FB_H
VAR k : STRING; m : FB_A(p := k); n : FB_A(p := g); END_VAR
METHOD FB_init
VAR_INPUT k : INT; g : INT; END_VAR
END_METHOD
END_FUNCTION_BLOCK
`),
    ).toEqual([]);
    // Without the inputs, the same arguments read the STRING variables.
    expect(
      check(`${FB_A}VAR_GLOBAL g : STRING; END_VAR
FUNCTION_BLOCK FB_H
VAR k : STRING; m : FB_A(p := k); n : FB_A(p := g); END_VAR
END_FUNCTION_BLOCK
`),
    ).toEqual([
      "10:31 Cannot assign STRING to INT",
      "10:49 Cannot assign STRING to INT",
    ]);
  });

  it("warns when a member's init argument reads a variable its holder's FB_init assigns", () => {
    const src = `${FB_A}FUNCTION_BLOCK FB_H0
VAR stored : INT; END_VAR
METHOD FB_init
VAR_INPUT x : INT; END_VAR
IF x > 0 THEN stored := x; END_IF;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_H EXTENDS FB_H0
VAR plain : INT := 3; inner : FB_A(p := stored + plain); other : FB_A(p := x); END_VAR
METHOD FB_init
VAR_INPUT x : INT; END_VAR
END_METHOD
END_FUNCTION_BLOCK
`;
    expect(check(src)).toEqual([]);
    expect(warnings(src)).toEqual([
      "16:41 INNER's FB_init runs before FB_H.FB_init, so 'STORED' still has its initial value here",
    ]);
  });

  it("an explicit FB_init call in the body stays an ordinary method call", () => {
    expect(
      check(program("f : FB_A;", "f.FB_init(FALSE, FALSE, 1, 'a');")),
    ).toEqual([]);
  });
});

describe("fb_init on: analysis errors", () => {
  it("an unknown input, a flag, a duplicate, a positional and an output argument", () => {
    expect(
      check(
        program(
          "a : FB_A(x := 1); b : FB_A(bInitRetains := TRUE); c : FB_A(p := 1, P := 2); d : FB_A(1); e : FB_A(p => i); i : INT;",
        ),
      ),
    ).toEqual([
      "9:14 'FB_A' has no FB_init input 'X'",
      "9:32 'BINITRETAINS' is set by the compiler and cannot be an init argument",
      "9:72 Duplicate init argument 'P'",
      "9:90 Init arguments must be named: write 'input := value'",
      "9:103 Init argument 'P' must use ':=': init arguments set FB_init inputs",
    ]);
  });

  it("a name the declaring scope does not declare", () => {
    expect(
      check(`${FB_A}FUNCTION_BLOCK FB_H
VAR m : FB_A(p := nope1); END_VAR
METHOD FB_init : BOOL
VAR_INPUT q : INT; END_VAR
END_METHOD
END_FUNCTION_BLOCK
VAR_GLOBAL g : FB_A(p := nope2); END_VAR
`),
    ).toEqual([
      "14:26 Undeclared variable 'NOPE2'",
      "9:19 Undeclared variable 'NOPE1'",
    ]);
  });

  it("a type mismatch, reported at the value", () => {
    expect(check(program("a : FB_A(p := 'txt', s := 5);"))).toEqual([
      "9:19 Cannot assign STRING to INT",
      "9:31 Cannot assign INT to STRING",
    ]);
  });

  it("an FB without FB_init, a non-FB type, VAR_IN_OUT and VAR_EXTERNAL", () => {
    expect(
      check(`${FB_A}FUNCTION_BLOCK FB_Z END_FUNCTION_BLOCK
VAR_GLOBAL g : FB_A; END_VAR
FUNCTION_BLOCK FB_H
VAR_IN_OUT io : FB_A(p := 1); END_VAR
VAR_EXTERNAL g : FB_A(p := 1); END_VAR
END_FUNCTION_BLOCK
PROGRAM P VAR z : FB_Z(p := 1); i : INT(p := 1); END_VAR END_PROGRAM
`),
    ).toEqual([
      "14:23 'FB_Z' has no FB_init method to take init arguments",
      "14:40 Init arguments need a FUNCTION_BLOCK instance, but 'I' is of type 'INT'",
      "11:21 Init arguments are not allowed in VAR_IN_OUT",
      "12:22 Init arguments are not allowed in VAR_EXTERNAL",
    ]);
  });

  it("an FB_init with VAR_OUTPUT, VAR_IN_OUT, a non-BOOL result or a non-BOOL flag", () => {
    expect(
      check(`FUNCTION_BLOCK FB_X
METHOD FB_init : INT
VAR_INPUT bInitRetains : INT; END_VAR
VAR_OUTPUT o : INT; END_VAR
VAR_IN_OUT io : INT; END_VAR
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Y
METHOD FB_init : BOOL
VAR bInCopyCode : BOOL; END_VAR
END_METHOD
END_FUNCTION_BLOCK
`),
    ).toEqual([
      "2:18 FB_init must return BOOL or nothing, not INT",
      "3:11 'BINITRETAINS' of FB_init must be a BOOL VAR_INPUT",
      "4:1 FB_init cannot declare VAR_OUTPUT: nothing is passed to it or read from it at start-up",
      "5:1 FB_init cannot declare VAR_IN_OUT: nothing is passed to it or read from it at start-up",
      "10:5 'BINCOPYCODE' of FB_init must be a BOOL VAR_INPUT",
    ]);
  });
});

describe("fb_init on: refused by compile only (not supported yet)", () => {
  it("an explicit SUPER call of the base FB_init", () => {
    const src = `${FB_A}FUNCTION_BLOCK FB_B EXTENDS FB_A
METHOD FB_init : BOOL
VAR_INPUT bInitRetains : BOOL; bInCopyCode : BOOL; END_VAR
SUPER.FB_init(bInitRetains, bInCopyCode, 1, '');
SUPER^.FB_init(bInitRetains, bInCopyCode, 1, '');
END_METHOD
END_FUNCTION_BLOCK
`;
    expect(check(src)).toEqual([]);
    expect(compileErrors(src)).toEqual([
      "11:1 FB_init of the base runs automatically; remove the explicit call SUPER.FB_init",
      "12:1 FB_init of the base runs automatically; remove the explicit call SUPER.FB_init",
    ]);
  });

  it("instances local to a FUNCTION or METHOD, in VAR_TEMP, in a STRUCT (a library FB: see the CLI test)", () => {
    const src = `${FB_A}FUNCTION_BLOCK FB_W VAR m : FB_A; END_VAR END_FUNCTION_BLOCK
TYPE ST_S : STRUCT w : FB_W; END_STRUCT; END_TYPE
FUNCTION F_X : INT
VAR l : FB_A(p := 1); END_VAR
F_X := 0;
END_FUNCTION
FUNCTION_BLOCK FB_M
METHOD M_A
VAR l : FB_W; END_VAR
END_METHOD
END_FUNCTION_BLOCK
PROGRAM P
VAR_TEMP t : FB_A; END_VAR
VAR s : ST_S; END_VAR
END_PROGRAM
`;
    expect(check(src)).toEqual([]);
    expect(compileErrors(src)).toEqual([
      "20:10 FB_init of 'T' is not supported yet: it is in VAR_TEMP",
      "21:5 FB_init of 'S' is not supported yet: it is held in STRUCT 'ST_S'",
      "16:5 FB_init of 'L' is not supported yet: it is local to METHOD 'M_A'",
      "11:5 FB_init of 'L' is not supported yet: it is local to FUNCTION 'F_X'",
    ]);
  });

  it("an FB without FB_init anywhere in it compiles in every one of those places", () => {
    expect(
      compileErrors(`FUNCTION_BLOCK FB_Q VAR x : INT; END_VAR END_FUNCTION_BLOCK
TYPE ST_S : STRUCT q : FB_Q; END_STRUCT; END_TYPE
FUNCTION F_X : INT VAR l : FB_Q; END_VAR F_X := 0; END_FUNCTION
PROGRAM P VAR_TEMP t : FB_Q; END_VAR VAR s : ST_S; END_VAR END_PROGRAM
`),
    ).toEqual([]);
  });
});
