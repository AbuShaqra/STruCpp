/**
 * Rules of the built-in profile `iec-3` that no feature controls: an
 * identifier with two consecutive underscores or a trailing one is an error,
 * and the forms Ed. 3 deprecates or leaves implementer-defined are warnings.
 * They apply under `--dialect iec-3` only: not with no flag, and not under a
 * profile that extends `iec-3`.
 */
import { describe, it, expect } from "vitest";
import { analyze, compile, type CompileOptions } from "../../src/index.js";
import { parseTestFile } from "../../src/testing/test-parser.js";
import { analyzeTestFile } from "../../src/semantic/analyzer.js";
import { resolveDialect, type DialectProfile } from "../../src/dialect.js";
import { compileStlib } from "../../src/library/library-compiler.js";

const IEC3: Partial<CompileOptions> = { dialect: "iec-3" };
/** A profile that extends iec-3 and adds nothing. */
const CHILD: DialectProfile = {
  id: "child",
  name: "child",
  extends: "iec-3",
  features: [],
  semantics: {},
};

const at = (d: { line: number; column: number; message: string }): string =>
  `${d.line}:${d.column}: ${d.message}`;

function errorsOf(source: string, opts: Partial<CompileOptions>): string[] {
  return compile(source, opts).errors.map(at);
}

/** The warnings that cite Ed. 3 (this file's rules). */
function ed3WarningsOf(
  source: string,
  opts: Partial<CompileOptions>,
): string[] {
  const result = compile(source, opts);
  expect(result.errors).toEqual([]);
  return result.warnings.filter((w) => w.message.includes("Ed. 3")).map(at);
}

const trailing = (name: string): string =>
  `Identifier '${name}' is not allowed in IEC 61131-3 Ed. 3: an identifier may not end with an underscore; rename it`;
const doubled = (name: string): string =>
  `Identifier '${name}' is not allowed in IEC 61131-3 Ed. 3: an identifier may not contain two consecutive underscores; rename it`;

describe("iec-3: identifiers (C5)", () => {
  const CASES: Array<{ what: string; source: string; errors: string[] }> = [
    {
      what: "variables, with a use reported once",
      source: `PROGRAM Main
VAR my__var : INT; count_ : INT; __lead : INT; ok_1 : INT; END_VAR
my__var := count_ + __lead + ok_1;
END_PROGRAM
`,
      errors: [
        `2:5: ${doubled("my__var")}`,
        `2:20: ${trailing("count_")}`,
        `2:34: ${doubled("__lead")}`,
      ],
    },
    {
      what: "POUs, methods and their parameters",
      source: `FUNCTION F_ : INT
VAR_INPUT in__x : INT; END_VAR
F_ := in__x;
END_FUNCTION
FUNCTION_BLOCK Fb__A
METHOD M_ : INT
M_ := 1;
END_METHOD
END_FUNCTION_BLOCK
INTERFACE I_
END_INTERFACE
PROGRAM P_
VAR f : Fb__A; x : INT; END_VAR
x := F_(in__x := 1) + f.M_();
END_PROGRAM
`,
      errors: [
        `1:10: ${trailing("F_")}`,
        `2:11: ${doubled("in__x")}`,
        `5:16: ${doubled("Fb__A")}`,
        `6:8: ${trailing("M_")}`,
        `10:11: ${trailing("I_")}`,
        `12:9: ${trailing("P_")}`,
      ],
    },
    {
      what: "types, struct fields and enumeration members",
      source: `TYPE E_s_ : (Idle_, run__now, Ok); END_TYPE
TYPE ST__P : STRUCT f_ : INT; g : INT; END_STRUCT END_TYPE
PROGRAM Main
VAR s : E_s_; p : ST__P; e : (In_line, Two_); END_VAR
s := E_s_#Idle_;
p.f_ := 1;
END_PROGRAM
`,
      errors: [
        `1:6: ${trailing("E_s_")}`,
        `1:14: ${trailing("Idle_")}`,
        `1:21: ${doubled("run__now")}`,
        `2:6: ${doubled("ST__P")}`,
        `2:21: ${trailing("f_")}`,
        `4:40: ${trailing("Two_")}`,
      ],
    },
    {
      what: "globals and CONFIGURATION names",
      source: `VAR_GLOBAL g_ : INT; END_VAR
PROGRAM Main
VAR x : INT; END_VAR
x := g_;
END_PROGRAM
CONFIGURATION Cfg_
RESOURCE Res__1 ON PLC
TASK T_ (INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM inst_ WITH T_ : Main;
END_RESOURCE
END_CONFIGURATION
`,
      errors: [
        `1:12: ${trailing("g_")}`,
        `6:15: ${trailing("Cfg_")}`,
        `7:10: ${doubled("Res__1")}`,
        `8:6: ${trailing("T_")}`,
        `9:9: ${trailing("inst_")}`,
      ],
    },
  ];

  describe.each(CASES)("$what", (c) => {
    it("is refused under iec-3", () => {
      expect(errorsOf(c.source, IEC3)).toEqual(c.errors);
    });

    it("is accepted with no dialect flag", () => {
      expect(errorsOf(c.source, {})).toEqual([]);
    });

    it("is accepted under a profile that extends iec-3", () => {
      expect(errorsOf(c.source, { dialect: CHILD })).toEqual([]);
    });
  });

  it("accepts single underscores inside a name", () => {
    const src = `PROGRAM Main
VAR a_b_c : INT; _x : INT; END_VAR
a_b_c := _x;
END_PROGRAM
`;
    expect(errorsOf(src, IEC3)).toEqual([]);
  });

  it("refuses an ACTION name and a property name", () => {
    const src = `FUNCTION_BLOCK FB_A
VAR v : INT; END_VAR
PROPERTY P_ : INT
GET P_ := v; END_GET
END_PROPERTY
ACTION Act_: v := 1; END_ACTION
END_FUNCTION_BLOCK
`;
    expect(
      errorsOf(src, {
        dialect: "iec-3",
        features: ["+fb_property", "+st_actions"],
      }),
    ).toEqual([`3:10: ${trailing("P_")}`, `6:8: ${trailing("Act_")}`]);
  });

  describe("names the compiler generates are exempt", () => {
    it("an inline enumeration and a property accessor with locals", () => {
      const src = `FUNCTION_BLOCK FB_A
VAR v : INT; e : (Idle, Busy); END_VAR
PROPERTY P : INT
GET
VAR t : INT; END_VAR
t := v; P := t;
END_GET
END_PROPERTY
END_FUNCTION_BLOCK
`;
      expect(
        errorsOf(src, { dialect: "iec-3", features: ["+fb_property"] }),
      ).toEqual([]);
    });

    it("the variables of an IL body with jumps", () => {
      const src = `FUNCTION_BLOCK FB_I
VAR_INPUT x : INT; END_VAR
VAR acc : INT; END_VAR
LD x
GT 0
JMPC done
LD 0
ST acc
done:
LD x
ST acc
END_FUNCTION_BLOCK
`;
      expect(errorsOf(src, IEC3)).toEqual([]);
    });

    it("a program method local that shadows a program member", () => {
      const src = `PROGRAM PRG_A
VAR x : INT; END_VAR
METHOD M : INT
VAR x : INT; END_VAR
x := 1; M := x + PRG_A.x;
END_METHOD
END_PROGRAM
`;
      expect(
        errorsOf(src, { dialect: "iec-3", features: ["+program_methods"] }),
      ).toEqual([]);
    });
  });

  it("does not refuse names that come from a library", () => {
    const lib = compileStlib(
      [
        {
          source: `FUNCTION Lib_F_ : INT
VAR_INPUT in__x : INT; END_VAR
Lib_F_ := in__x;
END_FUNCTION
`,
          fileName: "lib.st",
        },
      ],
      { name: "lib", version: "1.0.0", namespace: "lib" },
    );
    expect(lib.success).toBe(true);
    const src = `PROGRAM Main
VAR x : INT; END_VAR
x := Lib_F_(in__x := 2);
END_PROGRAM
`;
    expect(
      errorsOf(src, { dialect: "iec-3", libraries: [lib.archive!] }),
    ).toEqual([]);
  });
});

describe("iec-3: identifier errors do not hide later errors", () => {
  const src = `PROGRAM Main
VAR x_ : INT; p : POINTER TO INT; y : INT; END_VAR
p := ADR(y);
y := undeclared;
END_PROGRAM
`;

  it("compiling reports the same errors as checking, and no C++", () => {
    const compiled = compile(src, IEC3);
    const checked = analyze(src, IEC3).errors.map(at);
    expect(compiled.errors.map(at)).toEqual(checked);
    expect(compiled.errors.map(at)).toEqual([
      `2:5: ${trailing("x_")}`,
      "2:19: POINTER TO needs the feature pointer_to",
      "4:6: Undeclared variable 'UNDECLARED'",
      "3:6: ADR needs the feature pointer_to",
    ]);
    expect(compiled.success).toBe(false);
    expect(compiled.cppCode).toBe("");
  });

  it("an identifier error alone still produces no C++", () => {
    const compiled = compile(
      "PROGRAM Main\nVAR x_ : INT; END_VAR\nx_ := 1;\nEND_PROGRAM\n",
      IEC3,
    );
    expect(compiled.errors.map(at)).toEqual([`2:5: ${trailing("x_")}`]);
    expect(compiled.success).toBe(false);
    expect(compiled.cppCode).toBe("");
  });
});

describe("iec-3: Ed. 3 warnings (C8b)", () => {
  const CASES: Array<{ what: string; source: string; warnings: string[] }> = [
    {
      what: "{external} inline C++",
      source: `PROGRAM Main
VAR x : INT; END_VAR
{external x = 1; }
x := x + 1;
{external x = 2; }
END_PROGRAM
`,
      warnings: [
        "3:1: {external} inline C++ is not IEC 61131-3 Ed. 3: a pragma's contents are implementer-defined, so the code is not portable; write it in ST",
        "5:1: {external} inline C++ is not IEC 61131-3 Ed. 3: a pragma's contents are implementer-defined, so the code is not portable; write it in ST",
      ],
    },
    {
      what: "a real literal with an exponent and no decimal point",
      source: `PROGRAM Main
VAR r : REAL := 1E-4; l : LREAL; END_VAR
r := REAL#2e3 + 1.0E2 + 1.5;
l := -1E5;
r := REAL#-1E-4 + REAL#+2E1 + REAL#-1.0E2;
END_PROGRAM
`,
      warnings: [
        "2:17: Real literal '1E-4' has no decimal point, which IEC 61131-3 Ed. 3 requires before the exponent; write 1.0E-4",
        "3:6: Real literal 'REAL#2E3' has no decimal point, which IEC 61131-3 Ed. 3 requires before the exponent; write REAL#2.0E3",
        "4:7: Real literal '1E5' has no decimal point, which IEC 61131-3 Ed. 3 requires before the exponent; write 1.0E5",
        "5:6: Real literal 'REAL#-1E-4' has no decimal point, which IEC 61131-3 Ed. 3 requires before the exponent; write REAL#-1.0E-4",
        "5:19: Real literal 'REAL#+2E1' has no decimal point, which IEC 61131-3 Ed. 3 requires before the exponent; write REAL#+2.0E1",
      ],
    },
    {
      what: "a store to the FOR control variable in its loop",
      source: `PROGRAM Main
VAR i, j : INT; a : ARRAY[0..10] OF INT; END_VAR
FOR i := 1 TO 10 DO
  i := i + 1;
  FOR j := 0 TO 2 DO
    IF j > 0 THEN i := 0; END_IF;
  END_FOR;
  a[i] := i;
END_FOR;
i := 5;
END_PROGRAM
`,
      warnings: [
        "4:3: IEC 61131-3 Ed. 3 does not allow the FOR control variable 'I' to be changed in the loop body; use a WHILE or REPEAT loop to step it yourself",
        "6:19: IEC 61131-3 Ed. 3 does not allow the FOR control variable 'I' to be changed in the loop body; use a WHILE or REPEAT loop to step it yourself",
      ],
    },
    {
      what: "an octal literal",
      source: `PROGRAM Main
VAR x : INT := 8#17; b : BYTE; END_VAR
b := BYTE#8#7;
x := 16#1E + 2#101;
END_PROGRAM
`,
      warnings: [
        "2:16: Octal literal '8#17' is deprecated in IEC 61131-3 Ed. 3; write it in decimal or 16#F",
        "3:6: Octal literal 'BYTE#8#7' is deprecated in IEC 61131-3 Ed. 3; write it in decimal or BYTE#16#7",
      ],
    },
    {
      what: "an Instruction List body",
      source: `FUNCTION_BLOCK FB_I
VAR_INPUT x : INT; END_VAR
VAR acc : INT; END_VAR

  LD x
  ADD 1
  ST acc
END_FUNCTION_BLOCK
`,
      warnings: [
        "5:3: Instruction List (IL) is deprecated in IEC 61131-3 Ed. 3; write the body of 'FB_I' in ST",
      ],
    },
    {
      what: "an Instruction List body of a FINAL or ABSTRACT FUNCTION_BLOCK",
      source: `FUNCTION_BLOCK FINAL FB_F
VAR_INPUT x : INT; END_VAR
VAR acc : INT; END_VAR

  LD x
  ST acc
END_FUNCTION_BLOCK
FUNCTION_BLOCK ABSTRACT FB_A
VAR_INPUT x : INT; END_VAR
VAR acc : INT; END_VAR

  LD x
  ST acc
END_FUNCTION_BLOCK
`,
      warnings: [
        "5:3: Instruction List (IL) is deprecated in IEC 61131-3 Ed. 3; write the body of 'FB_F' in ST",
        "12:3: Instruction List (IL) is deprecated in IEC 61131-3 Ed. 3; write the body of 'FB_A' in ST",
      ],
    },
    {
      what: "untyped TRUNC",
      source: `PROGRAM Main
VAR r : REAL := 2.5; d : DINT; END_VAR
d := TRUNC(r);
d := TRUNC_DINT(r) + REAL_TRUNC_DINT(r);
END_PROGRAM
`,
      warnings: [
        "3:6: TRUNC with no result type is deprecated in IEC 61131-3 Ed. 3; write the typed form TRUNC_<type>, such as TRUNC_DINT",
      ],
    },
  ];

  describe.each(CASES)("$what", (c) => {
    it("warns under iec-3", () => {
      expect(ed3WarningsOf(c.source, IEC3)).toEqual(c.warnings);
    });

    it("does not warn with no dialect flag", () => {
      expect(ed3WarningsOf(c.source, {})).toEqual([]);
    });

    it("does not warn under a profile that extends iec-3", () => {
      expect(ed3WarningsOf(c.source, { dialect: CHILD })).toEqual([]);
    });
  });

  it("does not warn at a user FUNCTION named TRUNC", () => {
    const src = `FUNCTION TRUNC : DINT
VAR_INPUT v : REAL; END_VAR
TRUNC := 0;
END_FUNCTION
PROGRAM Main
VAR d : DINT; END_VAR
d := TRUNC(1.5);
END_PROGRAM
`;
    expect(ed3WarningsOf(src, IEC3)).toEqual([]);
  });

  it("does not warn where TRUNC names a METHOD of the FB or of its base", () => {
    const src = `FUNCTION_BLOCK FB_B
METHOD TRUNC : DINT
VAR_INPUT v : LREAL; END_VAR
TRUNC := 1;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_T EXTENDS FB_B
VAR d : DINT; END_VAR
METHOD M : DINT
M := TRUNC(2.5);
END_METHOD
d := TRUNC(1.5);
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_U
VAR d : DINT; END_VAR
d := TRUNC(1.5);
END_FUNCTION_BLOCK
`;
    expect(ed3WarningsOf(src, IEC3)).toEqual([
      "16:6: TRUNC with no result type is deprecated in IEC 61131-3 Ed. 3; write the typed form TRUNC_<type>, such as TRUNC_DINT",
    ]);
  });

  it("does not warn where TRUNC names an ACTION of the PROGRAM", () => {
    const src = `PROGRAM Main
VAR d : DINT; END_VAR
TRUNC();
ACTION TRUNC:
d := 1;
END_ACTION
END_PROGRAM
PROGRAM Other
VAR d : DINT; END_VAR
d := TRUNC(2.5);
END_PROGRAM
`;
    expect(
      ed3WarningsOf(src, { dialect: "iec-3", features: ["+st_actions"] }),
    ).toEqual([
      "10:6: TRUNC with no result type is deprecated in IEC 61131-3 Ed. 3; write the typed form TRUNC_<type>, such as TRUNC_DINT",
    ]);
  });

  it("warns once at a STRUCT field default inherited through EXTENDS", () => {
    const src = `TYPE ST_A : STRUCT r : REAL := 1E3; END_STRUCT END_TYPE
TYPE ST_B EXTENDS ST_A : STRUCT s : INT; END_STRUCT END_TYPE
PROGRAM Main
VAR b : ST_B; END_VAR
b.s := 1;
END_PROGRAM
`;
    expect(
      ed3WarningsOf(src, { dialect: "iec-3", features: ["+struct_extends"] }),
    ).toEqual([
      "1:32: Real literal '1E3' has no decimal point, which IEC 61131-3 Ed. 3 requires before the exponent; write 1.0E3",
    ]);
  });
});

/** Diagnostics of a test file run against `source`, both under `opts`. */
function testFileResult(
  source: string,
  test: string,
  opts: Partial<CompileOptions>,
): { errors: string[]; warnings: string[] } {
  const src = compile(source, opts);
  expect(src.errors).toEqual([]);
  const parsed = parseTestFile(test, "t.st", opts);
  expect(parsed.errors).toEqual([]);
  const result = analyzeTestFile(
    parsed.testFile!,
    src.symbolTables!,
    src.ast,
    resolveDialect(opts),
  );
  return {
    errors: result.errors.map(at),
    warnings: result.warnings
      .filter((w) => w.message.includes("Ed. 3"))
      .map(at),
  };
}

describe("iec-3 rules in test files", () => {
  const SOURCE = `PROGRAM Main
VAR x : INT; END_VAR
x := 1;
END_PROGRAM
`;
  const TEST = `SETUP
VAR s__v : INT; END_VAR
s__v := 8#7;
END_SETUP
TEST 'rules'
VAR n_ : INT; i : INT; r : REAL; d : DINT; e : (A_, B); END_VAR
r := 1E2;
d := TRUNC(r);
FOR i := 0 TO 3 DO i := 3; END_FOR;
ASSERT_EQ(n_, 0);
END_TEST
`;

  it("refuses the names and warns under iec-3", () => {
    expect(testFileResult(SOURCE, TEST, IEC3)).toEqual({
      errors: [
        `2:5: ${doubled("S__V")}`,
        `6:5: ${trailing("N_")}`,
        `6:49: ${trailing("A_")}`,
      ],
      warnings: [
        "3:9: Octal literal '8#7' is deprecated in IEC 61131-3 Ed. 3; write it in decimal or 16#7",
        "7:6: Real literal '1E2' has no decimal point, which IEC 61131-3 Ed. 3 requires before the exponent; write 1.0E2",
        "8:6: TRUNC with no result type is deprecated in IEC 61131-3 Ed. 3; write the typed form TRUNC_<type>, such as TRUNC_DINT",
        "9:20: IEC 61131-3 Ed. 3 does not allow the FOR control variable 'I' to be changed in the loop body; use a WHILE or REPEAT loop to step it yourself",
      ],
    });
  });

  it("is clean with no flag and under a profile that extends iec-3", () => {
    const clean = { errors: [], warnings: [] };
    expect(testFileResult(SOURCE, TEST, {})).toEqual(clean);
    expect(testFileResult(SOURCE, TEST, { dialect: CHILD })).toEqual(clean);
  });
});

describe("iec-3 and --strict: underscores in numeric literals (Table 5)", () => {
  const underscore = (spelling: string): string =>
    `An underscore in a numeric literal must stand between two digits (IEC 61131-3 Ed. 3): '${spelling}'`;
  /** A vendor-like profile: extends iec-3 and adds features, as TwinCAT or CODESYS does. */
  const VENDOR: DialectProfile = {
    id: "vendor-like",
    name: "vendor-like",
    extends: "iec-3",
    features: ["pointer_to", "reference_to", "fb_property", "st_actions"],
    semantics: {},
  };
  const source = (type: string, literal: string): string => `PROGRAM Main
VAR x : ${type}; END_VAR
x := ${literal};
END_PROGRAM
`;
  const REFUSED: Array<[string, string]> = [
    ["TIME", "T#_1s"],
    ["TIME", "T#1__000ms"],
    ["TIME", "T#1_ms"],
    ["TIME", "T#_s"],
    ["TIME", "T#1._5s"],
    ["LTIME", "LT#1_ms"],
    ["LTIME", "LTIME#-_1s"],
    ["DINT", "1__0"],
    ["DINT", "10_"],
    ["DINT", "16#_FF"],
    ["DINT", "16#FF_"],
    ["DINT", "2#1__0"],
    ["INT", "INT#5_"],
    ["INT", "INT#16#_F"],
    ["REAL", "REAL#1_.5"],
    ["CHAR", "CHAR#16#_41"],
    ["CHAR", "CHAR#6_5_"],
  ];
  const ACCEPTED: Array<[string, string]> = [
    ["DINT", "1_000"],
    ["DINT", "16#FF_FF"],
    ["DINT", "2#1010_1010"],
    ["INT", "INT#-1_0"],
    ["INT", "INT#16#F_F"],
    ["REAL", "REAL#1_0.5"],
    ["TIME", "T#1d_2h"],
    ["TIME", "T#1s_500ms"],
    ["TIME", "T#1_000ms"],
    ["TIME", "T#1.5_0s"],
    ["LTIME", "LTIME#1d_2h_3m"],
    ["CHAR", "CHAR#6_5"],
    ["CHAR", "CHAR#'_'"],
  ];

  for (const [type, literal] of REFUSED) {
    it(`refuses ${literal} under iec-3 and --strict, accepts it otherwise`, () => {
      const src = source(type, literal);
      const error = [`3:6: ${underscore(literal)}`];
      expect(errorsOf(src, IEC3)).toEqual(error);
      expect(errorsOf(src, { strict: true })).toEqual(error);
      expect(errorsOf(src, { dialect: VENDOR, strict: true })).toEqual(error);
      expect(errorsOf(src, {})).toEqual([]);
      expect(errorsOf(src, { dialect: VENDOR })).toEqual([]);
      expect(errorsOf(src, { dialect: CHILD })).toEqual([]);
    });
  }

  for (const [type, literal] of ACCEPTED) {
    it(`accepts ${literal} in every mode`, () => {
      const src = source(type, literal);
      for (const opts of [IEC3, { strict: true }, {}, { dialect: VENDOR }]) {
        expect(errorsOf(src, opts)).toEqual([]);
      }
    });
  }

  it("checks STRING[...] and STRING(...) lengths, ARRAY bounds and CASE labels", () => {
    const src = `PROGRAM Main
VAR s : STRING[1__0]; w : WSTRING(2_0_); a : ARRAY[0..1__0] OF INT; ok : STRING[1_0]; i : INT; END_VAR
CASE i OF 1__2: i := 0; END_CASE;
END_PROGRAM
`;
    const errors = [
      `2:16: ${underscore("1__0")}`,
      `2:35: ${underscore("2_0_")}`,
      `2:55: ${underscore("1__0")}`,
      `3:11: ${underscore("1__2")}`,
    ];
    expect(errorsOf(src, IEC3)).toEqual(errors);
    expect(errorsOf(src, { strict: true })).toEqual(errors);
    expect(errorsOf(src, {})).toEqual([]);
    expect(errorsOf(src, { dialect: VENDOR })).toEqual([]);
  });

  it("reports the literal as written, in each file, with analyze() too", () => {
    const opts: Partial<CompileOptions> = {
      ...IEC3,
      fileName: "a.st",
      additionalSources: [
        {
          fileName: "b.st",
          source: `FUNCTION F : TIME\nF := t#1_Ms;\nEND_FUNCTION\n`,
        },
      ],
    };
    const src = `PROGRAM Main\nVAR x : DINT := 16#ff_; END_VAR\nEND_PROGRAM\n`;
    const located = (d: {
      file?: string;
      line: number;
      column: number;
      message: string;
    }): string => `${d.file}:${at(d)}`;
    const expected = [
      `a.st:2:17: ${underscore("16#ff_")}`,
      `b.st:2:6: ${underscore("t#1_Ms")}`,
    ];
    expect(compile(src, opts).errors.map(located)).toEqual(expected);
    expect(analyze(src, opts).errors.map(located)).toEqual(expected);
  });

  it("ignores underscores in comments and strings", () => {
    const src = `PROGRAM Main
VAR s : STRING; END_VAR
(* 1__0 T#_1s *) // 10_
s := '1__0 T#_s';
END_PROGRAM
`;
    expect(errorsOf(src, IEC3)).toEqual([]);
    expect(errorsOf(src, { strict: true })).toEqual([]);
  });

  it("checks test files under iec-3", () => {
    const SOURCE = `PROGRAM Main
VAR x : INT; END_VAR
x := 1;
END_PROGRAM
`;
    const TEST = `TEST 'u'
VAR t : TIME := T#1_ms; d : DINT; END_VAR
d := 10_;
ASSERT_EQ(d, 1_0);
END_TEST
`;
    // A test file's AST holds the literal upper-cased, as its names.
    const errors = [
      `2:17: ${underscore("T#1_MS")}`,
      `3:6: ${underscore("10_")}`,
    ];
    expect(testFileResult(SOURCE, TEST, IEC3).errors).toEqual(errors);
    expect(testFileResult(SOURCE, TEST, {}).errors).toEqual([]);
    expect(testFileResult(SOURCE, TEST, { dialect: VENDOR }).errors).toEqual(
      [],
    );
  });
});
