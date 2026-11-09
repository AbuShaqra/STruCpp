/**
 * Method calls through a member chain: `a.b.M()`, `THIS.f.M()`, `s.fb.M()`,
 * `arr[i].M()`. Standard IEC (repeated instance-name prefixes before
 * the method name), so accepted in every dialect. The method resolves on the
 * chain's final type, base types included.
 */
import { describe, it, expect } from "vitest";
import { parse } from "../../src/frontend/parser.js";
import { buildAST } from "../../src/frontend/ast-builder.js";
import { compile } from "../../src/index.js";
import type {
  Expression,
  MethodCallExpression,
  Statement,
} from "../../src/frontend/ast.js";

type Options = Parameters<typeof compile>[1];

const MODES: { name: string; options: Options }[] = [
  { name: "no dialect", options: {} },
  { name: "iec-3", options: { dialect: "iec-3" } },
];

const TYPES = `FUNCTION_BLOCK FB_Leaf
VAR n : INT; END_VAR
METHOD Add : INT
VAR_INPUT k : INT; END_VAR
VAR_OUTPUT doubled : INT; END_VAR
  n := n + k;
  doubled := n * 2;
  Add := n;
END_METHOD
METHOD Reset
  n := 0;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_LeafX EXTENDS FB_Leaf
END_FUNCTION_BLOCK
TYPE ST_Holder : STRUCT fb : FB_Leaf; arr : ARRAY[1..2] OF FB_Leaf; v : INT; END_STRUCT; END_TYPE
FUNCTION_BLOCK FB_Mid
VAR leaf : FB_Leaf; derived : FB_LeafX; h : ST_Holder; leaves : ARRAY[1..3] OF FB_Leaf; v : INT; END_VAR
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Top
VAR mid : FB_Mid; END_VAR
END_FUNCTION_BLOCK
`;

/** Line of the first body statement in {@link program}. */
const BODY_LINE = TYPES.split("\n").length + 2;

function program(body: string): string {
  return `${TYPES}PROGRAM MAIN
VAR top : FB_Top; mid : FB_Mid; h : ST_Holder; arr : ARRAY[1..2] OF FB_Mid; x : INT; d : INT; i : INT := 1; END_VAR
${body}
END_PROGRAM
`;
}

function messages(source: string, options: Options = {}): string[] {
  return compile(source, options).errors.map(
    (e) => `${e.line}:${e.column} ${e.message}`,
  );
}

function bodyOf(source: string): Statement[] {
  const parsed = parse(source);
  expect(parsed.errors).toHaveLength(0);
  const ast = buildAST(parsed.cst!);
  return ast.programs[0]?.body ?? ast.functionBlocks.at(-1)!.body;
}

/** `object` of the method call in `x := <call>;` or `<call>;`. */
function callOf(stmt: Statement): MethodCallExpression {
  const expr: Expression =
    stmt.kind === "AssignmentStatement"
      ? stmt.value
      : stmt.kind === "FunctionCallStatement"
        ? stmt.call
        : (undefined as never);
  expect(expr.kind).toBe("MethodCallExpression");
  return expr as MethodCallExpression;
}

describe("member-chain method calls parse into a method call on the chain", () => {
  it("a.b.M(1) as an expression", () => {
    const call = callOf(bodyOf(program("x := top.mid.leaf.Add(1);"))[0]!);
    expect(call.methodName).toBe("ADD");
    expect(call.object).toMatchObject({
      kind: "VariableExpression",
      name: "TOP",
      fieldAccess: ["MID", "LEAF"],
    });
    expect(call.arguments).toHaveLength(1);
  });

  it("a.b.M() as a statement", () => {
    const call = callOf(bodyOf(program("mid.leaf.Reset();"))[0]!);
    expect(call.methodName).toBe("RESET");
    expect(call.object).toMatchObject({ name: "MID", fieldAccess: ["LEAF"] });
  });

  it("arr[i].M() keeps the subscript on the object", () => {
    const call = callOf(bodyOf(program("x := arr[i].leaf.Add(k := 2);"))[0]!);
    expect(call.object).toMatchObject({ name: "ARR", fieldAccess: ["LEAF"] });
    expect(
      (call.object as { accessChain?: { kind: string }[] }).accessChain?.map(
        (s) => s.kind,
      ),
    ).toEqual(["subscript", "field"]);
    expect(call.arguments[0]).toMatchObject({ name: "K", isOutput: false });
  });

  it("THIS.f.M() is a method call on THIS.f", () => {
    const src = `${TYPES}FUNCTION_BLOCK FB_User
VAR mid : FB_Mid; x : INT; END_VAR
  x := THIS.mid.leaf.Add(1);
END_FUNCTION_BLOCK
`;
    const call = callOf(bodyOf(src)[0]!);
    expect(call.object).toMatchObject({
      name: "THIS",
      fieldAccess: ["MID", "LEAF"],
    });
  });

  it("a fluent chain continues after the member-chain call", () => {
    const call = callOf(bodyOf(program("x := mid.leaf.Add(1).Foo();"))[0]!);
    expect(call.methodName).toBe("FOO");
    expect(call.object.kind).toBe("MethodCallExpression");
  });

  it("single-dot inst.M() keeps its dotted FunctionCallExpression form", () => {
    const stmts = bodyOf(program("x := mid.Foo(1);\nmid.Foo();"));
    expect(stmts[0]).toMatchObject({
      value: { kind: "FunctionCallExpression", functionName: "MID.FOO" },
    });
    expect(stmts[1]).toMatchObject({
      call: { kind: "FunctionCallExpression", functionName: "MID.FOO" },
    });
  });
});

describe("member-chain method calls are accepted in every dialect", () => {
  const forms: { name: string; body: string }[] = [
    { name: "a.b.M() expression", body: "x := mid.leaf.Add(1);" },
    { name: "a.b.c.M() expression", body: "x := top.mid.leaf.Add(1);" },
    { name: "a.b.M() statement", body: "top.mid.leaf.Reset();" },
    { name: "named argument", body: "x := mid.leaf.Add(k := 2);" },
    {
      name: "output argument",
      body: "x := mid.leaf.Add(k := 2, doubled => d);",
    },
    { name: "inherited method", body: "x := mid.derived.Add(1);" },
    { name: "struct-held FB", body: "x := h.fb.Add(1);" },
    { name: "FB in a struct in an FB", body: "x := mid.h.fb.Add(1);" },
    { name: "array element", body: "x := mid.leaves[i].Add(1);" },
    { name: "array of FB holders", body: "x := arr[2].leaf.Add(1);" },
    { name: "array in a struct", body: "x := mid.h.arr[i].Add(1);" },
    { name: "statement through an array", body: "h.arr[1].Reset();" },
    {
      name: "in a larger expression",
      body: "x := mid.leaf.Add(1) + h.fb.Add(2) * 2;",
    },
  ];
  for (const mode of MODES) {
    for (const form of forms) {
      it(`${form.name} (${mode.name})`, () => {
        expect(messages(program(form.body), mode.options)).toEqual([]);
      });
    }
  }

  for (const mode of MODES) {
    it(`THIS.f.M() and SUPER.f.M() (${mode.name})`, () => {
      const src = `${TYPES}FUNCTION_BLOCK FB_Base
VAR mid : FB_Mid; END_VAR
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_User EXTENDS FB_Base
VAR x : INT; END_VAR
METHOD Run : INT
  x := THIS.mid.leaf.Add(1);
  THIS.mid.h.fb.Reset();
  Run := SUPER.mid.leaf.Add(k := 2);
END_METHOD
END_FUNCTION_BLOCK
`;
      expect(messages(src, mode.options)).toEqual([]);
    });
  }

  it("a plainly declared global FB, called through its members", () => {
    const src = `${TYPES}VAR_GLOBAL g : FB_Mid; END_VAR
PROGRAM MAIN
VAR_EXTERNAL g : FB_Mid; END_VAR
VAR x : INT; END_VAR
  x := g.leaf.Add(1);
  g.h.fb.Reset();
END_PROGRAM
`;
    expect(messages(src, { dialect: "iec-3" })).toEqual([]);
  });

  it("THIS^.f.M() needs self_caret like THIS^.member", () => {
    const src = `${TYPES}FUNCTION_BLOCK FB_User
VAR mid : FB_Mid; x : INT; END_VAR
  x := THIS^.mid.leaf.Add(1);
END_FUNCTION_BLOCK
`;
    expect(messages(src, { dialect: "iec-3" }).join("\n")).toMatch(
      /self_caret/,
    );
    expect(
      messages(src, { dialect: "iec-3", features: ["+self_caret"] }),
    ).toEqual([]);
  });
});

describe("member-chain method calls report errors at the right place", () => {
  for (const mode of MODES) {
    it(`unknown method on the chain's FB (${mode.name})`, () => {
      expect(messages(program("x := mid.leaf.Nope(1);"), mode.options)).toEqual(
        [`${BODY_LINE}:15 Function block 'FB_LEAF' has no method 'NOPE'`],
      );
    });

    it(`calling a method on a non-FB member (${mode.name})`, () => {
      expect(messages(program("x := mid.v.Add(1);"), mode.options)).toEqual([
        `${BODY_LINE}:6 Cannot call method 'ADD' on 'MID.V': it is not a function block instance`,
      ]);
    });

    it(`calling a method on a struct (${mode.name})`, () => {
      expect(messages(program("  mid.h.Add(1);"), mode.options)).toEqual([
        `${BODY_LINE}:3 Cannot call method 'ADD' on 'MID.H': it is not a function block instance`,
      ]);
    });

    it(`unknown named argument (${mode.name})`, () => {
      expect(
        messages(program("x := mid.leaf.Add(k := 1, q := 2);"), mode.options),
      ).toEqual([
        `${BODY_LINE}:27 Method 'ADD' of 'FB_LEAF' has no parameter named 'Q'`,
      ]);
    });

    it(`too many positional arguments (${mode.name})`, () => {
      expect(
        messages(program("x := mid.leaf.Add(1, d, 3);"), mode.options),
      ).toEqual([
        `${BODY_LINE}:25 Method 'ADD' of 'FB_LEAF' takes 2 arguments, got 3`,
      ]);
    });

    it(`an inherited method is found; a missing one is not (${mode.name})`, () => {
      expect(
        messages(program("x := mid.derived.Nope();"), mode.options),
      ).toEqual([
        `${BODY_LINE}:18 Function block 'FB_LEAFX' has no method 'NOPE'`,
      ]);
    });

    it(`PRIVATE and PROTECTED methods on another instance are refused (${mode.name})`, () => {
      const src = `FUNCTION_BLOCK FB_Secret
METHOD PRIVATE Hidden : INT
  Hidden := 1;
END_METHOD
METHOD PROTECTED Guarded : INT
  Guarded := 2;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Box
VAR s : FB_Secret; END_VAR
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Kid EXTENDS FB_Secret
VAR box : FB_Box; x : INT; END_VAR
  x := box.s.Guarded();
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR box : FB_Box; x : INT; END_VAR
  x := box.s.Hidden();
  x := box.s.Guarded();
END_PROGRAM
`;
      expect(messages(src, mode.options).sort()).toEqual([
        "14:8 Cannot call PROTECTED method 'GUARDED' of 'FB_SECRET' from 'FB_KID'.",
        "18:8 Cannot call PRIVATE method 'HIDDEN' of 'FB_SECRET' from outside 'FB_SECRET'.",
        "19:8 Cannot call PROTECTED method 'GUARDED' of 'FB_SECRET' from 'PROGRAM'.",
      ]);
    });

    it(`invoking an FB member through a chain is refused clearly (${mode.name})`, () => {
      expect(messages(program("  mid.h.fb();"), mode.options)).toEqual([
        `${BODY_LINE}:9 'MID.H.FB' is a member, not a method; invoking a function block through a member chain is not supported`,
      ]);
    });

    it(`unknown member in the chain stays unflagged by the call check (${mode.name})`, () => {
      // The undeclared-member path owns this; the call adds no second error.
      const errs = messages(program("x := mid.nothing.Add(1);"), mode.options);
      expect(errs.filter((e) => e.includes("method"))).toEqual([]);
    });
  }
});

describe("member-chain call errors carry the file name", () => {
  it("names the source file on an unknown-method error", () => {
    const errs = compile(program("x := mid.leaf.Nope();"), {
      fileName: "chain.st",
    }).errors.filter((e) => e.message.includes("has no method"));
    expect(errs).toHaveLength(1);
    expect(errs[0]?.file).toBe("chain.st");
  });
});
