/**
 * An address (ADR(x), ADR(x) ± n, REF(x), a pointer value) stored into an
 * integer narrower than 64 bits is refused by one check, wherever it is
 * stored; the feature gate and an invalid operand come first.
 */
import { describe, it, expect } from "vitest";
import { compile, type CompileOptions } from "../../src/index.js";
import { parseTestFile } from "../../src/testing/test-parser.js";
import { analyzeTestFile } from "../../src/semantic/analyzer.js";

const TAIL = "use a POINTER TO or PVOID, or __XWORD, LWORD or ULINT";
const narrow = (at: string, op: string, t: string): string =>
  `${at}: ${op} gives a 64-bit address, which ${t} cannot hold; ${TAIL}`;
const errors = (src: string, opts: Partial<CompileOptions> = {}): string[] =>
  compile(src, opts)
    .errors.map((e) => `${e.line}:${e.column}: ${e.message}`)
    .sort();

const FUNCS = `FUNCTION F : UDINT
VAR_INPUT d : UDINT; END_VAR
F := d;
END_FUNCTION
FUNCTION_BLOCK FB
VAR_INPUT d : UDINT; END_VAR
END_FUNCTION_BLOCK
`;

describe("one check for an address stored in a narrow integer", () => {
  it("refuses it in a test file (#1)", () => {
    const src = compile(FUNCS + "PROGRAM P\nEND_PROGRAM\n");
    const parsed = parseTestFile(
      `TEST 'a'
VAR x : INT := 5; u : UDINT; v : UDINT := ADR(x); END_VAR
u := ADR(x);
u := F(ADR(x));
END_TEST
`,
      "t.st",
    );
    expect(parsed.errors).toEqual([]);
    expect(
      analyzeTestFile(parsed.testFile!, src.symbolTables!, src.ast)
        .errors.map((e) => `${e.line}:${e.column}: ${e.message}`)
        .sort(),
    ).toEqual(
      [
        narrow("2:43", "ADR", "UDINT"),
        narrow("3:6", "ADR", "UDINT"),
        narrow("4:8", "ADR", "UDINT"),
      ].sort(),
    );
  });

  it("gives only the feature error with pointer_to off (#2, #12)", () => {
    expect(
      errors(
        `${FUNCS}PROGRAM P
VAR x : INT; u : UDINT; fb : FB; c : UDINT := ADR(x); arr : ARRAY[0..1] OF UDINT := [ADR(x), 0]; END_VAR
u := F(ADR(x));
fb(d := ADR(x));
END_PROGRAM
`,
        { dialect: "iec-3" },
      ),
    ).toEqual(
      [
        "9:47: ADR needs the feature pointer_to",
        "9:86: ADR needs the feature pointer_to",
        "10:8: ADR needs the feature pointer_to",
        "11:9: ADR needs the feature pointer_to",
      ].sort(),
    );
  });

  it("gives only the operand error for an invalid operand (#3, #12)", () => {
    expect(
      errors(`${FUNCS}PROGRAM P
VAR u : UDINT; fb : FB; c : UDINT := ADR(5); END_VAR
u := F(ADR(5));
fb(d := ADR(5));
END_PROGRAM
`),
    ).toEqual(
      [
        "9:38: ADR() requires a variable reference, not an expression",
        "10:8: ADR() requires a variable reference, not an expression",
        "11:9: ADR() requires a variable reference, not an expression",
      ].sort(),
    );
  });

  it("refuses an alias or subrange of a narrow integer (#4, #11)", () => {
    expect(
      errors(`TYPE MyU : UDINT; END_TYPE
TYPE MySub : UDINT(0..100000); END_TYPE
FUNCTION F2 : MyU
VAR x : INT; END_VAR
F2 := ADR(x);
END_FUNCTION
PROGRAM P
VAR x : INT; a : MyU := ADR(x); b : MyU; s : MySub; END_VAR
b := ADR(x);
s := ADR(x);
END_PROGRAM
`),
    ).toEqual(
      [
        narrow("5:7", "ADR", "UDINT"),
        narrow("8:25", "ADR", "UDINT"),
        narrow("9:6", "ADR", "UDINT"),
        narrow("10:6", "ADR", "UDINT"),
      ].sort(),
    );
  });

  it("refuses address arithmetic (#5)", () => {
    expect(
      errors(`${FUNCS}PROGRAM P
VAR x : INT; u : UDINT; d : UDINT; v : UDINT := ADR(x) + 0; END_VAR
u := ADR(x) + d;
u := F(ADR(x) + 4);
END_PROGRAM
`),
    ).toEqual(
      [
        narrow("9:49", "ADR", "UDINT"),
        narrow("10:6", "ADR", "UDINT"),
        narrow("11:8", "ADR", "UDINT"),
      ].sort(),
    );
  });

  it("refuses a call through THIS^ (#6)", () => {
    expect(
      errors(
        `FUNCTION_BLOCK FB
VAR x : INT; u : UDINT; END_VAR
METHOD M : LWORD
VAR_INPUT q : UDINT; END_VAR
M := q;
END_METHOD
METHOD N : LWORD
u := THIS^.M(q := ADR(x));
END_METHOD
END_FUNCTION_BLOCK
`,
        { features: ["+self_caret"] },
      ),
    ).toEqual([narrow("8:19", "ADR", "UDINT")]);
  });

  it("refuses a pointer output captured into a narrow integer (#7)", () => {
    expect(
      errors(`FUNCTION_BLOCK FB_O
VAR_OUTPUT o : POINTER TO INT; END_VAR
END_FUNCTION_BLOCK
PROGRAM P
VAR fb : FB_O; u : UDINT; END_VAR
fb(o => u);
END_PROGRAM
`),
    ).toEqual([
      `6:9: The output 'O' gives a 64-bit address, which UDINT cannot hold; ${TAIL}`,
    ]);
  });

  it("refuses REF(x) into a narrow integer (#8)", () => {
    expect(
      errors(`PROGRAM P
VAR x : INT; u : UDINT; END_VAR
u := REF(x);
END_PROGRAM
`),
    ).toEqual([narrow("3:6", "REF", "UDINT")]);
  });

  it("refuses a store through a dereferenced pointer to a narrow integer (#10)", () => {
    expect(
      errors(`TYPE ST_P : STRUCT pu : POINTER TO UDINT; END_STRUCT; END_TYPE
PROGRAM P
VAR x : INT; u : UDINT; s : ST_P; pu : POINTER TO UDINT; rt : REF_TO UDINT; END_VAR
s.pu := ADR(u);
s.pu^ := ADR(x);
pu := ADR(u);
pu^ := ADR(x);
rt := REF(u);
rt^ := ADR(x);
END_PROGRAM
`),
    ).toEqual(
      [
        narrow("5:10", "ADR", "UDINT"),
        narrow("7:8", "ADR", "UDINT"),
        narrow("9:8", "ADR", "UDINT"),
      ].sort(),
    );
  });

  it("reports a repeated array-literal element once (#13)", () => {
    expect(
      errors(`PROGRAM P
VAR x : INT; r1 : ARRAY[0..3] OF UDINT := [4(ADR(x))]; END_VAR
END_PROGRAM
`),
    ).toEqual([narrow("2:46", "ADR", "UDINT")]);
  });

  it("accepts address arithmetic into a wide integer (#9)", () => {
    expect(
      errors(`TYPE MyL : LWORD; END_TYPE
PROGRAM P
VAR x : INT; ul : ULINT; lw : LWORD; ml : MyL; END_VAR
ul := ADR(x) + 0;
lw := ADR(x) + 4;
ml := ADR(x);
END_PROGRAM
`),
    ).toEqual([]);
  });
});
