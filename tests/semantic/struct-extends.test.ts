/**
 * `TYPE ST_B EXTENDS ST_A : STRUCT ... END_STRUCT END_TYPE`: a STRUCT that
 * inherits the fields of another (feature struct_extends; in neither the
 * default set nor `iec-3`). The derived struct holds the base fields first,
 * then its own. Two structured variables are assignment-compatible only when
 * they have the same type (IEC 61131-3 Ed. 3, 6.4.4.6), so neither
 * derived-to-base nor base-to-derived assignment is accepted.
 */
import { describe, it, expect } from "vitest";
import { compile, compileStlib, parse } from "../../src/index.js";
import { buildAST } from "../../src/frontend/ast-builder.js";
import { parse as parseCst } from "../../src/frontend/parser.js";
import { SemanticAnalyzer } from "../../src/semantic/analyzer.js";
import type { DialectProfile } from "../../src/dialect.js";
import type {
  CompilationUnit,
  StructDefinition,
} from "../../src/frontend/ast.js";

type Options = Parameters<typeof compile>[1];

const STRUCT_PROFILE: DialectProfile = {
  id: "structs",
  name: "structs",
  extends: "iec-3",
  features: ["struct_extends"],
  semantics: {},
};

const ON: Options = { features: ["+struct_extends"] };

const MODES: { name: string; options: Options }[] = [
  { name: "no dialect", options: {} },
  { name: "iec-3", options: { dialect: "iec-3" } },
];

const FEATURE_MESSAGE = "EXTENDS on a STRUCT needs the feature struct_extends";

const TYPES = `TYPE
  ST_A : STRUCT a1 : INT := 7; a2 : BOOL; END_STRUCT;
  ST_B EXTENDS ST_A : STRUCT b1 : INT := 3; END_STRUCT;
END_TYPE
`;

function messages(source: string, options: Options = {}): string[] {
  return compile(source, options).errors.map(
    (e) => `${e.line}:${e.column} ${e.message}`,
  );
}

/** A program over TYPES whose body is `body`. */
function program(body: string, vars = "a : ST_A; b : ST_B; i : INT;"): string {
  return `${TYPES}PROGRAM P
VAR ${vars} END_VAR
${body}
END_PROGRAM
`;
}

function struct(
  ast: CompilationUnit | undefined,
  name: string,
): StructDefinition {
  const decl = ast?.types.find((t) => t.name === name);
  if (decl?.definition.kind !== "StructDefinition") {
    throw new Error(`no STRUCT ${name}`);
  }
  return decl.definition;
}

function fieldNames(def: StructDefinition): string[] {
  return def.fields.flatMap((f) => f.names);
}

describe("STRUCT EXTENDS needs the feature struct_extends", () => {
  for (const mode of MODES) {
    it(`is refused at the EXTENDS keyword, with no follow-up error (${mode.name})`, () => {
      expect(
        messages(
          program(
            "b.a1 := 1; b.b1 := b.a1;",
            "a : ST_A; b : ST_B := (a1 := 1, b1 := 2);",
          ),
          mode.options,
        ),
      ).toEqual([`3:8 ${FEATURE_MESSAGE}`]);
    });
  }

  it("names the loaded profiles that have it", () => {
    expect(
      messages(program("b.a1 := 1;"), {
        dialect: "iec-3",
        dialectFiles: ["structs.json"],
        dialectIO: {
          readFile: () => JSON.stringify(STRUCT_PROFILE),
          listDir: () => [],
        },
      }),
    ).toEqual([`3:8 ${FEATURE_MESSAGE} (profiles: structs)`]);
  });

  it("is accepted with +struct_extends in every mode and through a profile", () => {
    for (const mode of MODES) {
      expect(
        messages(program("b.a1 := 1;"), {
          ...mode.options,
          features: ["+struct_extends"],
        }),
      ).toEqual([]);
    }
    expect(
      messages(program("b.a1 := 1;"), { dialect: STRUCT_PROFILE }),
    ).toEqual([]);
  });
});

describe("a derived STRUCT holds the base fields first, then its own", () => {
  it("flattens a chain of three, base fields first", () => {
    const source = `TYPE
  ST_C EXTENDS ST_B : STRUCT c1 : REAL; END_STRUCT;
  ST_A : STRUCT a1 : INT; a2, a3 : BOOL; END_STRUCT;
  ST_B EXTENDS ST_A : STRUCT b1 : INT; END_STRUCT;
END_TYPE
PROGRAM P
VAR c : ST_C; END_VAR
c.a1 := 1; c.a3 := TRUE; c.b1 := c.a1; c.c1 := 2.5;
END_PROGRAM
`;
    const result = compile(source, ON);
    expect(result.errors).toEqual([]);
    expect(fieldNames(struct(result.ast, "ST_C"))).toEqual([
      "A1",
      "A2",
      "A3",
      "B1",
      "C1",
    ]);
    expect(fieldNames(struct(result.ast, "ST_B"))).toEqual([
      "A1",
      "A2",
      "A3",
      "B1",
    ]);
    expect(struct(result.ast, "ST_C").inheritedDeclarations).toBe(3);
    expect(struct(result.ast, "ST_A").inheritedDeclarations).toBeUndefined();
  });

  it("emits the same C++ as the struct written out in full", () => {
    const body = "b.a1 := 1; b.b1 := b.a1; i := b.b1;";
    const derived = compile(program(body), ON);
    const written = compile(
      program(body).replace(
        "ST_B EXTENDS ST_A : STRUCT b1 : INT := 3; END_STRUCT;",
        "ST_B : STRUCT a1 : INT := 7; a2 : BOOL; b1 : INT := 3; END_STRUCT;",
      ),
    );
    expect(derived.errors).toEqual([]);
    expect(written.errors).toEqual([]);
    expect(derived.headerCode).toBe(written.headerCode);
    expect(derived.cppCode).toBe(written.cppCode);
    expect(derived.headerCode).toContain("struct STRUCPP_MAY_ALIAS ST_B {");
    expect(derived.headerCode).not.toMatch(/struct (STRUCPP_MAY_ALIAS )?ST_B\s*:/);
  });

  it("sets inherited fields in a structure initializer", () => {
    expect(
      messages(
        program(
          "b2 := b;",
          "b : ST_B := (a1 := 5, a2 := TRUE, b1 := 6); b2 : ST_B;",
        ),
        ON,
      ),
    ).toEqual([]);
  });

  it("keeps the base declaration's span and file on an inherited field", () => {
    const result = compile(
      `TYPE ST_B EXTENDS ST_A : STRUCT b1 : INT; END_STRUCT; END_TYPE
PROGRAM P VAR b : ST_B; END_VAR b.a1 := 1; END_PROGRAM
`,
      {
        ...ON,
        fileName: "main.st",
        additionalSources: [
          {
            fileName: "types.st",
            source:
              "TYPE\n  ST_A : STRUCT\n    a1 : INT;\n  END_STRUCT;\nEND_TYPE\n",
          },
        ],
      },
    );
    expect(result.errors).toEqual([]);
    const b = struct(result.ast, "ST_B");
    const a = struct(result.ast, "ST_A");
    expect(b.fields[0]!.sourceSpan).toEqual(a.fields[0]!.sourceSpan);
    expect(b.fields[0]!.sourceSpan).toMatchObject({
      file: "types.st",
      startLine: 3,
    });
    expect(b.fields[0]).not.toBe(a.fields[0]);
    expect(b.fields[1]!.sourceSpan.file).toBe("main.st");
  });

  it("gives the same result when the same AST is analysed twice", () => {
    const parsed = parseCst(program("b.a1 := 1;"));
    const ast = buildAST(parsed.cst!);
    const features = new Set(["struct_extends"]);
    const first = new SemanticAnalyzer({ features }).analyze(ast);
    const second = new SemanticAnalyzer({ features }).analyze(ast);
    expect(first.errors).toEqual([]);
    expect(second.errors).toEqual([]);
    expect(fieldNames(struct(ast, "ST_B"))).toEqual(["A1", "A2", "B1"]);
  });

  it("leaves the AST of a file without EXTENDS untouched", () => {
    const source = "TYPE ST_A : STRUCT a1 : INT; END_STRUCT; END_TYPE\n";
    const before = JSON.stringify(parse(source).ast);
    const result = compile(source, ON);
    expect(JSON.stringify(result.ast).length).toBeGreaterThan(0);
    expect(JSON.stringify(parse(source).ast)).toBe(before);
    expect(struct(result.ast, "ST_A")).not.toHaveProperty(
      "inheritedDeclarations",
    );
  });
});

describe("a STRUCT base that cannot be inherited is refused", () => {
  const cases: { name: string; source: string; expected: string[] }[] = [
    {
      name: "an undefined base",
      source: "TYPE ST_B EXTENDS ST_X : STRUCT b1 : INT; END_STRUCT; END_TYPE",
      expected: [
        "1:19 Undefined type 'ST_X' in EXTENDS clause of STRUCT 'ST_B'",
      ],
    },
    {
      name: "a FUNCTION_BLOCK",
      source:
        "FUNCTION_BLOCK FB_X VAR x : INT; END_VAR END_FUNCTION_BLOCK\nTYPE ST_B EXTENDS FB_X : STRUCT b1 : INT; END_STRUCT; END_TYPE",
      expected: [
        "2:19 STRUCT 'ST_B' cannot extend 'FB_X', a FUNCTION_BLOCK: the base must be a STRUCT",
      ],
    },
    {
      name: "an INTERFACE",
      source:
        "INTERFACE I_X END_INTERFACE\nTYPE ST_B EXTENDS I_X : STRUCT b1 : INT; END_STRUCT; END_TYPE",
      expected: [
        "2:19 STRUCT 'ST_B' cannot extend 'I_X', an INTERFACE: the base must be a STRUCT",
      ],
    },
    {
      name: "an enumeration",
      source:
        "TYPE E_X : (X1, X2); ST_B EXTENDS E_X : STRUCT b1 : INT; END_STRUCT; END_TYPE",
      expected: [
        "1:35 STRUCT 'ST_B' cannot extend 'E_X', an enumeration: the base must be a STRUCT",
      ],
    },
    {
      name: "an alias of a STRUCT",
      source:
        "TYPE ST_A : STRUCT a1 : INT; END_STRUCT; T_AL : ST_A; ST_B EXTENDS T_AL : STRUCT b1 : INT; END_STRUCT; END_TYPE",
      expected: [
        "1:68 STRUCT 'ST_B' cannot extend 'T_AL', an alias: the base must be a STRUCT",
      ],
    },
    {
      name: "an ARRAY type",
      source:
        "TYPE T_ARR : ARRAY[1..2] OF INT; ST_B EXTENDS T_ARR : STRUCT b1 : INT; END_STRUCT; END_TYPE",
      expected: [
        "1:47 STRUCT 'ST_B' cannot extend 'T_ARR', an ARRAY type: the base must be a STRUCT",
      ],
    },
    {
      name: "an elementary type",
      source: "TYPE ST_B EXTENDS INT : STRUCT b1 : INT; END_STRUCT; END_TYPE",
      expected: [
        "1:19 STRUCT 'ST_B' cannot extend 'INT', an elementary type: the base must be a STRUCT",
      ],
    },
    {
      name: "itself",
      source: "TYPE ST_A EXTENDS ST_A : STRUCT a1 : INT; END_STRUCT; END_TYPE",
      expected: ["1:19 Circular EXTENDS in STRUCT 'ST_A': ST_A EXTENDS ST_A"],
    },
    {
      name: "a cycle of two",
      source: `TYPE
  ST_A EXTENDS ST_B : STRUCT a1 : INT; END_STRUCT;
  ST_B EXTENDS ST_A : STRUCT b1 : INT; END_STRUCT;
END_TYPE`,
      expected: [
        "2:16 Circular EXTENDS in STRUCT 'ST_A': ST_A EXTENDS ST_B EXTENDS ST_A",
        "3:16 Circular EXTENDS in STRUCT 'ST_B': ST_B EXTENDS ST_A EXTENDS ST_B",
      ],
    },
    {
      name: "a cycle of three, and a struct extending into it",
      source: `TYPE
  ST_A EXTENDS ST_C : STRUCT a1 : INT; END_STRUCT;
  ST_B EXTENDS ST_A : STRUCT b1 : INT; END_STRUCT;
  ST_C EXTENDS ST_B : STRUCT c1 : INT; END_STRUCT;
  ST_D EXTENDS ST_A : STRUCT d1 : INT; END_STRUCT;
END_TYPE`,
      expected: [
        "2:16 Circular EXTENDS in STRUCT 'ST_A': ST_A EXTENDS ST_C EXTENDS ST_B EXTENDS ST_A",
        "3:16 Circular EXTENDS in STRUCT 'ST_B': ST_B EXTENDS ST_A EXTENDS ST_C EXTENDS ST_B",
        "4:16 Circular EXTENDS in STRUCT 'ST_C': ST_C EXTENDS ST_B EXTENDS ST_A EXTENDS ST_C",
      ],
    },
    {
      name: "a field already inherited, in any case",
      source: `TYPE
  ST_A : STRUCT a1 : INT; END_STRUCT;
  ST_B EXTENDS ST_A : STRUCT b1 : INT; END_STRUCT;
  ST_C EXTENDS ST_B : STRUCT A1 : REAL; c1 : INT; B1 : INT; END_STRUCT;
END_TYPE`,
      expected: [
        "4:30 Field 'A1' of STRUCT 'ST_C' is already inherited from 'ST_A'",
        "4:51 Field 'B1' of STRUCT 'ST_C' is already inherited from 'ST_B'",
      ],
    },
    {
      name: "EXTENDS on a TYPE that is not a STRUCT",
      source:
        "TYPE ST_A : STRUCT a1 : INT; END_STRUCT; T_X EXTENDS ST_A : INT; END_TYPE",
      expected: ["1:46 EXTENDS on TYPE 'T_X' needs a STRUCT definition"],
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(messages(c.source, ON)).toEqual(c.expected);
    });
  }

  it("refuses a STRUCT from a library as the base", () => {
    const lib = compileStlib(
      [
        {
          fileName: "lib.st",
          source: "TYPE ST_LIB : STRUCT l1 : INT := 4; END_STRUCT; END_TYPE",
        },
      ],
      { name: "libs", version: "1.0.0", namespace: "libs" },
    );
    expect(lib.success, JSON.stringify(lib.errors)).toBe(true);
    expect(
      messages(
        "TYPE ST_B EXTENDS ST_LIB : STRUCT b1 : INT; END_STRUCT; END_TYPE",
        { ...ON, libraries: [lib.archive] },
      ),
    ).toEqual([
      "1:19 STRUCT 'ST_B' cannot extend 'ST_LIB', a STRUCT from a library: the base must be declared in the compiled sources",
    ]);
  });

  it("reports both the feature and a bad base", () => {
    expect(
      messages(
        "TYPE ST_B EXTENDS ST_X : STRUCT b1 : INT; END_STRUCT; END_TYPE",
      ),
    ).toEqual([
      `1:11 ${FEATURE_MESSAGE}`,
      "1:19 Undefined type 'ST_X' in EXTENDS clause of STRUCT 'ST_B'",
    ]);
  });
});

describe("a derived STRUCT is assignment-compatible only with its own type", () => {
  const relation =
    "a structured variable is assignment-compatible only with the same type (ST_B EXTENDS ST_A)";
  const decls = `FUNCTION F_IN : INT VAR_INPUT x : ST_A; END_VAR F_IN := x.a1; END_FUNCTION
FUNCTION F_IO : INT VAR_IN_OUT x : ST_A; END_VAR F_IO := x.a1; END_FUNCTION
FUNCTION F_B : INT VAR_INPUT x : ST_B; END_VAR F_B := x.b1; END_FUNCTION
FUNCTION_BLOCK FB_U
VAR_INPUT x : ST_A; END_VAR
METHOD M : INT VAR_INPUT y : ST_A; END_VAR M := y.a1; END_METHOD
END_FUNCTION_BLOCK
`;
  function run(body: string): string[] {
    return messages(
      `${decls}${program(body, "a : ST_A; b : ST_B; i : INT; u : FB_U;")}`,
      ON,
    );
  }
  // The program body is on line 14.
  it("refuses derived-to-base assignment", () => {
    expect(run("a := b;")).toEqual([
      `14:6 Cannot assign ST_B to ST_A: ${relation}`,
    ]);
  });

  it("refuses base-to-derived assignment", () => {
    expect(run("b := a;")).toEqual([
      `14:6 Cannot assign ST_A to ST_B: ${relation}`,
    ]);
  });

  it("refuses a derived argument to a VAR_INPUT and a VAR_IN_OUT of the base", () => {
    expect(run("i := F_IN(x := b); i := F_IO(x := b); i := F_IN(b);")).toEqual([
      `14:16 Cannot assign ST_B to parameter 'X' of type ST_A: ${relation}`,
      `14:35 Cannot assign ST_B to parameter 'X' of type ST_A: ${relation}`,
      `14:49 Cannot assign ST_B to parameter 'X' of type ST_A: ${relation}`,
    ]);
  });

  it("refuses a base argument to a derived VAR_INPUT", () => {
    expect(run("i := F_B(x := a);")).toEqual([
      `14:15 Cannot assign ST_A to parameter 'X' of type ST_B: ${relation}`,
    ]);
  });

  it("refuses a derived argument to an FB input and a method input", () => {
    expect(run("u(x := b); i := u.M(y := b);")).toEqual([
      `14:8 Cannot assign ST_B to parameter 'X' of type ST_A: ${relation}`,
      `14:26 Cannot assign ST_B to parameter 'Y' of type ST_A: ${relation}`,
    ]);
  });

  it("refuses an unrelated STRUCT argument when either type is derived", () => {
    expect(
      messages(
        `TYPE
  ST_A : STRUCT a1 : INT; END_STRUCT;
  ST_B EXTENDS ST_A : STRUCT b1 : INT; END_STRUCT;
  ST_C : STRUCT a1 : INT; END_STRUCT;
END_TYPE
FUNCTION F_B : INT VAR_INPUT x : ST_B; END_VAR F_B := 1; END_FUNCTION
FUNCTION F_C : INT VAR_IN_OUT x : ST_C; END_VAR F_C := 1; END_FUNCTION
PROGRAM P VAR b : ST_B; c : ST_C; i : INT; END_VAR
i := F_B(c); i := F_C(x := b);
END_PROGRAM`,
        ON,
      ),
    ).toEqual([
      "9:10 Cannot assign ST_C to parameter 'X' of type ST_B",
      "9:28 Cannot assign ST_B to parameter 'X' of type ST_C",
    ]);
  });

  it("refuses an argument of an unrelated plain STRUCT", () => {
    expect(
      messages(
        `TYPE ST_A : STRUCT a1 : INT; END_STRUCT; ST_C : STRUCT a1 : INT; END_STRUCT; END_TYPE
FUNCTION F_A : INT VAR_INPUT x : ST_A; END_VAR F_A := 1; END_FUNCTION
PROGRAM P VAR c : ST_C; i : INT; END_VAR i := F_A(x := c); i := F_A(c); END_PROGRAM`,
        ON,
      ),
    ).toEqual([
      "3:56 Cannot assign ST_C to parameter 'X' of type ST_A",
      "3:69 Cannot assign ST_C to parameter 'X' of type ST_A",
    ]);
  });

  it("accepts the same type and member-wise copies", () => {
    expect(
      run(
        "a := a; b := b; i := F_IN(x := a); i := F_B(x := b); a.a1 := b.a1; a.a2 := b.a2;",
      ),
    ).toEqual([]);
  });

  it("keeps the message for unrelated structs", () => {
    expect(
      messages(
        `TYPE ST_A : STRUCT a1 : INT; END_STRUCT; ST_C : STRUCT a1 : INT; END_STRUCT; END_TYPE
PROGRAM P VAR a : ST_A; c : ST_C; END_VAR a := c; END_PROGRAM`,
        ON,
      ),
    ).toEqual(["2:48 Cannot assign ST_C to ST_A"]);
  });
});

describe("a derived STRUCT in a library build", () => {
  it("exports its flattened fields, and a consumer uses them", () => {
    const lib = compileStlib(
      [
        {
          fileName: "lib.st",
          source: `TYPE
  ST_C : STRUCT c1 : INT := 9; END_STRUCT;
  ST_A : STRUCT a1 : INT := 4; ac : ST_C; END_STRUCT;
  ST_B EXTENDS ST_A : STRUCT b1 : BOOL; END_STRUCT;
END_TYPE`,
        },
      ],
      {
        name: "libs",
        version: "1.0.0",
        namespace: "libs",
        features: ["+struct_extends"],
      },
    );
    expect(lib.success, JSON.stringify(lib.errors)).toBe(true);
    const b = lib.archive.manifest.types.find((t) => t.name === "ST_B");
    expect(b?.kind).toBe("struct");
    expect(b?.fields).toEqual([
      { name: "A1", type: "INT" },
      { name: "AC", type: "ST_C" },
      { name: "B1", type: "BOOL" },
    ]);
    const consumer = compile(
      "PROGRAM P VAR b : ST_B; i : INT; END_VAR b.a1 := 1; i := b.ac.c1; END_PROGRAM",
      { libraries: [lib.archive] },
    );
    expect(consumer.errors).toEqual([]);
    expect(consumer.headerCode).toContain("struct STRUCPP_MAY_ALIAS ST_C");
  });
});
