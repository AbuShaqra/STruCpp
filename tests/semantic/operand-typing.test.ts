// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * The type checker types every operand it can declare a type for: a member
 * reached through THIS^ or SUPER^ or inherited by its bare name, a PROPERTY,
 * a dotted METHOD call. An untyped integer constant beside a bit string takes
 * the bit string's type, an address offset by + or - is an __XWORD, and a
 * signed/unsigned AND/OR/XOR in an initial value is computed widened.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import type {
  AssignmentStatement,
  BinaryExpression,
  CompilationUnit,
  Expression,
  IECType,
  Statement,
} from "../../src/frontend/ast.js";

const OPTIONS = {
  headerFileName: "generated.hpp",
  features: ["+property", "+self_caret"],
};

function typeName(t: IECType | undefined): string {
  if (t === undefined) return "undefined";
  return "name" in t ? String(t.name).toUpperCase() : t.typeKind;
}

/** The resolved type of each assignment value in `body`. */
function valueTypes(body: Statement[]): string[] {
  return body.map((s) =>
    typeName((s as AssignmentStatement).value.resolvedType),
  );
}

function fbBody(ast: CompilationUnit | undefined, name: string): Statement[] {
  const fb = ast?.functionBlocks.find((f) => f.name.toUpperCase() === name);
  if (fb === undefined) throw new Error(`no FB ${name}`);
  return fb.body;
}

const MEMBERS = `FUNCTION_BLOCK Base
VAR x : SINT; w : WORD; END_VAR
METHOD M : UINT
M := 1;
END_METHOD
PROPERTY P : USINT
GET
P := 1;
END_GET
END_PROPERTY
END_FUNCTION_BLOCK
FUNCTION_BLOCK Derived EXTENDS Base
VAR fb : Base; r : LINT; END_VAR
r := THIS^.x;
r := SUPER^.x;
r := THIS.w;
r := x;
r := P;
r := THIS^.P;
r := fb.P;
r := fb.M();
r := THIS^.M();
r := SUPER^.M();
END_FUNCTION_BLOCK
`;

describe("operand typing", () => {
  it("types THIS^/SUPER^ members, inherited members, properties and method results", () => {
    const r = compile(MEMBERS, OPTIONS);
    expect(r.errors).toEqual([]);
    expect(valueTypes(fbBody(r.ast, "DERIVED"))).toEqual([
      "SINT",
      "SINT",
      "WORD",
      "SINT",
      "USINT",
      "USINT",
      "USINT",
      "UINT",
      "UINT",
      "UINT",
    ]);
  });

  it("gives an untyped integer constant beside a bit string the bit string's type", () => {
    const r = compile(
      `PROGRAM Main
VAR dw : DWORD := 4000000000; w : WORD; b : BYTE; u : UDINT; l : LWORD; si : SINT; END_VAR
l := dw / 86400 + 3;
l := 3 + w;
l := b * 2;
l := 2 MOD b;
l := dw - DINT#1;
l := si + 3;
u := MAX(dw / 2 + 3, 5);
END_PROGRAM
`,
      OPTIONS,
    );
    expect(r.errors).toEqual([]);
    const body = r.ast!.programs[0]!.body;
    expect(valueTypes(body.slice(0, 6))).toEqual([
      "DWORD",
      "WORD",
      "BYTE",
      "BYTE",
      "DINT",
      // the constant takes the signed operand's type too
      "SINT",
    ]);
  });

  it("types an address offset by + or - as an __XWORD", () => {
    const r = compile(
      `PROGRAM Main
VAR v : INT; pp, pq : POINTER TO INT; pb : POINTER TO BYTE; x : LWORD; END_VAR
x := pp + 2;
x := 2 + pp;
x := pp - 2 + 1;
x := ADR(v) + 2;
pb := pb + 1;
END_PROGRAM
`,
      OPTIONS,
    );
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((w) => w.message)).toEqual([]);
    expect(valueTypes(r.ast!.programs[0]!.body)).toEqual([
      "__XWORD",
      "__XWORD",
      "__XWORD",
      "__XWORD",
      "__XWORD",
    ]);
  });

  for (const [label, options] of [
    ["no dialect", {}],
    ["strict", { strict: true }],
    ["iec-3 with pointer_to", { dialect: "iec-3", features: ["+pointer_to"] }],
  ] as const) {
    it(`types no difference of two addresses, nor arithmetic on one, as an __XWORD (${label})`, () => {
      const r = compile(
        `PROGRAM Main
VAR arr : ARRAY[0..9] OF INT; p, q : POINTER TO INT; n : INT := 2;
  y : INT; d : DINT; END_VAR
y := (p - q) / 2;
d := (p - q) / 2;
d := (p - q) + 1;
d := (p - q) * 2;
d := (p - q) MOD 5;
d := (p - q) - 1;
d := (ADR(arr[6]) - ADR(arr[0])) / 2;
d := (p - q) / n;
d := (p - q) / INT#2;
END_PROGRAM
`,
        { ...OPTIONS, ...options },
      );
      expect(r.errors).toEqual([]);
      expect(valueTypes(r.ast!.programs[0]!.body)).not.toContain("__XWORD");
    });
  }

  it("refuses a difference of two addresses under iec-3 for the feature only", () => {
    const r = compile(
      `PROGRAM Main
VAR arr : ARRAY[0..9] OF INT; d : DINT; END_VAR
d := (ADR(arr[6]) - ADR(arr[0])) / 2;
d := (ADR(arr[6]) - ADR(arr[0])) + 1;
END_PROGRAM
`,
      { headerFileName: "generated.hpp", dialect: "iec-3" },
    );
    expect([...new Set(r.errors.map((e) => e.message))]).toEqual([
      "ADR needs the feature pointer_to",
    ]);
  });

  it("refuses under --strict an address offset stored in no address-wide integer only, as ADR() alone", () => {
    const r = compile(
      `PROGRAM Main
VAR v : INT; xw : LWORD; q : POINTER TO BYTE; END_VAR
xw := ADR(v) + 4;
q := ADR(v) + 1;
END_PROGRAM
`,
      { ...OPTIONS, strict: true },
    );
    expect(r.errors).toEqual([]);
  });

  it("marks a signed/unsigned AND/OR/XOR in every initial value to compute widened", () => {
    const r = compile(
      `TYPE St : STRUCT f : LINT; g : LINT := DINT#-7 OR UDINT#4000000000; END_STRUCT; END_TYPE
VAR_GLOBAL g1 : LINT := DINT#-7 OR UDINT#4000000000; gs : St := (f := SINT#-1 XOR USINT#1); END_VAR
PROGRAM Main
VAR s : St := (f := DINT#-7 OR UDINT#4000000000); END_VAR
END_PROGRAM
CONFIGURATION C
VAR_GLOBAL cg : LINT := (DINT#-7 OR UDINT#1) AND UDINT#4000000000; END_VAR
RESOURCE R ON PLC
TASK t(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM inst WITH t : Main;
END_RESOURCE
END_CONFIGURATION
`,
      OPTIONS,
    );
    expect(r.errors).toEqual([]);
    const marks: string[] = [];
    const visit = (e: Expression | undefined): void => {
      if (e === undefined) return;
      if (e.kind === "BinaryExpression") {
        const b = e as BinaryExpression;
        marks.push(`${b.operator}:${b.computeAs ?? "-"}`);
        visit(b.left);
        visit(b.right);
      } else if (e.kind === "ParenthesizedExpression") {
        visit(e.expression);
      } else if (e.kind === "StructInitializerExpression") {
        for (const f of e.elements) visit(f.value);
      }
    };
    const ast = r.ast!;
    for (const t of ast.types) {
      if (t.definition.kind !== "StructDefinition") continue;
      for (const f of t.definition.fields) visit(f.initialValue);
    }
    const blocks = [
      ...ast.globalVarBlocks,
      ...ast.programs.flatMap((p) => p.varBlocks),
      ...ast.configurations.flatMap((c) => c.varBlocks),
    ];
    for (const b of blocks)
      for (const d of b.declarations) visit(d.initialValue);
    expect(marks).toEqual([
      "OR:LINT",
      "OR:LINT",
      "XOR:INT",
      "OR:LINT",
      "AND:LINT",
      "OR:LINT",
    ]);
  });
});
