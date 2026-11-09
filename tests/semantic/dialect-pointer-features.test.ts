/**
 * POINTER TO, ADR, REFERENCE TO and REF= are dialect features: accepted with
 * no dialect flag (today's behaviour), refused at their own line and column
 * under `iec`, accepted again with `--feature +<id>`, and named with the
 * loaded profiles that have them.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { nodeDialectIO } from "../../src/node/dialect-io.js";

const GOOD = "tests/fixtures/dialects/good";

interface Case {
  name: string;
  feature: string;
  message: string;
  line: number;
  column: number;
  source: string;
}

// Each source puts the construct on line 4 at a known column.
const CASES: Case[] = [
  {
    name: "POINTER TO in a variable declaration",
    feature: "pointer_to",
    message: "POINTER TO needs the feature pointer_to",
    line: 4,
    column: 7,
    source: `PROGRAM P
VAR
  x : INT;
  p : POINTER TO INT;
END_VAR
  x := 1;
END_PROGRAM
`,
  },
  {
    name: "POINTER TO in a type declaration",
    feature: "pointer_to",
    message: "POINTER TO needs the feature pointer_to",
    line: 3,
    column: 8,
    source: `TYPE
  Dummy : INT;
  PI : POINTER TO INT;
END_TYPE
PROGRAM P
VAR x : INT; END_VAR
  x := 1;
END_PROGRAM
`,
  },
  {
    name: "ADR",
    feature: "pointer_to",
    message: "ADR needs the feature pointer_to",
    line: 4,
    column: 8,
    source: `PROGRAM P
VAR x : INT; w : LWORD; END_VAR
x := 1;
  w := ADR(x);
END_PROGRAM
`,
  },
  {
    name: "REFERENCE TO (two words)",
    feature: "reference_to",
    message: "REFERENCE TO needs the feature reference_to",
    line: 4,
    column: 7,
    source: `PROGRAM P
VAR
  x : INT;
  r : REFERENCE TO INT;
END_VAR
  x := 1;
END_PROGRAM
`,
  },
  {
    name: "REFERENCE_TO (one word)",
    feature: "reference_to",
    message: "REFERENCE TO needs the feature reference_to",
    line: 4,
    column: 7,
    source: `PROGRAM P
VAR
  x : INT;
  r : REFERENCE_TO INT;
END_VAR
  x := 1;
END_PROGRAM
`,
  },
  {
    name: "REF=",
    feature: "ref_assign",
    message: "REF= needs the feature ref_assign",
    line: 6,
    column: 3,
    source: `PROGRAM P
VAR
  x : INT;
  r : REF_TO INT;
END_VAR
  r REF= x;
END_PROGRAM
`,
  },
];

describe.each(CASES)("$name", (c) => {
  it("compiles with no dialect flag", () => {
    const result = compile(c.source);
    expect(result.errors.map((e) => e.message)).not.toContain(c.message);
  });

  it("is refused under iec at its own line and column", () => {
    const result = compile(c.source, { dialect: "iec" });
    const err = result.errors.find((e) => e.message === c.message);
    expect(err, JSON.stringify(result.errors)).toBeDefined();
    expect(err!.line).toBe(c.line);
    expect(err!.column).toBe(c.column);
    expect(result.success).toBe(false);
  });

  it("is accepted under iec with the feature turned on", () => {
    const result = compile(c.source, {
      dialect: "iec",
      features: [`+${c.feature}`],
    });
    expect(result.errors.map((e) => e.message)).not.toContain(c.message);
  });

  it("names the loaded profiles that have the feature", () => {
    const result = compile(c.source, {
      dialect: "iec",
      dialectPath: [GOOD],
      dialectIO: nodeDialectIO,
    });
    expect(result.errors.map((e) => e.message)).toContain(
      `${c.message} (profiles: vendor-a)`,
    );
  });
});

describe("IEC spellings stay accepted under iec", () => {
  it("REF_TO, REF() and ^ compile", () => {
    const src = `PROGRAM P
VAR
  x : INT;
  y : INT;
  r : REF_TO INT;
END_VAR
  r := REF(x);
  r^ := 5;
  y := r^;
END_PROGRAM
`;
    const result = compile(src, { dialect: "iec" });
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
  });

  it("THIS^ and SUPER^ compile", () => {
    const src = `FUNCTION_BLOCK Base
VAR_INPUT n : INT; END_VAR
METHOD Go
  n := n + 1;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK Derived EXTENDS Base
VAR b : Base; END_VAR
METHOD OVERRIDE Go
  SUPER^.Go();
  b := THIS^;
END_METHOD
END_FUNCTION_BLOCK
`;
    const result = compile(src, { dialect: "iec" });
    expect(
      result.errors.filter((e) => e.message.includes("needs the feature")),
    ).toEqual([]);
    expect(result.errors.filter((e) => e.message.includes("Expected"))).toEqual(
      [],
    );
  });
});

describe("a refusal is located where the construct is", () => {
  it("inside a METHOD", () => {
    const src = `FUNCTION_BLOCK Fb
METHOD M
VAR
  x : INT;
  p : POINTER TO INT;
END_VAR
  p := ADR(x);
END_METHOD
END_FUNCTION_BLOCK
`;
    const result = compile(src, { dialect: "iec" });
    const found = result.errors.map((e) => `${e.line}:${e.message}`);
    expect(found).toContain("5:POINTER TO needs the feature pointer_to");
    expect(found).toContain("7:ADR needs the feature pointer_to");
  });

  it("inside a PROPERTY GET", () => {
    const src = `FUNCTION_BLOCK Fb
VAR
  x : INT;
  w : INT;
  r : REF_TO INT;
END_VAR
PROPERTY Q : INT
  GET
    w := ADR(x);
    r REF= x;
    Q := x;
  END_GET
END_PROPERTY
END_FUNCTION_BLOCK
`;
    const result = compile(src, { dialect: "iec" });
    const found = result.errors.map((e) => `${e.line}:${e.message}`);
    expect(found).toContain("9:ADR needs the feature pointer_to");
    expect(found).toContain("10:REF= needs the feature ref_assign");
    expect(result.success).toBe(false);
  });

  it("inside a FUNCTION", () => {
    const src = `FUNCTION F : INT
VAR
  x : INT;
  r : REFERENCE TO INT;
  q : REF_TO INT;
END_VAR
  q := REF(x);
  q REF= x;
  F := 1;
END_FUNCTION
`;
    const result = compile(src, { dialect: "iec" });
    const found = result.errors.map((e) => `${e.line}:${e.message}`);
    expect(found).toContain("4:REFERENCE TO needs the feature reference_to");
    expect(found).toContain("8:REF= needs the feature ref_assign");
  });
});

describe("declarations outside a POU body are checked too", () => {
  const CONFIG_SRC = `PROGRAM P
VAR x : INT; END_VAR
  x := 1;
END_PROGRAM
CONFIGURATION C
VAR_GLOBAL
  gp : POINTER TO INT;
  gr : REFERENCE TO INT;
END_VAR
RESOURCE R ON PLC
  TASK T(INTERVAL := T#10ms, PRIORITY := 1);
  PROGRAM I WITH T : P;
END_RESOURCE
END_CONFIGURATION
`;

  it("POINTER TO and REFERENCE TO in a CONFIGURATION VAR_GLOBAL are refused under iec", () => {
    const result = compile(CONFIG_SRC, { dialect: "iec" });
    const found = result.errors.map((e) => `${e.line}:${e.message}`);
    expect(found).toContain("7:POINTER TO needs the feature pointer_to");
    expect(found).toContain("8:REFERENCE TO needs the feature reference_to");
    expect(result.success).toBe(false);
  });

  it("a CONFIGURATION VAR_GLOBAL pointer gives no refusal with no flag", () => {
    const result = compile(CONFIG_SRC);
    expect(
      result.errors.filter((e) => e.message.includes("needs the feature")),
    ).toEqual([]);
  });

  const INIT_SRC = `PROGRAM P
VAR
  x : INT;
  d : LWORD := ADR(x);
END_VAR
  x := 1;
END_PROGRAM
`;

  it("ADR in a variable's initial value is refused under iec", () => {
    const result = compile(INIT_SRC, { dialect: "iec" });
    const err = result.errors.find(
      (e) => e.message === "ADR needs the feature pointer_to",
    );
    expect(err, JSON.stringify(result.errors)).toBeDefined();
    expect(err!.line).toBe(4);
    expect(err!.column).toBe(16);
    expect(result.success).toBe(false);
  });

  it("ADR in a variable's initial value gives no refusal with no flag", () => {
    const result = compile(INIT_SRC);
    expect(
      result.errors.filter((e) => e.message.includes("needs the feature")),
    ).toEqual([]);
  });
});
