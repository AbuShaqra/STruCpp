/**
 * Global creation order through the code an initial value runs: CONFIGURATION
 * globals are traced (also from a list global's code), an interface global
 * that holds NULL while globals are created runs no implementer, and the
 * creation order the checker and the code generator agree on.
 */
import { describe, it, expect } from "vitest";
import { compile, parse } from "../../src/index.js";
import {
  orderConfigurationGlobals,
  orderGlobals,
} from "../../src/semantic/global-order.js";

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
    const order = orderConfigurationGlobals(ast!.configurations[0]!, ast!);
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
    const order = orderConfigurationGlobals(ast!.configurations[0]!, ast!);
    expect(order.dependencies.get("X")).toEqual(["PK", "K"]);
  });

  it.each(MODES)(
    "refuses a global whose FUNCTION reads it while it is created (%s)",
    (_name, options) => {
      expect(
        located(compile(source("  x : INT := F();", F_READS("x")), options)),
      ).toEqual([
        "12:3 The initial value of global 'X' reads 'X' itself, through the code it calls",
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
      "16:3 The initial values of the globals 'X' and 'Y' depend on each other (X -> Y -> X)",
    ]);
  });

  it("traces a list global's code into the CONFIGURATION globals it reads", () => {
    const { ast } = parse(
      `${F_READS("gy")}VAR_GLOBAL x : INT := F(); z : INT := 3; END_VAR
${MAIN}CONFIGURATION Cfg
VAR_GLOBAL gy : INT := 5; END_VAR
${CFG_TAIL}`,
    );
    const order = orderGlobals(ast!);
    expect(order.outerReads.get("X")).toEqual(["GY"]);
    expect(order.outerReads.has("Z")).toBe(false);
    expect(order.dependencies.get("X")).toEqual([]);
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
  ])("still reaches its implementers when %s", (_name, gi, extra) => {
    const errors = located(compile(source(gi, extra)));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(
      /The initial value of global 'X' reads 'X' itself, through the code it calls$/,
    );
  });
});
