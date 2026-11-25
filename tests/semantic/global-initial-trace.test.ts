/**
 * Global creation order through the code an initial value runs: CONFIGURATION
 * globals are traced (also from a list global's code), an interface global
 * that holds NULL while globals are created runs no implementer, and the
 * creation order the checker and the code generator agree on.
 */
import { describe, it, expect } from "vitest";
import { compile, parse } from "../../src/index.js";
import { orderAllGlobals } from "../../src/semantic/global-order.js";

const located = (r: ReturnType<typeof compile>): string[] =>
  r.errors.map((e) => `${e.line}:${e.column} ${e.message}`);

const CFG_TAIL = `RESOURCE R ON PLC
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM inst WITH T : Main;
END_RESOURCE
END_CONFIGURATION
`;

const MAIN = `PROGRAM Main
VAR_EXTERNAL x : INT; END_VAR
VAR o1 : INT; END_VAR
o1 := x;
END_PROGRAM
`;

const MODES = [
  ["default", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
] as const;

describe("CONFIGURATION globals, traced", () => {
  const source = (globals: string, pous: string): string =>
    `${pous}${MAIN}CONFIGURATION Cfg\nVAR_GLOBAL\n${globals}\nEND_VAR\n${CFG_TAIL}`;
  const F_READS = (name: string): string => `FUNCTION F : INT
VAR_EXTERNAL ${name} : INT; END_VAR
F := ${name} * 2;
END_FUNCTION
`;

  it("orders a global after what its FUNCTION reads", () => {
    const { ast } = parse(
      source(
        "  x : INT := F();\n  w : INT := 1;\n  gy : INT := 5;",
        F_READS("gy"),
      ),
    );
    const order = orderAllGlobals(ast!);
    expect(order.order.map((i) => i.name.toUpperCase())).toEqual([
      "GY",
      "X",
      "W",
    ]);
    expect(order.dependencies.get("X")).toEqual(["GY"]);
  });

  it("orders after what a pointer read in the code may point to", () => {
    const { ast } = parse(
      source(
        "  x : INT := F();\n  pk : POINTER TO INT := ADR(k);\n  k : INT := 4;",
        `FUNCTION F : INT
VAR_EXTERNAL pk : POINTER TO INT; END_VAR
F := pk^;
END_FUNCTION
`,
      ),
    );
    const order = orderAllGlobals(ast!);
    expect(order.dependencies.get("X")).toEqual(["PK", "K"]);
  });

  it.each(MODES)(
    "refuses a global whose FUNCTION reads it while it is created (%s)",
    (_name, options) => {
      expect(
        located(compile(source("  x : INT := F();", F_READS("x")), options)),
      ).toEqual([
        "12:3 The initial value of global 'x' reads 'x' itself, through the code it calls",
      ]);
    },
  );

  it.each(MODES)("refuses a cycle through the code (%s)", (_name, options) => {
    expect(
      located(
        compile(
          source(
            "  x : INT := F();\n  y : INT := G();",
            `${F_READS("y")}FUNCTION G : INT
VAR_EXTERNAL x : INT; END_VAR
G := x + 1;
END_FUNCTION
`,
          ),
          options,
        ),
      ),
    ).toEqual([
      "16:3 The initial values of the globals 'x' and 'y' depend on each other (X -> Y -> X)",
    ]);
  });

  it("orders list and CONFIGURATION globals as one graph", () => {
    const { ast } = parse(
      `${F_READS("gy")}FUNCTION G : INT
VAR_EXTERNAL x : INT; END_VAR
G := x + 1;
END_FUNCTION
VAR_GLOBAL x : INT := F(); z : INT := 3; END_VAR
${MAIN}CONFIGURATION Cfg
VAR_GLOBAL c : INT := G(); gy : INT := 5; END_VAR
${CFG_TAIL}`,
    );
    const order = orderAllGlobals(ast!);
    expect(order.order.map((i) => i.name.toUpperCase())).toEqual([
      "GY",
      "X",
      "Z",
      "C",
    ]);
    expect(order.dependencies.get("X")).toEqual(["GY"]);
    expect(order.dependencies.get("C")).toEqual(["X"]);
    expect([...order.configurationOf.keys()]).toEqual(["C", "GY"]);
  });

  it.each(MODES)(
    "refuses a cycle between a list and a CONFIGURATION global (%s)",
    (_name, options) => {
      expect(
        located(
          compile(
            `${F_READS("x")}FUNCTION G : INT
VAR_EXTERNAL c : INT; END_VAR
G := c + 10;
END_FUNCTION
VAR_GLOBAL x : INT := G(); END_VAR
${MAIN}CONFIGURATION Cfg
VAR_GLOBAL c : INT := F(); END_VAR
${CFG_TAIL}`,
            options,
          ),
        ),
      ).toEqual([
        "9:12 The initial values of the globals 'x' and 'c' depend on each other (X -> C -> X)",
      ]);
    },
  );

  it("orders a global of one CONFIGURATION after one of another", () => {
    const { ast } = parse(
      `${F_READS("b")}${MAIN}PROGRAM Main2 END_PROGRAM
CONFIGURATION CfgA
VAR_GLOBAL a : INT := F(); END_VAR
${CFG_TAIL}CONFIGURATION CfgB
VAR_GLOBAL b : INT := 21; END_VAR
RESOURCE R2 ON PLC
TASK T2(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM inst2 WITH T2 : Main2;
END_RESOURCE
END_CONFIGURATION
`,
    );
    const order = orderAllGlobals(ast!);
    expect(order.order.map((i) => i.name.toUpperCase())).toEqual(["B", "A"]);
  });

  it("emits a list global whose code reads a CONFIGURATION global after the CONFIGURATION globals", () => {
    const r = compile(
      `${F_READS("gy")}VAR_GLOBAL x : INT := F(); z : INT := 3; END_VAR
${MAIN}CONFIGURATION Cfg
VAR_GLOBAL gy : INT := 5; END_VAR
${CFG_TAIL}`,
    );
    expect(r.errors).toEqual([]);
    const h = r.headerCode;
    const at = (re: RegExp): number => h.search(re);
    expect(at(/^inline IEC_INT Z = /m)).toBeLessThan(
      at(/^inline GlobalVar<IEC_INT> GY/m),
    );
    expect(at(/^inline GlobalVar<IEC_INT> GY/m)).toBeLessThan(
      at(/^inline IEC_INT X = /m),
    );
  });
});

describe("an interface global holding NULL while globals are created", () => {
  const source = (globals: string, extra = ""): string => `INTERFACE I_X
METHOD M : INT
END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB_X IMPLEMENTS I_X
VAR_EXTERNAL x : INT; END_VAR
METHOD M : INT
M := x + 1;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION F : INT
VAR_EXTERNAL gi : I_X; END_VAR
IF gi <> 0 THEN F := gi.M(); ELSE F := 7; END_IF
END_FUNCTION
${extra}VAR_GLOBAL
${globals}
  fx : FB_X;
  x : INT := F();
END_VAR
PROGRAM Main
VAR_EXTERNAL gi : I_X; fx : FB_X; END_VAR
gi := fx;
END_PROGRAM
`;

  it.each(["  gi : I_X;", "  gi : I_X := NULL;", "  gi : I_X := 0;"])(
    "runs no implementer (%s)",
    (gi) => {
      expect(
        located(compile(source(gi), { features: ["+interface_zero"] })),
      ).toEqual([]);
    },
  );

  it.each([
    ["bound to an instance", "  gi : I_X := fx;", ""],
    [
      "assigned in a FUNCTION",
      "  gi : I_X;",
      `FUNCTION G : INT
VAR_EXTERNAL gi : I_X; fx : FB_X; END_VAR
gi := fx;
G := 0;
END_FUNCTION
`,
    ],
    [
      "passed to a call that may write it",
      "  gi : I_X;",
      `FUNCTION G : INT
VAR_EXTERNAL gi : I_X; END_VAR
G := H(gi);
END_FUNCTION
FUNCTION H : INT
VAR_IN_OUT i : I_X; END_VAR
H := 0;
END_FUNCTION
`,
    ],
    [
      "whose address is taken",
      "  gi : I_X;\n  pgi : POINTER TO I_X := ADR(gi);",
      "",
    ],
    [
      "a reference is bound to it",
      "  gi : I_X;",
      `FUNCTION G : INT
VAR_EXTERNAL gi : I_X; fx : FB_X; END_VAR
VAR r : REFERENCE TO I_X; END_VAR
r REF= gi;
r := fx;
G := 0;
END_FUNCTION
`,
    ],
    [
      "assigned in a PROGRAM a FUNCTION calls",
      "  gi : I_X;",
      `PROGRAM Setup
VAR_EXTERNAL gi : I_X; fx : FB_X; END_VAR
gi := fx;
END_PROGRAM
FUNCTION G : INT
Setup();
G := 0;
END_FUNCTION
`,
    ],
    [
      "assigned in a PROGRAM's action a FUNCTION calls",
      "  gi : I_X;",
      `PROGRAM Setup
VAR_EXTERNAL gi : I_X; fx : FB_X; END_VAR
ACTION Go:
gi := fx;
END_ACTION
END_PROGRAM
FUNCTION G : INT
Setup.Go();
G := 0;
END_FUNCTION
`,
    ],
  ])("still reaches its implementers when %s", (_name, gi, extra) => {
    const errors = located(
      compile(source(gi, extra), {
        features: ["+program_methods", "+st_actions"],
      }),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(
      /The initial value of global 'x' reads 'x' itself, through the code it calls$/,
    );
  });
});

describe("a PROGRAM run while globals are created", () => {
  it("orders a global after what the PROGRAM it calls reads", () => {
    const { ast } = parse(`FUNCTION_BLOCK FB_K
METHOD Get : INT
Get := 6;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Setup
VAR_EXTERNAL g2 : INT; END_VAR
VAR_OUTPUT o : INT; END_VAR
o := g2;
END_PROGRAM
FUNCTION F : INT
Setup();
F := Setup.o;
END_FUNCTION
VAR_GLOBAL
  hk : FB_K;
  x : INT := F();
  g2 : INT := hk.Get();
END_VAR
PROGRAM Main
VAR_EXTERNAL x : INT; END_VAR
VAR o1 : INT; END_VAR
o1 := x;
END_PROGRAM
`);
    expect(orderAllGlobals(ast!).dependencies.get("X")).toEqual([
      "PROGRAM SETUP",
      "G2",
    ]);
  });

  it("refuses a call of a PROGRAM member it cannot follow", () => {
    const r = compile(
      `PROGRAM Setup
VAR_OUTPUT o : INT; END_VAR
END_PROGRAM
FUNCTION F : INT
Setup.Nothing();
F := 0;
END_FUNCTION
VAR_GLOBAL x : INT := F(); END_VAR
PROGRAM Main END_PROGRAM
`,
      { features: ["+program_methods"] },
    );
    expect(
      located(r).some((e) =>
        e.includes("PROGRAM call that cannot be followed"),
      ),
    ).toBe(true);
  });
});

describe("a PROGRAM instance used while globals are created", () => {
  it("is a node: the global comes after it, it after what it needs", () => {
    const { ast } = parse(`PROGRAM Setup
VAR_EXTERNAL k : INT; END_VAR
VAR v : INT := 5; END_VAR
VAR_OUTPUT o : INT; END_VAR
o := v + k;
END_PROGRAM
FUNCTION F : INT
Setup();
F := Setup.o;
END_FUNCTION
VAR_GLOBAL x : INT := F(); k : INT := 1; END_VAR
PROGRAM Main END_PROGRAM
`);
    const order = orderAllGlobals(ast!);
    expect(order.dependencies.get("X")).toEqual(["PROGRAM SETUP", "K"]);
    // A list global through VAR_EXTERNAL is no constructor argument
    expect(order.dependencies.get("PROGRAM SETUP")).toEqual([]);
    expect(order.reads.get("X")).toContain("PROGRAM SETUP");
  });

  it("refuses a global whose PROGRAM instance needs it", () => {
    const r = compile(
      `PROGRAM Setup
VAR_EXTERNAL cg : INT; END_VAR
VAR_OUTPUT o : INT; END_VAR
o := 3;
END_PROGRAM
FUNCTION F : INT
Setup();
F := Setup.o;
END_FUNCTION
${MAIN.replace("x : INT", "cg : INT").replace("o1 := x", "o1 := cg")}CONFIGURATION Cfg
VAR_GLOBAL cg : INT := F(); END_VAR
${CFG_TAIL}`,
      { features: ["+program_methods"] },
    );
    expect(located(r)).toEqual([
      "16:24 The initial value of global 'cg' runs PROGRAM SETUP, whose instance needs a global that is created after it: the globals cannot be created in a known order; assign 'cg' in a program instead",
    ]);
  });

  it("keeps the declaration order of a store and a later read", () => {
    const { ast } = parse(`FUNCTION SetG : INT
VAR_EXTERNAL g : INT; END_VAR
g := 7;
SetG := 0;
END_FUNCTION
FUNCTION GetG : INT
VAR_EXTERNAL g : INT; END_VAR
GetG := g;
END_FUNCTION
VAR_GLOBAL g : INT; s : INT := SetG(); x : INT := GetG(); END_VAR
PROGRAM Main END_PROGRAM
`);
    expect(orderAllGlobals(ast!).dependencies.get("X")).toEqual(["G", "S"]);
  });
});

describe("FB_init and globals read while they are created (feature fb_init)", () => {
  const FB = `FUNCTION_BLOCK FB_B
VAR v : INT; END_VAR
METHOD FB_init : BOOL
VAR_INPUT bInitRetains : BOOL; bInCopyCode : BOOL; END_VAR
v := 7;
END_METHOD
METHOD GetV : INT
GetV := v;
END_METHOD
END_FUNCTION_BLOCK
`;
  it("refuses reading an instance whose FB_init has work", () => {
    const r = compile(
      `${FB}VAR_GLOBAL lb : FB_B; lv : INT := lb.GetV(); pb : POINTER TO FB_B := ADR(lb); END_VAR
PROGRAM Main END_PROGRAM
`,
      { features: ["+fb_init"] },
    );
    expect(located(r)).toEqual([
      "11:35 The initial value of global 'lv' reads 'lb' before its FB_init runs (right after the globals created with it); assign 'lv' in a program instead",
    ]);
  });

  it("accepts it without the feature (FB_init is then a plain method)", () => {
    const r = compile(
      `${FB}VAR_GLOBAL lb : FB_B; lv : INT := lb.GetV(); END_VAR
PROGRAM Main END_PROGRAM
`,
    );
    expect(r.errors).toEqual([]);
  });
});

describe("a VAR_INPUT ARRAY[*]", () => {
  it.each(MODES)("cannot be stored into (%s)", (_name, options) => {
    const r = compile(
      `FUNCTION G : INT
VAR_OUTPUT o : ARRAY[*] OF INT; END_VAR
G := 0;
END_FUNCTION
FUNCTION F : INT
VAR_INPUT a : ARRAY[*] OF INT; END_VAR
VAR t : ARRAY[1..3] OF INT; x : INT; END_VAR
a := t;
a[1] := 9;
x := G(o => a);
F := a[1];
END_FUNCTION
PROGRAM Main END_PROGRAM
`,
      options,
    );
    const message = (line: number, col: number): string =>
      `${line}:${col} 'a' is a VAR_INPUT ARRAY[*]: it refers to the caller's array, which an input cannot change; declare it VAR_IN_OUT to write it`;
    expect(located(r)).toEqual([message(8, 1), message(9, 1), message(10, 13)]);
  });
});

describe("a whole-array store into an ARRAY[*] parameter", () => {
  const source = (decl: string, store: string): string => `FUNCTION F : INT
VAR_IN_OUT a : ARRAY[*] OF INT; END_VAR
VAR ${decl} END_VAR
${store}
F := 0;
END_FUNCTION
PROGRAM Main END_PROGRAM
`;
  const refusal = (what: string): string =>
    `4:6 Cannot store ${what} into 'a', a variable-length ARRAY[*] of rank 1: only an array of that rank, element by element`;

  it.each(MODES)(
    "refuses an array literal and another rank (%s)",
    (_n, options) => {
      expect(located(compile(source("", "a := [1, 2, 3];"), options))).toEqual([
        refusal("an array literal"),
      ]);
      expect(
        located(
          compile(source("u : ARRAY[1..3, 1..2] OF INT;", "a := u;"), options),
        ),
      ).toEqual([refusal("an array of rank 2")]);
    },
  );

  it("checks the elements as scalar stores", () => {
    const narrowing = source("t : ARRAY[1..3] OF DINT;", "a := t;");
    expect(compile(narrowing).warnings.map((w) => w.message)).toContain(
      "Implicit narrowing conversion from DINT to INT",
    );
    expect(located(compile(narrowing, { strict: true }))).toEqual([
      "4:6 Implicit conversion from DINT to INT is not allowed; use DINT_TO_INT",
    ]);
    expect(
      located(
        compile(source("t : ARRAY[1..3] OF SINT;", "a := t;"), {
          strict: true,
        }),
      ),
    ).toEqual([]);
  });
});

describe("round 4: FB_init, write order and VAR_INPUT views", () => {
  it("accepts an FB_init global created after a PROGRAM instance through another global", () => {
    expect(
      located(
        compile(
          `FUNCTION_BLOCK FBG
VAR_INPUT a : INT; END_VAR
VAR_OUTPUT v : INT; END_VAR
METHOD FB_init : BOOL
VAR_INPUT bInitRetains : BOOL; bInCopyCode : BOOL; END_VAR
v := 50;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Setup
VAR_OUTPUT o : INT := 7; END_VAR
o := o + 1;
END_PROGRAM
FUNCTION F : INT
Setup();
F := Setup.o;
END_FUNCTION
VAR_GLOBAL
  y : INT := F();
  gfb : FBG := (a := y);
END_VAR
PROGRAM Main
VAR_EXTERNAL gfb : FBG; END_VAR
VAR O1 : INT; END_VAR
O1 := gfb.v;
END_PROGRAM
`,
          { features: ["+fb_init", "+program_methods"] },
        ),
      ),
    ).toEqual([]);
  });

  it("counts a store through a REFERENCE local in FB_init", () => {
    expect(
      located(
        compile(
          `FUNCTION_BLOCK FBK
VAR n : INT := 6; END_VAR
METHOD FB_init : BOOL
VAR_INPUT bInitRetains : BOOL; bInCopyCode : BOOL; END_VAR
VAR r : REFERENCE TO INT; END_VAR
r REF= n;
r := 60;
END_METHOD
METHOD Get : INT
Get := n;
END_METHOD
END_FUNCTION_BLOCK
VAR_GLOBAL inst : FBK; g : INT := inst.Get(); END_VAR
PROGRAM Main
VAR_EXTERNAL g : INT; END_VAR
VAR O1 : INT; END_VAR
O1 := g;
END_PROGRAM
`,
          { features: ["+fb_init"] },
        ),
      ),
    ).toEqual([
      "13:35 The initial value of global 'g' reads 'inst' before its FB_init runs (right after the globals created with it); assign 'g' in a program instead",
    ]);
  });

  it("drops a store-before-read edge that would close a cycle", () => {
    const { ast } = parse(`FUNCTION FE : INT
VAR_EXTERNAL g : INT; L : INT; END_VAR
g := 5;
FE := L;
END_FUNCTION
FUNCTION FL : INT
VAR_EXTERNAL g : INT; END_VAR
FL := g;
END_FUNCTION
VAR_GLOBAL
  g : INT := 1;
  E : INT := FE();
  L : INT := FL();
END_VAR
PROGRAM Main
VAR_EXTERNAL E : INT; L : INT; g : INT; END_VAR
VAR O1 : INT; END_VAR
O1 := E * 100 + L * 10 + g;
END_PROGRAM
`);
    const order = orderAllGlobals(ast!);
    expect(order.cycles).toEqual([]);
    expect(order.order.map((i) => i.name.toUpperCase())).toEqual([
      "G",
      "L",
      "E",
    ]);
  });

  it.each(MODES)(
    "refuses a VAR_INPUT ARRAY[*] passed to a VAR_IN_OUT or given to ADR (%s)",
    (_name, options) => {
      const inOut = (col: string): string =>
        `8:${col} 'a' is a VAR_INPUT ARRAY[*]: it refers to the caller's array, which an input cannot change; declare it VAR_IN_OUT to pass it to VAR_IN_OUT 'b'`;
      const errors = (source: string): string[] =>
        located(compile(source, options)).filter((e) =>
          e.includes("VAR_INPUT ARRAY"),
        );
      expect(
        errors(`FUNCTION Clobber : INT
VAR_IN_OUT b : ARRAY[*] OF INT; END_VAR
b[LOWER_BOUND(b, 1)] := 99;
Clobber := 0;
END_FUNCTION
FUNCTION Outer : INT
VAR_INPUT a : ARRAY[*] OF INT; END_VAR
Outer := Clobber(a);
END_FUNCTION
PROGRAM Main
VAR d : ARRAY[1..3] OF INT := [1, 2, 3]; O1 : INT; END_VAR
Outer(d);
O1 := d[1];
END_PROGRAM
`),
      ).toEqual([inOut("18")]);
      expect(
        errors(`FUNCTION_BLOCK FBC
VAR_IN_OUT b : ARRAY[*] OF INT; END_VAR
b[LOWER_BOUND(b, 1)] := 99;
END_FUNCTION_BLOCK
FUNCTION Outer : INT
VAR_INPUT a : ARRAY[*] OF INT; END_VAR
VAR c : FBC; END_VAR
c(b := a);
Outer := 0;
END_FUNCTION
PROGRAM Main
VAR d : ARRAY[1..3] OF INT := [1, 2, 3]; O1 : INT; END_VAR
Outer(d);
O1 := d[1];
END_PROGRAM
`),
      ).toEqual([inOut("8")]);
      expect(
        errors(`FUNCTION Outer : INT
VAR_INPUT a : ARRAY[*] OF INT; END_VAR
VAR z : ARRAY[0..2] OF INT := [7,7,7]; END_VAR
MEMCPY(ADR(a), ADR(z), 2);
Outer := 0;
END_FUNCTION
PROGRAM Main
VAR d : ARRAY[1..3] OF INT := [1, 2, 3]; O1 : INT; END_VAR
Outer(d);
O1 := d[1];
END_PROGRAM
`),
      ).toEqual([
        "4:12 'a' is a VAR_INPUT ARRAY[*]: it refers to the caller's array, which an input cannot change; declare it VAR_IN_OUT to write it",
      ]);
    },
  );
});
