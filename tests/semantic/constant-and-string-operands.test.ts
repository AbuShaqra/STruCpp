// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Operand typing and constant checks:
 * - a STRING reached through `^` takes no `+` and is compared only with a
 *   string, as a STRING variable is (`ps^ + 'x'` is refused);
 * - an untyped integer constant beside a typed integer takes its type when
 *   it fits (`si + 3` is a SINT), so no narrowing warning follows;
 * - an untyped constant that does not fit its integer target (`s := 200`
 *   into a SINT) warns in every mode, one diagnostic in place of a narrowing
 *   warning: assignments, initial values, array and STRUCT initializers,
 *   STRUCT field defaults and call arguments. A based literal whose bit
 *   pattern fits the target width (`16#FFFF` into an INT) does not.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

type Options = Parameters<typeof compile>[1];

const MODES: Array<[string, Options]> = [
  ["default", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];

function diagnostics(source: string, options: Options = {}) {
  const r = compile(source, options);
  return {
    errors: r.errors.map((e) => `${e.line}: ${e.message}`),
    warnings: r.warnings.map((e) => `${e.line}: ${e.message}`),
  };
}

describe("a dereferenced STRING operand", () => {
  const source = (line: string) => `PROGRAM Main
VAR s : STRING := 'ab'; ps : POINTER TO STRING; ps2 : POINTER TO STRING;
  r : STRING; b : BOOL; w : WSTRING; pw : POINTER TO WSTRING; END_VAR
ps := ADR(s); ps2 := ADR(s); pw := ADR(w);
${line}
END_PROGRAM
`;
  // iec-3 has no POINTER TO
  for (const [label, options] of [MODES[0]!, MODES[2]!]) {
    it(`is refused in arithmetic as a variable is (${label})`, () => {
      for (const line of [
        "r := ps^ + 'x';",
        "r := 'x' + ps^;",
        "r := ps^ + ps2^;",
      ]) {
        expect(diagnostics(source(line), options).errors).toEqual([
          "5: Operator '+' does not apply to STRING; join strings with CONCAT",
        ]);
      }
      expect(diagnostics(source("b := ps^ = 1;"), options).errors).toEqual([
        "5: Cannot compare STRING with INT",
      ]);
    });

    it(`compares with a string and concatenates with CONCAT (${label})`, () => {
      for (const line of [
        "b := ps^ = 'ab';",
        "b := ps^ = s;",
        "b := ps^ = ps2^;",
        "b := ps^ < 'b';",
        "r := CONCAT(ps^, 'x');",
        'b := pw^ = "a";',
      ]) {
        expect(diagnostics(source(line), options).errors).toEqual([]);
      }
    });
  }
});

describe("an untyped constant beside a typed integer", () => {
  const source = `FUNCTION FS : SINT
VAR_INPUT a : SINT; END_VAR
FS := a;
END_FUNCTION
PROGRAM Main
VAR si : SINT := 100; s2 : SINT; us : USINT; u2 : USINT; i : INT; END_VAR
s2 := FS(si + 3);
s2 := MAX(si + 3, s2);
s2 := LIMIT(0, si + 3, 10);
s2 := ABS(si + 3);
s2 := SHL(si + 3, 1);
u2 := MAX(us - 3, u2);
i := si + 3;
END_PROGRAM
`;
  for (const [label, options] of MODES) {
    it(`takes the operand's type (${label})`, () => {
      expect(diagnostics(source, options)).toEqual({
        errors: [],
        warnings: [],
      });
      const r = compile(source, options);
      const body = r.ast!.programs[0]!.body;
      const assigned = body[6]!;
      expect(assigned.kind).toBe("AssignmentStatement");
      if (assigned.kind === "AssignmentStatement") {
        expect(assigned.value.resolvedType).toMatchObject({ name: "SINT" });
      }
    });
  }

  it("keeps the wider type when the constant does not fit", () => {
    const r = compile(
      `PROGRAM Main
VAR si : SINT; i : INT; END_VAR
i := si + 300;
END_PROGRAM
`,
    );
    const assigned = r.ast!.programs[0]!.body[0]!;
    if (assigned.kind === "AssignmentStatement") {
      expect(assigned.value.resolvedType).toMatchObject({ name: "INT" });
    }
  });
});

describe("an untyped constant that does not fit its target", () => {
  const source = `FUNCTION FS : SINT
VAR_INPUT a : SINT; END_VAR
FS := a;
END_FUNCTION
TYPE ST : STRUCT f : SINT := 300; g : ARRAY[1..2] OF SINT := [300, 1]; END_STRUCT END_TYPE
PROGRAM Main
VAR s : SINT; s2 : SINT := 200; u : UINT := 70000; r : SINT; ok : SINT := 127; END_VAR
VAR ar : ARRAY[1..2] OF SINT := [128, 0]; ui : UINT := -1; END_VAR
s := 200;
s := 100 + 100;
r := FS(200);
s := -128;
s := 16#7F;
END_PROGRAM
`;
  const wraps = [
    "5: The constant expression is 300, outside SINT (-128..127): it wraps",
    "5: The constant expression is 300, outside SINT (-128..127): it wraps",
    "7: The constant expression is 200, outside SINT (-128..127): it wraps",
    "7: The constant expression is 70000, outside UINT (0..65535): it wraps",
    "8: The constant expression is 128, outside SINT (-128..127): it wraps",
    "8: The constant expression is -1, outside UINT (0..65535): it wraps",
    "9: The constant expression is 200, outside SINT (-128..127): it wraps",
    "10: The constant expression is 200, outside SINT (-128..127): it wraps",
    "11: The constant expression is 200, outside SINT (-128..127): it wraps",
  ];
  const sorted = (l: string[]) => [...l].sort();

  for (const [label, options] of MODES) {
    it(`warns, with one diagnostic each (${label})`, () => {
      const d = diagnostics(source, options);
      expect(d.errors).toEqual([]);
      // --strict also keeps its narrowing warning beside the wrap
      const strictNarrowing =
        label === "strict"
          ? [
              "8: Implicit narrowing conversion from INT to UINT",
              "10: Implicit narrowing conversion from INT to SINT",
            ]
          : [];
      expect(sorted(d.warnings)).toEqual(
        sorted([...wraps, ...strictNarrowing]),
      );
    });
  }

  it("leaves a based literal whose bit pattern fits the target as before", () => {
    const d = diagnostics(`PROGRAM Main
VAR i : INT := 16#FFFF; d : DINT := 16#FFFFFFFF; s : SINT := 2#1000_0000; END_VAR
i := 16#8000;
END_PROGRAM
`);
    expect(d).toEqual({ errors: [], warnings: [] });
  });
});
