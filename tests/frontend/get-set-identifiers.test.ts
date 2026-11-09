/**
 * GET and SET are accessor keywords only inside a PROPERTY. Everywhere else
 * they are ordinary names: a METHOD, variable, ACTION, POU, enumeration
 * member or STRUCT field may be called Get or Set, in every dialect. The
 * PROPERTY accessor grammar itself is pinned here unchanged.
 */
import { describe, it, expect } from "vitest";
import { parse } from "../../src/frontend/parser.js";
import { buildAST } from "../../src/frontend/ast-builder.js";
import { compile } from "../../src/index.js";

function build(source: string) {
  const result = parse(source);
  expect(result.errors.map((e) => e.message)).toEqual([]);
  return buildAST(result.cst!);
}

function errorsIn(source: string, dialect?: "iec-3"): string[] {
  return compile(source, dialect ? { dialect } : {}).errors.map(
    (e) => e.message,
  );
}

describe("GET / SET as identifiers", () => {
  it("names METHODs Get and Set, called through an instance and THIS", () => {
    const src = `
      FUNCTION_BLOCK FB_A
      VAR v : INT; END_VAR
      METHOD Get : INT
        Get := v;
      END_METHOD
      METHOD Set
      VAR_INPUT x : INT; END_VAR
        v := x;
      END_METHOD
      METHOD Bump
        THIS.Set(THIS.Get() + 1);
      END_METHOD
      END_FUNCTION_BLOCK
      PROGRAM Main
      VAR f : FB_A; r : INT; END_VAR
        f.Set(5);
        r := f.Get();
      END_PROGRAM`;
    const ast = build(src);
    expect(ast.functionBlocks[0]!.methods.map((m) => m.name)).toEqual([
      "GET",
      "SET",
      "BUMP",
    ]);
    expect(errorsIn(src)).toEqual([]);
  });

  it("names variables, an ACTION, a FUNCTION and a FUNCTION_BLOCK Get / Set in every dialect", () => {
    const src = `
      FUNCTION Get : INT
      VAR_INPUT x : INT; END_VAR
        Get := x;
      END_FUNCTION
      FUNCTION_BLOCK Set
      VAR_INPUT x : INT; END_VAR
      VAR Get : INT; END_VAR
        Get := x;
      END_FUNCTION_BLOCK
      PROGRAM Main
      VAR r : INT; s : Set; set_ : BOOL; END_VAR
        r := Get(3);
        s(x := r);
        Get();
      ACTION Get:
        r := r + 1;
      END_ACTION
      END_PROGRAM`;
    for (const d of [undefined, "iec-3"] as const) {
      // Get() inside Main calls the action, which shadows nothing at top level.
      expect(errorsIn(src.replace("Get();\n", ""), d), String(d)).toEqual([]);
    }
  });

  it("names enumeration members and STRUCT fields Get / Set in every dialect", () => {
    const src = `
      TYPE E_Mode : (Get, Set, Idle); END_TYPE
      TYPE ST_A : STRUCT Get : INT; Set : BOOL; END_STRUCT END_TYPE
      PROGRAM Main
      VAR m : E_Mode := E_Mode#Set; s : ST_A; END_VAR
        m := E_Mode#Get;
        s.Get := 2;
        s.Set := TRUE;
        IF m = E_Mode#Set THEN s.Get := 3; END_IF;
      END_PROGRAM`;
    const ast = build(src);
    expect(ast.types.map((t) => t.name)).toEqual(["E_MODE", "ST_A"]);
    expect(errorsIn(src)).toEqual([]);
    expect(errorsIn(src, "iec-3")).toEqual([]);
  });

  it("accepts any letter case, e.g. a variable named get or sEt", () => {
    expect(
      errorsIn(`
        PROGRAM Main
        VAR get : INT; sEt : INT; END_VAR
          get := 1; sEt := get;
        END_PROGRAM`),
    ).toEqual([]);
  });
});

describe("PROPERTY accessors stay keywords (pinned)", () => {
  const fb = (body: string) => `
    FUNCTION_BLOCK Motor
    VAR _speed : INT; END_VAR
    ${body}
    END_FUNCTION_BLOCK`;

  it("parses GET and SET in either order, any case, empty or with statements", () => {
    const ast = build(
      fb(`
      PROPERTY Speed : INT
        set
          _speed := Speed;
        END_SET
        Get
          Speed := _speed;
        END_GET
      END_PROPERTY
      PROPERTY Empty : INT
        GET END_GET
        SET END_SET
      END_PROPERTY`),
    );
    const [speed, empty] = ast.functionBlocks[0]!.properties;
    expect(speed!.getter).toHaveLength(1);
    expect(speed!.setter).toHaveLength(1);
    expect(empty!.getter).toEqual([]);
    expect(empty!.setter).toEqual([]);
  });

  it("keeps a read-only and a write-only property apart", () => {
    const ast = build(
      fb(`
      PROPERTY RO : INT
        GET RO := _speed; END_GET
      END_PROPERTY
      PROPERTY WO : INT
        SET _speed := WO; END_SET
      END_PROPERTY`),
    );
    const [ro, wo] = ast.functionBlocks[0]!.properties;
    expect(ro!.getter).toHaveLength(1);
    expect(ro!.setter).toBeUndefined();
    expect(wo!.getter).toBeUndefined();
    expect(wo!.setter).toHaveLength(1);
  });

  it("lets a property itself be named Get or Set, and its accessor use variables named Get", () => {
    const ast = build(
      fb(`
      PROPERTY Set : INT
        GET Set := _speed; END_GET
        SET _speed := Set; END_SET
      END_PROPERTY`),
    );
    const prop = ast.functionBlocks[0]!.properties[0]!;
    expect(prop.name).toBe("SET");
    expect(prop.getter).toHaveLength(1);
    expect(prop.setter).toHaveLength(1);
  });

  it("parses interface property prototypes", () => {
    const ast = build(`
      INTERFACE I_Speed
        PROPERTY Speed : INT
          GET END_GET
          SET END_SET
        END_PROPERTY
      END_INTERFACE`);
    expect(ast.interfaces[0]!.properties?.[0]?.name).toBe("SPEED");
  });

  it("still reports a property body with something other than an accessor", () => {
    const result = parse(
      fb(`
      PROPERTY Speed : INT
        Fetch Speed := _speed; END_GET
      END_PROPERTY`),
    );
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
