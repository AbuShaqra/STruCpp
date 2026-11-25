// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Every phase that can run on a file runs after an earlier phase's error:
 * compile and analyze report each distinct error of the file in one run, and
 * report no echo of an earlier error (a duplicate or a cascade).
 */
import { describe, it, expect } from "vitest";
import { analyze, compile, compileStlib } from "../../src/index.js";
import { SemanticAnalyzer } from "../../src/semantic/analyzer.js";
import { parse } from "../../src/frontend/parser.js";
import { buildAST } from "../../src/frontend/ast-builder.js";

type Options = Parameters<typeof compile>[1];

const MOD = "i := r MOD 2;";
const MOD_ERROR =
  "MOD takes integers (ANY_INT, IEC 61131-3 Table 29), not REAL";

/** A PROGRAM with the usual variables, `vars` added to its VAR block. */
const program = (body: string, vars = ""): string =>
  `PROGRAM Main\nVAR\n i : INT; r : REAL; p : DWORD; t : TIME; d : DATE; ldt0 : LDT; dt0 : DT; ${vars}\nEND_VAR\n${body}\nEND_PROGRAM\n`;

/** The errors of compile and of analyze as `line:column message`; both must agree. */
function errorsOf(source: string, options: Options = {}): string[] {
  const shown = (list: { line: number; column: number; message: string }[]) =>
    list.map((e) => `${e.line}:${e.column} ${e.message}`);
  const compiled = shown(compile(source, options).errors);
  expect(shown(analyze(source, options).errors)).toEqual(compiled);
  return compiled;
}

describe("errors hidden behind an earlier error are reported with it", () => {
  it("ADR without pointer_to after a type error (iec-3)", () => {
    expect(
      errorsOf(program(`${MOD}\np := ADR(i);`), { dialect: "iec-3" }),
    ).toEqual([`5:6 ${MOD_ERROR}`, "6:6 ADR needs the feature pointer_to"]);
  });

  it("XSIZEOF without vendor_operators after a type error (strict)", () => {
    expect(
      errorsOf(program(`${MOD}\ni := XSIZEOF(i);`), { strict: true }),
    ).toContain("6:6 XSIZEOF needs the feature vendor_operators");
    expect(
      errorsOf(program(`${MOD}\ni := XSIZEOF(i);`), { strict: true }),
    ).toContain(`5:6 ${MOD_ERROR}`);
  });

  it("an undeclared name after a type error", () => {
    expect(errorsOf(program(`${MOD}\ni := zz;`))).toEqual([
      `5:6 ${MOD_ERROR}`,
      "6:6 Undeclared variable 'zz'",
    ]);
  });

  it("a bit index out of range and a CONSTANT write after a type error", () => {
    expect(errorsOf(program(`${MOD}\ni.20 := TRUE;`))).toEqual([
      `5:6 ${MOD_ERROR}`,
      "6:1 Bit index 20 is out of range for type INT (0..15)",
    ]);
    expect(
      errorsOf(
        "PROGRAM Main\nVAR i : INT; r : REAL; END_VAR\nVAR CONSTANT k : INT := 1; END_VAR\ni := r MOD 2;\nk := 1;\nEND_PROGRAM\n",
      ),
    ).toEqual([
      `4:6 ${MOD_ERROR}`,
      "5:1 Cannot assign to CONSTANT variable 'k'",
    ]);
  });

  it("type errors after a duplicate declaration", () => {
    const dup = "3:74 Symbol 'i' already defined in scope 'Main'";
    expect(errorsOf(program("d := t;", "i : INT;"))).toEqual([
      dup,
      "5:6 Cannot assign TIME to DATE",
    ]);
    expect(errorsOf(program("dt0 := ldt0;", "i : INT;"))).toEqual([
      dup,
      "5:8 Cannot assign LDT to DT",
    ]);
    expect(errorsOf(program(MOD, "i : INT;"))).toEqual([
      dup,
      `5:6 ${MOD_ERROR}`,
    ]);
    expect(errorsOf(program("i := zz;", "i : INT;"))).toEqual([
      dup,
      "5:6 Undeclared variable 'zz'",
    ]);
  });

  it("a type error after a bad ARRAY bound", () => {
    expect(errorsOf(program(MOD, "arr : ARRAY[0..NOPE] OF INT;"))).toEqual([
      "3:89 The bounds of an ARRAY must be integer constants: 'NOPE' is not a constant",
      `5:6 ${MOD_ERROR}`,
    ]);
  });

  it("a type error after an unknown task in the CONFIGURATION", () => {
    expect(
      errorsOf(
        `${program(MOD)}CONFIGURATION C\nRESOURCE R ON PLC\nTASK T1(INTERVAL := T#10ms, PRIORITY := 1);\nPROGRAM I1 WITH TX : Main;\nEND_RESOURCE\nEND_CONFIGURATION\n`,
      ),
    ).toEqual([
      "10:1 Unknown task 'TX' in program instance 'I1'",
      `5:6 ${MOD_ERROR}`,
    ]);
  });

  it("a type error after a parse error elsewhere in the file", () => {
    expect(errorsOf(program(`${MOD}\ni := ;`))).toEqual([
      "6:6 Unexpected `;` after `:=` while parsing an expression.",
      `5:6 ${MOD_ERROR}`,
    ]);
  });

  it("a type error after an inline enumeration whose type name is taken", () => {
    expect(
      errorsOf(
        "PROGRAM A_B\nVAR c : (Red, Green); END_VAR\nc := Red;\nEND_PROGRAM\nPROGRAM A\nVAR b_c : (Cold, Hot); i : INT; r : REAL; END_VAR\nb_c := Hot;\ni := r MOD 2;\nEND_PROGRAM\n",
      ),
    ).toEqual([
      "6:11 The inline enumeration of 'A.b_c' and the inline enumeration of 'A_B.c' both use the type name '__INLINE_ENUM_A_B_C'; rename one of them.",
      `8:6 ${MOD_ERROR}`,
    ]);
  });
});

describe("no echo of an earlier error", () => {
  it("reports ADR of an expression once", () => {
    expect(errorsOf(program("p := ADR(3);"))).toEqual([
      "5:6 ADR() requires a variable reference, not an expression",
    ]);
  });

  it("does not count the arguments of a call whose binding was refused", () => {
    expect(
      errorsOf(
        "PROGRAM Main\nVAR s : STRING; END_VAR\ns := INSERT(P := 2, IN1 := s);\nEND_PROGRAM\n",
      ),
    ).toEqual(["3:6 Function 'INSERT' is missing parameter 'IN2'"]);
  });

  it("asks only for the inputs more than the misnamed arguments leave out", () => {
    const F =
      "FUNCTION F : INT\nVAR_INPUT a : INT; c : INT; d : INT; END_VAR\nF := a;\nEND_FUNCTION\n";
    expect(
      errorsOf(
        `${F}PROGRAM Main\nVAR i : INT; END_VAR\ni := F(b := 1, c := 2, d := 3);\nEND_PROGRAM\n`,
      ),
    ).toEqual(["7:8 Function 'F' has no parameter named 'B'"]);
    expect(
      errorsOf(
        `${F}PROGRAM Main\nVAR i : INT; END_VAR\ni := F(zz := 1);\nEND_PROGRAM\n`,
      ),
    ).toEqual([
      "7:8 Function 'F' has no parameter named 'ZZ'",
      "7:6 'F' is missing required inputs: A, C, D",
    ]);
    expect(
      errorsOf(
        "PROGRAM Main\nVAR i : INT; END_VAR\ni := LIMIT(MN := 1, MN := 2);\nEND_PROGRAM\n",
      ),
    ).toEqual([
      "3:21 Parameter 'MN' of 'LIMIT' is given more than once",
      "3:6 Function 'LIMIT' is missing parameter 'IN'",
      "3:6 Function 'LIMIT' is missing parameter 'MX'",
    ]);
  });

  it("does not report a name a global-list error left unresolved", () => {
    const found = errorsOf(
      "VAR_GLOBAL x : INT; END_VAR\nPROGRAM Main\nVAR i : INT; r : REAL; END_VAR\ni := GVL.nope;\ni := r MOD 2;\nEND_PROGRAM\n",
      { globalListName: "GVL", features: ["+named_global_lists"] },
    );
    expect(found).toEqual([
      "4:6 'NOPE' is not a variable of global variable list 'GVL'",
      `5:6 ${MOD_ERROR}`,
    ]);
  });

  it("reports a negative task INTERVAL once", () => {
    expect(
      errorsOf(
        `${program("i := 1;")}CONFIGURATION C\nRESOURCE R ON PLC\nTASK T1(INTERVAL := T#-10ms, PRIORITY := 1);\nPROGRAM I1 WITH T1 : Main;\nEND_RESOURCE\nEND_CONFIGURATION\n`,
      ),
    ).toEqual(["9:21 Task 'T1' INTERVAL must not be negative"]);
  });

  it("leaves out only the type errors a variable declared twice with two types makes", () => {
    // The uses of X in Main; X elsewhere, ZZ, and the other statements stay
    expect(
      errorsOf(
        "FUNCTION F : INT\nVAR_INPUT a : INT; END_VAR\nF := a + x;\nEND_FUNCTION\nFUNCTION_BLOCK FB2\nVAR x : INT; d : DATE; t : TIME; END_VAR\nx := 1; d := t;\nEND_FUNCTION_BLOCK\nPROGRAM Main\nVAR x : INT; x : STRING; i : INT; r : REAL; b : INT; END_VAR\nx := 'a';\ni := x + zz; b := r MOD 2;\nEND_PROGRAM\n",
      ),
    ).toEqual([
      "10:14 Symbol 'x' already defined in scope 'Main'",
      `12:19 ${MOD_ERROR}`,
      "7:14 Cannot assign TIME to DATE",
      "12:10 Undeclared variable 'zz'",
      "3:10 Undeclared variable 'x'",
    ]);
  });

  it("keeps a type error that does not depend on which declaration is taken", () => {
    // Only LEN(x) depends on X being INT or REAL; the other errors stay
    expect(
      errorsOf(
        "PROGRAM Main\nVAR x : INT; x : REAL; y : INT; d : DATE; t : TIME; r : REAL; b : BOOL; s : STRING; END_VAR\ny := x + zz;\nd := t; x := 1;\nIF x > 0 AND r MOD 2 = 0 THEN y := 1; END_IF\ny := x + s;\nb := (x > 1) AND (d = t);\ny := LEN(x) + r MOD 3;\nEND_PROGRAM\n",
      ),
    ).toEqual([
      "2:14 Symbol 'x' already defined in scope 'Main'",
      "4:6 Cannot assign TIME to DATE",
      `5:14 ${MOD_ERROR}`,
      "6:6 Operator '+' does not apply to STRING; join strings with CONCAT",
      `8:15 ${MOD_ERROR}`,
      "3:10 Undeclared variable 'zz'",
    ]);
  });

  it("checks a local that shadows a doubled name as itself", () => {
    expect(
      errorsOf(
        "VAR_GLOBAL g : INT; g : REAL; END_VAR\nFUNCTION_BLOCK FB\nVAR g : BOOL; d : DATE; t : TIME; r : REAL; END_VAR\ng := r MOD 2 = 1;\nd := t;\nEND_FUNCTION_BLOCK\n",
      ),
    ).toEqual([
      "1:21 Symbol 'g' already defined in scope 'global'",
      `4:6 ${MOD_ERROR}`,
      "5:6 Cannot assign TIME to DATE",
    ]);
  });

  it("does not take a global two CONFIGURATIONs declare for a doubled variable", () => {
    // As development: the type checks there run against the global as declared
    const cfg = (n: number, type: string): string =>
      `CONFIGURATION C${n}\nVAR_GLOBAL g : ${type}; END_VAR\nRESOURCE R${n} ON PLC\nTASK T${n}(INTERVAL := T#10ms, PRIORITY := 1);\nPROGRAM I${n} WITH T${n} : P;\nEND_RESOURCE\nEND_CONFIGURATION\n`;
    const src = `${cfg(1, "INT")}${cfg(2, "REAL")}PROGRAM P\nVAR_EXTERNAL g : INT; END_VAR\nVAR r : REAL; y : INT; END_VAR\ny := g + r MOD 2;\nIF g + r MOD 2 THEN y := 1; END_IF\nEND_PROGRAM\n`;
    const both = [
      "9:12 Global 'g' of CONFIGURATION C2 is also declared in CONFIGURATION C1; rename one of them",
      `18:10 ${MOD_ERROR}`,
    ];
    const condition = [
      `19:8 ${MOD_ERROR}`,
      "19:4 Condition must be a boolean or bit type, got REAL",
    ];
    expect(errorsOf(src)).toEqual([...both, ...condition]);
    expect(errorsOf(src, { strict: true })).toEqual([
      ...both,
      "18:6 Implicit conversion from REAL to INT is not allowed; use REAL_TO_INT",
      "19:29 Missing ';' after END_IF",
      ...condition,
    ]);
  });

  it("reports nothing that follows from a name the lexer read without a refused character", () => {
    expect(
      errorsOf(
        "TYPE NT : STRUCT a : INT; END_STRUCT; END_TYPE\nPROGRAM Main\nVAR xä : NT; x : INT; i : INT; r : REAL; END_VAR\nx := 1;\ni := r MOD 2;\nEND_PROGRAM\n",
      ),
    ).toEqual([
      "3:6 'ä' (U+00E4) is not allowed in a name: identifiers use A–Z, digits and _",
      `5:6 ${MOD_ERROR}`,
    ]);
  });

  it("reports T.M of an undefined type T once, as the undefined type", () => {
    expect(
      errorsOf(
        "PROGRAM Main\nVAR s : TrafficState; i : INT; END_VAR\nCASE s OF\n  TrafficState.RED: i := 1;\nEND_CASE;\ns := TrafficState.RED;\nEND_PROGRAM\n",
      ),
    ).toEqual([
      "2:9 Undefined type 'TrafficState' in PROGRAM 'Main'",
      "3:6 CASE selector must be an integer, bit, or enum type, got TRAFFICSTATE",
    ]);
    // Never declared as a type: an undeclared name, as before
    expect(
      errorsOf(
        "PROGRAM Main\nVAR i : INT; END_VAR\ni := Nope.RED;\nEND_PROGRAM\n",
      ),
    ).toEqual(["3:6 Undeclared variable 'Nope'"]);
  });

  it("still generates nothing after an error", () => {
    const r = compile(program(`${MOD}\ni := zz;`));
    expect(r.success).toBe(false);
    expect(r.cppCode).toBe("");
    expect(r.headerCode).toBe("");
  });
});

describe("what development's analysis reported stays", () => {
  const P = (body: string): string =>
    `PROGRAM Main\nVAR\n  i : INT;\n  r : REAL;\n  b : BOOL;\nEND_VAR\n${body}\nEND_PROGRAM\n`;

  it("an error before a syntax error on the same line", () => {
    expect(errorsOf(P("i := zz; i := 3 +;"))).toContain(
      "7:6 Undeclared variable 'zz'",
    );
    expect(errorsOf(P("i := r MOD 2; i := 3 +;"))).toContain(
      `7:6 ${MOD_ERROR}`,
    );
    expect(
      errorsOf(
        "PROGRAM Main\nVAR i : INT; END_VAR\ni := x $ 1;\nEND_PROGRAM\n",
      ),
    ).toContain("3:6 Undeclared variable 'x'");
  });

  it("a statement on the line after a missing semicolon", () => {
    expect(errorsOf(P("i := 1\ni := zz;"))).toContain(
      "8:6 Undeclared variable 'zz'",
    );
  });

  it("the statements of a file being typed (no END_PROGRAM yet)", () => {
    expect(
      errorsOf(
        "PROGRAM Main\nVAR\n  x : INT;\nEND_VAR\nx := missingVar + 1;\n",
      ),
    ).toContain("5:6 Undeclared variable 'missingVar'");
  });

  it("a misnamed argument of a FUNCTION declared twice", () => {
    expect(
      errorsOf(
        "FUNCTION F : INT\nVAR_INPUT a : INT; END_VAR\nF := a;\nEND_FUNCTION\nFUNCTION F : INT\nVAR_INPUT a : INT; END_VAR\nF := a;\nEND_FUNCTION\nPROGRAM Main\nVAR i : INT; END_VAR\ni := F(a := 1, b := 2);\nEND_PROGRAM\n",
      ),
    ).toContain("11:16 Function 'F' has no parameter named 'B'");
  });

  it("an undeclared name in a block whose base is undefined", () => {
    expect(
      errorsOf(
        "FUNCTION_BLOCK Der EXTENDS Basse\nVAR_INPUT q : INT; END_VAR\nq := 1; zz := 1;\nEND_FUNCTION_BLOCK\n",
      ),
    ).toContain("3:9 Undeclared variable 'zz'");
  });
});

describe("a pass that throws", () => {
  it("is reported, and the errors found before it stay", () => {
    const ast = buildAST(
      parse(
        "PROGRAM Main\nVAR i : INT; i : INT; END_VAR\ni := 1;\nEND_PROGRAM\n",
      ).cst!,
    );
    const analyzer = new SemanticAnalyzer();
    analyzer["typeChecker"].check = (): never => {
      throw new Error("boom");
    };
    const result = analyzer.analyze(ast);
    expect(result.errors.map((e) => e.message)).toEqual([
      "Symbol 'I' already defined in scope 'MAIN'",
      "Semantic analysis failed: boom",
    ]);
    expect(result.passFailed).toBe(true);
  });
});

describe("a library block's inherited members", () => {
  const lib = compileStlib(
    [
      {
        source:
          "FUNCTION_BLOCK FB_L\nVAR_INPUT inp : INT; END_VAR\nVAR_OUTPUT outp : INT; END_VAR\nVAR PUBLIC pub : INT; END_VAR\nVAR PRIVATE priv : INT; END_VAR\nVAR plain : INT; END_VAR\nEND_FUNCTION_BLOCK\n",
        fileName: "l.st",
      },
    ],
    { name: "inherit-lib", version: "1.0.0", namespace: "strucpp" },
  );

  it("are declared in a derived block, a PRIVATE one refused", () => {
    expect(lib.success).toBe(true);
    const errors = (body: string): string[] =>
      compile(
        `FUNCTION_BLOCK FB_K EXTENDS FB_L\nVAR q : INT; END_VAR\nMETHOD M : INT\n  M := ${body};\nEND_METHOD\nq := ${body};\nEND_FUNCTION_BLOCK\nPROGRAM Main\nVAR k : FB_K; END_VAR\nk();\nEND_PROGRAM\n`,
        { libraries: [lib.archive!] },
      ).errors.map((e) => `${e.line}:${e.message}`);
    expect(errors("inp + outp + pub + plain")).toEqual([]);
    expect(errors("priv").sort()).toEqual([
      "4:'PRIV' is a PRIVATE variable of FUNCTION_BLOCK 'FB_L'; only 'FB_L' itself can access it",
      "6:'PRIV' is a PRIVATE variable of FUNCTION_BLOCK 'FB_L'; only 'FB_L' itself can access it",
    ]);
    expect(errors("nope").sort()).toEqual([
      "4:Undeclared variable 'nope'",
      "6:Undeclared variable 'nope'",
    ]);
  });
});

describe("the shared-global in-out warning in the analysis", () => {
  const source = (tasks: string): string =>
    `FUNCTION Bump : INT\nVAR_IN_OUT x : INT; END_VAR\nx := x + 1; Bump := x;\nEND_FUNCTION\nPROGRAM P1\nVAR_EXTERNAL g : INT; END_VAR\nVAR r : INT; END_VAR\nr := Bump(x := g);\nEND_PROGRAM\nPROGRAM P2\nVAR_EXTERNAL g : INT; END_VAR\ng := g + 1;\nEND_PROGRAM\nCONFIGURATION C\nVAR_GLOBAL g : INT; END_VAR\nRESOURCE R ON PLC\n${tasks}END_RESOURCE\nEND_CONFIGURATION\n`;
  const ONE =
    "TASK T1(INTERVAL := T#10ms, PRIORITY := 1);\nPROGRAM I1 WITH T1 : P1;\nPROGRAM I2 WITH T1 : P2;\n";
  const TWO =
    "TASK T1(INTERVAL := T#10ms, PRIORITY := 1);\nTASK T2(INTERVAL := T#20ms, PRIORITY := 2);\nPROGRAM I1 WITH T1 : P1;\nPROGRAM I2 WITH T2 : P2;\n";
  const shared = (r: { warnings: { line: number; message: string }[] }) =>
    r.warnings
      .filter((w) => w.message.includes("the shared global 'g'"))
      .map((w) => `${w.line}:${w.message.slice(0, 54)}`);

  it("is given as the build gives it: more than one task, or threaded", () => {
    const warned = ["8:VAR_IN_OUT 'x' refers to the shared global 'g' during "];
    for (const [src, options] of [
      [source(TWO), {}],
      [source(ONE), { threaded: true }],
    ] as const) {
      expect(shared(analyze(src, options))).toEqual(warned);
      expect(shared(compile(src, options))).toEqual(warned);
    }
    expect(shared(analyze(source(ONE)))).toEqual([]);
    expect(shared(compile(source(ONE)))).toEqual([]);
  });

  it("carries the POU it is in", () => {
    const w = analyze(source(TWO)).warnings.find((x) =>
      x.message.includes("the shared global 'g'"),
    );
    expect(w?.pouName?.toUpperCase()).toBe("P1");
  });
});
