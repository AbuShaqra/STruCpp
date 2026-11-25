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
    expect(orderAllGlobals(ast!).dependencies.get("X")).toEqual(["G2"]);
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
