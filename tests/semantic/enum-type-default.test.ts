// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2025 Autonomy®
/**
 * The default of an enumeration type: a bare member (`(A, B) := B`) or one
 * qualified by the type itself (`(A, B) := E2#B`). Any other value, such as
 * another enumeration's member, an unknown member or a number, is an error.
 */
import { describe, it, expect } from "vitest";
import { compile, parse } from "../../src/index.js";

type Options = Parameters<typeof compile>[1];

const MODES: { name: string; options: Options }[] = [
  { name: "no dialect", options: {} },
  { name: "iec-3", options: { dialect: "iec-3" } },
];

const MESSAGE =
  "The default value of enumeration 'E2' must be one of its values";

/** A program declaring `E2` as `typeDecl` and E3 as (A, C). */
function program(typeDecl: string): string {
  return `TYPE E2 : ${typeDecl}; END_TYPE
TYPE E3 : (A, C); END_TYPE
PROGRAM P
VAR e : E2; END_VAR
  e := E2#A;
END_PROGRAM
`;
}

function messages(source: string, options: Options): string[] {
  return compile(source, options).errors.map(
    (e) => `${e.line}:${e.column} ${e.message}`,
  );
}

describe("enumeration type default", () => {
  it("parses a type-qualified default as Type#Member", () => {
    const unit = parse(program("(A, B) := E2#B")).ast;
    const td = unit?.types.find((t) => t.name === "E2");
    expect(td?.definition.kind).toBe("EnumDefinition");
    expect(td?.defaultValue).toMatchObject({
      kind: "VariableExpression",
      name: "E2",
      fieldAccess: ["B"],
    });
    if (td?.definition.kind === "EnumDefinition") {
      expect(td.definition.defaultValue).toBe("B");
    }
  });

  it("parses a dotted default as Type.Member", () => {
    const unit = parse(program("(A, B) := E2.B")).ast;
    const td = unit?.types.find((t) => t.name === "E2");
    expect(td?.defaultValue).toMatchObject({
      kind: "VariableExpression",
      name: "E2",
      fieldAccess: ["B"],
    });
    if (td?.definition.kind === "EnumDefinition") {
      expect(td.definition.defaultValue).toBe("B");
    }
  });

  for (const { name, options } of MODES) {
    describe(name, () => {
      it.each([
        "(A, B) := B",
        "(A, B) := b",
        "(A, B) := E2#B",
        "(A, B) := e2#b",
        "(A, B) := A",
        "INT (A := 1, B := 2) := E2#B",
        "INT (A := 1, B := 2) := B",
        "(A, B) := E2.B",
        "(A, B) := e2.b",
        "INT (A := 1, B := 2) := E2.B",
      ])("accepts %s", (decl) => {
        expect(messages(program(decl), options)).toEqual([]);
      });

      it.each([
        ["(A, B) := E3#A", 21],
        ["(A, B) := C", 21],
        ["(A, B) := E2#Z", 21],
        ["(A, B) := E3.A", 21],
        ["(A, B) := E2.Z", 21],
        ["INT (A := 1, B := 2) := E3.C", 35],
        ["INT (A := 1, B := 2) := E3#C", 35],
        ["INT (A := 1, B := 2) := 5", 35],
      ])("refuses %s", (decl, column) => {
        expect(messages(program(decl), options)).toEqual([
          `1:${column} ${MESSAGE}`,
        ]);
      });
    });
  }
});
