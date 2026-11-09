/**
 * `TYPE U_A : UNION ... END_UNION END_TYPE` parses in every dialect; the
 * feature union is checked by the analyzer. UNION and END_UNION are not
 * keywords: they are recognised by spelling after the `:` of a TYPE only, so
 * everything that used them as names before still parses the same way.
 */
import { describe, it, expect } from "vitest";
import { parse } from "../../src/frontend/parser.js";
import { buildAST } from "../../src/frontend/ast-builder.js";
import type {
  CompilationUnit,
  StructDefinition,
} from "../../src/frontend/ast.js";

function build(source: string): CompilationUnit {
  const result = parse(source);
  expect(result.errors.map((e) => e.message)).toEqual([]);
  return buildAST(result.cst!);
}

function definition(ast: CompilationUnit, name: string): StructDefinition {
  const def = ast.types.find((t) => t.name === name)?.definition;
  if (def?.kind !== "StructDefinition") throw new Error(`no STRUCT ${name}`);
  return def;
}

describe("UNION parses", () => {
  it("is a STRUCT definition marked isUnion, with its members in order", () => {
    const ast = build(`TYPE U_A : UNION
  f : REAL;
  d : DWORD;
  arr : ARRAY[0..3] OF BYTE;
END_UNION
END_TYPE
`);
    const def = definition(ast, "U_A");
    expect(def.isUnion).toBe(true);
    expect(def.fields.flatMap((f) => f.names)).toEqual(["F", "D", "ARR"]);
    expect(def.sourceSpan).toMatchObject({ startLine: 1, startCol: 12 });
  });

  it("accepts any case, a trailing semicolon, a list of names and several TYPEs", () => {
    const ast = build(`TYPE
  U_A : union a, b : INT; End_Union;
  U_B : UNION u : U_A; END_UNION
  ST_A : STRUCT u : U_B; END_STRUCT;
END_TYPE
`);
    expect(definition(ast, "U_A").fields[0]!.names).toEqual(["A", "B"]);
    expect(definition(ast, "U_B").isUnion).toBe(true);
    expect(definition(ast, "ST_A")).not.toHaveProperty("isUnion");
  });

  it("parses an empty UNION, EXTENDS and member initial values (refused by the analyzer)", () => {
    const ast = build(`TYPE
  U_E : UNION END_UNION;
  U_X EXTENDS U_E : UNION a : INT := 1; END_UNION;
END_TYPE
`);
    expect(definition(ast, "U_E").fields).toEqual([]);
    expect(ast.types[1]!.extends?.name).toBe("U_E");
    expect(definition(ast, "U_X").fields[0]!.initialValue).toBeDefined();
  });

  it("a member named like a keyword-as-identifier is still a member", () => {
    const ast = build(
      "TYPE U_A : UNION set : INT; on : BOOL; END_UNION END_TYPE\n",
    );
    expect(definition(ast, "U_A").fields.flatMap((f) => f.names)).toEqual([
      "SET",
      "ON",
    ]);
  });

  it("is a parse error when END_UNION is missing", () => {
    expect(
      parse("TYPE U_A : UNION a : INT; END_STRUCT END_TYPE\n").errors.length,
    ).toBeGreaterThan(0);
  });
});

describe("UNION and END_UNION stay ordinary identifiers", () => {
  it("as variable, type, enum member, field and POU names", () => {
    const ast = build(`TYPE
  union : STRUCT x : INT; union : INT; END_STRUCT;
  E : (Union, End_Union);
  END_UNION : INT;
END_TYPE
FUNCTION_BLOCK Union_Fb
VAR_INPUT union : INT; END_VAR
END_FUNCTION_BLOCK
PROGRAM P
VAR union : INT; end_union : INT; s : UNION; e : E := End_Union; END_VAR
union := end_union + s.union;
END_PROGRAM
`);
    const st = definition(ast, "UNION");
    expect(st).not.toHaveProperty("isUnion");
    expect(st.fields.flatMap((f) => f.names)).toEqual(["X", "UNION"]);
    expect(ast.types[2]!.definition.kind).toBe("TypeReference");
  });

  it("an alias of a type named UNION stays an alias", () => {
    const ast = build(`TYPE
  T1 : Union;
  T2 : UNION := (x := 1);
  T3 : Union
END_TYPE
TYPE T4 : Union END_TYPE
`);
    for (const t of ast.types) {
      expect(t.definition.kind).toBe("TypeReference");
      if (t.definition.kind === "TypeReference") {
        expect(t.definition.name).toBe("UNION");
      }
    }
  });

  it("an alias of UNION without a semicolon before the next TYPE stays an alias", () => {
    const ast = build(`TYPE
  T1 : Union
  T2 : INT;
END_TYPE
`);
    expect(ast.types.map((t) => t.definition.kind)).toEqual([
      "TypeReference",
      "TypeReference",
    ]);
  });
});
