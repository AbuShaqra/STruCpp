/**
 * `TYPE U_A : UNION ... END_UNION END_TYPE` (feature union; in neither the
 * default set nor `iec-3`). Members are reached and type-checked like STRUCT
 * fields; a UNION is assignment-compatible only with itself. Its members must
 * be data, named once, with no initial value, and a UNION takes no EXTENDS.
 * Code generation refuses every UNION for now; analysis accepts valid code.
 */
import { describe, it, expect } from "vitest";
import { analyze, compile, compileStlib } from "../../src/index.js";
import type { DialectProfile } from "../../src/dialect.js";

type Options = Parameters<typeof compile>[1];

const UNION_PROFILE: DialectProfile = {
  id: "unions",
  name: "unions",
  extends: "iec-3",
  features: ["union"],
  semantics: {},
};

const ON: Options = { features: ["+union"] };

const MODES: { name: string; options: Options }[] = [
  { name: "no dialect", options: {} },
  { name: "iec-3", options: { dialect: "iec-3" } },
];

const CODEGEN = "code generation for UNION is not supported yet";

const TYPES = `TYPE
  U_A : UNION f : REAL; d : DWORD; arr : ARRAY[0..3] OF BYTE; END_UNION;
  U_B : UNION x : DINT; END_UNION;
END_TYPE
`;

/** Analysis diagnostics as `line:col message`. */
function check(source: string, options: Options = ON): string[] {
  return analyze(source, options).errors.map(
    (e) => `${e.line}:${e.column} ${e.message}`,
  );
}

/** A program over TYPES whose body is `body`. */
function program(body: string, vars = "u : U_A; v : U_A; b : U_B;"): string {
  return `${TYPES}PROGRAM P
VAR ${vars} r : REAL; i : INT; END_VAR
${body}
END_PROGRAM
`;
}

describe("UNION needs the feature union", () => {
  for (const mode of MODES) {
    it(`is refused at UNION, once per type, with no follow-up error (${mode.name})`, () => {
      expect(
        check(program("u.f := 1.5; r := u.f; u.arr[1] := 2;"), mode.options),
      ).toEqual([
        "2:9 UNION type 'U_A' needs the feature union",
        "3:9 UNION type 'U_B' needs the feature union",
      ]);
    });
  }

  it("names the loaded profiles that have it", () => {
    expect(
      check(program("u.f := 1.5;"), {
        dialect: "iec-3",
        dialectFiles: ["unions.json"],
        dialectIO: {
          readFile: () => JSON.stringify(UNION_PROFILE),
          listDir: () => [],
        },
      }),
    ).toEqual([
      "2:9 UNION type 'U_A' needs the feature union (profiles: unions)",
      "3:9 UNION type 'U_B' needs the feature union (profiles: unions)",
    ]);
  });

  it("is accepted with +union in every mode and through a profile", () => {
    for (const mode of MODES) {
      expect(
        check(program("u.f := 1.5;"), {
          ...mode.options,
          features: ["+union"],
        }),
      ).toEqual([]);
    }
    expect(check(program("u.f := 1.5;"), { dialect: UNION_PROFILE })).toEqual(
      [],
    );
  });
});

describe("UNION members are reachable and type-checked like STRUCT fields", () => {
  const USES = `TYPE
  E_M : (Idle, Busy);
  T_Small : INT(0..10);
  ST_P : STRUCT a : INT; b : WORD; END_STRUCT;
  U_A : UNION
    f : REAL; d : DWORD; arr : ARRAY[0..3] OF BYTE; s : STRING(8); w : WSTRING;
    e : E_M; sm : T_Small; p : POINTER TO INT; rf : REF_TO DINT; st : ST_P;
  END_UNION;
  U_N : UNION inner : U_A; raw : ARRAY[0..15] OF BYTE; END_UNION;
  ST_W : STRUCT u : U_A; k : INT; END_STRUCT;
END_TYPE
FUNCTION F_Get : REAL
VAR_INPUT x : U_A; END_VAR
VAR_IN_OUT y : U_A; END_VAR
y.d := 16#3F800000;
F_Get := x.f;
END_FUNCTION
FUNCTION_BLOCK FB_H
VAR_INPUT inp : U_A; END_VAR
VAR m : U_A; END_VAR
VAR_OUTPUT o : DWORD; END_VAR
m := inp;
o := m.d;
END_FUNCTION_BLOCK
PROGRAM P
VAR
  u : U_A; v : U_A; n : U_N; w : ST_W; arr : ARRAY[1..2] OF U_A; fb : FB_H;
  r : REAL; i : INT; x : DINT;
END_VAR
u.f := 1.5; r := u.f; u.arr[1] := 2; u.st.a := 3; u.e := Busy; u.s := 'abc';
n.inner.d := 1; n.raw[0] := 2; w.u.f := r; arr[1].d := 5; arr[2] := u;
u := v; w.u := arr[1]; fb(inp := u); fb.m.f := 2.0; r := F_Get(u, v);
u.p := ADR(i); u.rf := REF(x);
END_PROGRAM
`;

  it("variables, FB and STRUCT members, arrays, VAR_INPUT and VAR_IN_OUT", () => {
    expect(check(USES)).toEqual([]);
  });

  it("reports member type errors like a STRUCT's", () => {
    expect(
      check(
        program("u.f := t; t := u.d; u.arr[1] := t;", "u : U_A; t : TIME;"),
      ),
    ).toEqual([
      "7:8 Cannot assign TIME to REAL",
      "7:16 Cannot assign DWORD to TIME",
      "7:33 Cannot assign TIME to BYTE",
    ]);
  });
});

describe("a UNION is assignment-compatible only with the same UNION", () => {
  it("refuses another UNION, a STRUCT and an elementary value in either direction", () => {
    expect(
      check(
        `${TYPES}TYPE ST_S : STRUCT x : DINT; END_STRUCT; END_TYPE
PROGRAM P
VAR u : U_A; b : U_B; s : ST_S; i : INT; d : DWORD; END_VAR
u := b; b := u; u := s; s := u; u := i; d := u; u := 5;
END_PROGRAM
`,
      ),
    ).toEqual([
      "8:6 Cannot assign U_B to U_A",
      "8:14 Cannot assign U_A to U_B",
      "8:22 Cannot assign ST_S to U_A",
      "8:30 Cannot assign U_A to ST_S",
      "8:38 Cannot assign INT to U_A",
      "8:46 Cannot assign U_A to DWORD",
      "8:54 Cannot assign INT to U_A",
    ]);
  });

  it("refuses another type for a UNION VAR_INPUT or VAR_IN_OUT, and a UNION for an elementary input", () => {
    expect(
      check(`${TYPES}FUNCTION_BLOCK FB_X
VAR_INPUT p : U_A; n : DWORD; END_VAR
VAR_IN_OUT q : U_A; END_VAR
END_FUNCTION_BLOCK
PROGRAM P
VAR u : U_A; b : U_B; i : INT; fb : FB_X; END_VAR
fb(p := b, q := b);
fb(p := i, n := u, q := u);
fb(p := u, q := u);
END_PROGRAM
`),
    ).toEqual([
      "11:9 Cannot assign U_B to parameter 'P' of type U_A",
      "11:17 Cannot assign U_B to parameter 'Q' of type U_A",
      "12:9 Cannot assign INT to parameter 'P' of type U_A",
      "12:17 Cannot assign U_A to parameter 'N' of type DWORD",
    ]);
  });

  it("an argument whose type is an alias of the UNION is the same type", () => {
    expect(
      check(`${TYPES}TYPE T_U : U_A; END_TYPE
FUNCTION_BLOCK FB_X
VAR_INPUT p : U_A; t : T_U; END_VAR
END_FUNCTION_BLOCK
PROGRAM P
VAR u : U_A; t : T_U; fb : FB_X; END_VAR
fb(p := t, t := u);
END_PROGRAM
`),
    ).toEqual([]);
  });
});

describe("UNION rules", () => {
  it("member names are unique, case-insensitively", () => {
    expect(
      check("TYPE U_A : UNION f : REAL; F : DWORD; END_UNION END_TYPE\n"),
    ).toEqual(["1:28 Duplicate member 'F' in UNION 'U_A'"]);
  });

  it("a UNION has at least one member", () => {
    expect(check("TYPE U_E : UNION END_UNION END_TYPE\n")).toEqual([
      "1:12 UNION 'U_E' declares no members: a UNION needs at least one",
    ]);
  });

  it("a member initial value is not supported yet", () => {
    expect(
      check(
        "TYPE U_A : UNION f : REAL := 1.0; d : DWORD; END_UNION END_TYPE\n",
      ),
    ).toEqual([
      "1:30 Member 'F' of UNION 'U_A' has an initial value: initial values in a UNION are not supported yet",
    ]);
  });

  it("a UNION takes no EXTENDS, and a STRUCT cannot extend a UNION", () => {
    expect(
      check(
        `TYPE
  U_A : UNION f : REAL; END_UNION;
  U_X EXTENDS U_A : UNION a : INT; END_UNION;
  ST_Y EXTENDS U_A : STRUCT b : INT; END_STRUCT;
END_TYPE
`,
        { features: ["+union", "+struct_extends"] },
      ),
    ).toEqual([
      "4:16 STRUCT 'ST_Y' cannot extend 'U_A', a UNION: the base must be a STRUCT",
      "3:7 UNION 'U_X' cannot use EXTENDS: only a STRUCT may extend another type",
    ]);
  });

  it("EXTENDS on a UNION is refused the same way without struct_extends", () => {
    expect(
      check(
        "TYPE U_X EXTENDS U_Y : UNION a : INT; END_UNION; U_Y : UNION b : INT; END_UNION; END_TYPE\n",
      ),
    ).toEqual([
      "1:10 UNION 'U_X' cannot use EXTENDS: only a STRUCT may extend another type",
    ]);
  });

  it("a member must be data, not an instance or a variable-length array", () => {
    expect(
      check(`TYPE
  ST_H : STRUCT t : FB_X; END_STRUCT;
  U_F : UNION
    fb : FB_X; h : ST_H; i : I_X; arr : ARRAY[0..1] OF FB_X; tm : FB_L;
    ok1 : POINTER TO FB_X; ok2 : REFERENCE TO FB_X; ok3 : REF_TO I_X;
  END_UNION;
END_TYPE
INTERFACE I_X END_INTERFACE
FUNCTION_BLOCK FB_X END_FUNCTION_BLOCK
`),
    ).toEqual([
      "4:10 Member 'FB' of UNION 'U_F' is of FUNCTION_BLOCK type 'FB_X': a UNION member must be data, not a function block, interface or program instance",
      "4:20 Member 'H' of UNION 'U_F' is of type 'ST_H', which holds FUNCTION_BLOCK type 'FB_X': a UNION member must be data, not a function block, interface or program instance",
      "4:30 Member 'I' of UNION 'U_F' is of INTERFACE type 'I_X': a UNION member must be data, not a function block, interface or program instance",
      "4:41 Member 'ARR' of UNION 'U_F' is of FUNCTION_BLOCK type 'FB_X': a UNION member must be data, not a function block, interface or program instance",
      "4:67 Undefined type 'FB_L' in UNION 'U_F'",
    ]);
  });

  it("a variable-length ARRAY type is refused as a member", () => {
    expect(
      check(`TYPE
  T_V : ARRAY[*] OF INT;
  U_A : UNION v : T_V; END_UNION;
END_TYPE
`).filter((m) => m.includes("UNION")),
    ).toEqual([
      "3:19 Member 'V' of UNION 'U_A' is a variable-length ARRAY[*]: the members of a UNION share one storage, so each must have a fixed size",
    ]);
  });

  it("a UNION that holds itself through a pointer is accepted", () => {
    expect(
      check(
        "TYPE U_L : UNION next : POINTER TO U_L; raw : LWORD; END_UNION END_TYPE\n",
      ),
    ).toEqual([]);
  });
});

describe("an initial value that sets a UNION is not supported yet", () => {
  it("on a variable, a STRUCT field, an array, an FB input and a TYPE default (reported once)", () => {
    expect(
      check(`TYPE
  U_A : UNION f : REAL; d : DWORD; END_UNION;
  U_D : UNION a : INT; END_UNION := (a := 1);
  ST_W : STRUCT u : U_A; k : INT; END_STRUCT;
  ST_I : STRUCT u : U_A := (d := 1); END_STRUCT;
END_TYPE
FUNCTION_BLOCK FB_X
VAR_INPUT p : U_A; k : INT; END_VAR
END_FUNCTION_BLOCK
PROGRAM P
VAR
  u : U_A := (f := 1.0);
  w : ST_W := (k := 1, u := (f := 2.0));
  arr : ARRAY[0..1] OF U_A := [(f := 1.0), (f := 2.0)];
  ws : ARRAY[0..1] OF ST_W := [(k := 1), (u := (d := 3))];
  fb : FB_X := (p := (f := 1.0));
  d1 : U_D; d2 : U_D;
  ok1 : ST_W := (k := 1); ok2 : FB_X := (k := 2);
END_VAR
END_PROGRAM
`),
    ).toEqual([
      "12:14 An initial value for UNION 'U_A' is not supported yet",
      "13:15 An initial value for UNION 'U_A' is not supported yet",
      "14:31 An initial value for UNION 'U_A' is not supported yet",
      "15:31 An initial value for UNION 'U_A' is not supported yet",
      "16:16 An initial value for UNION 'U_A' is not supported yet",
      "3:37 An initial value for UNION 'U_D' is not supported yet",
      "5:28 An initial value for UNION 'U_A' is not supported yet",
    ]);
  });
});

describe("code generation refuses a UNION", () => {
  it("fails at each UNION declaration, after a clean analysis", () => {
    const source = program("u.f := 1.5;");
    expect(analyze(source, ON).errors).toEqual([]);
    const result = compile(source, ON);
    expect(result.success).toBe(false);
    expect(result.cppCode).toBe("");
    expect(
      result.errors.map((e) => `${e.line}:${e.column} ${e.message}`),
    ).toEqual([`2:3 ${CODEGEN} (UNION 'U_A')`, `3:3 ${CODEGEN} (UNION 'U_B')`]);
  });

  it("refuses a library that declares a UNION", () => {
    const result = compileStlib([{ source: TYPES, fileName: "u.st" }], {
      name: "ulib",
      version: "1.0.0",
      namespace: "ulib",
      features: ["+union"],
    });
    expect(result.success).toBe(false);
    expect(result.errors.map((e) => e.message).join("\n")).toContain(CODEGEN);
  });

  it("analysis errors come first: with the feature off, compile reports the refusal", () => {
    expect(
      compile(program("u.f := 1.5;"), {}).errors.map((e) => e.message),
    ).toEqual([
      "UNION type 'U_A' needs the feature union",
      "UNION type 'U_B' needs the feature union",
    ]);
  });
});

describe("programs using UNION and END_UNION as names compile as before", () => {
  const NAMES = `TYPE
  union : STRUCT x : INT; END_STRUCT;
  E : (Union, End_Union);
  T1 : Union;
END_TYPE
PROGRAM P
VAR union : INT; end_union : INT; s : T1; e : E := End_Union; END_VAR
union := end_union + s.x;
IF e = Union THEN union := 0; END_IF;
END_PROGRAM
`;
  for (const mode of [...MODES, { name: "+union", options: ON }]) {
    it(`compiles clean (${mode.name})`, () => {
      const result = compile(NAMES, mode.options);
      expect(result.errors).toEqual([]);
      expect(result.success).toBe(true);
    });
  }
});
