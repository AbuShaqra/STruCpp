/**
 * The feature platform_types: __XINT/XINT, __UXINT/UXINT, XWORD and PVOID
 * stand for their 64-bit types; a declaration of the same name wins.
 */
import { describe, it, expect } from "vitest";
import { compile, type CompileOptions } from "../../src/index.js";
import {
  DEFAULT_FEATURES,
  KNOWN_FEATURES,
  resolveDialect,
  type DialectProfile,
} from "../../src/dialect.js";
import { platformTypeTarget } from "../../src/semantic/platform-types.js";

const PROFILE: DialectProfile = {
  id: "twincat3",
  name: "twincat3",
  extends: "iec-3",
  features: ["pointer_to", "platform_types"],
  semantics: {},
};

function diag(
  source: string,
  opts: Partial<CompileOptions> = {},
): { errors: string[]; warnings: string[]; cpp: string; hpp: string } {
  const r = compile(source, { headerFileName: "generated.hpp", ...opts });
  return {
    errors: r.errors.map((e) => `${e.line}:${e.column}: ${e.message}`).sort(),
    warnings: r.warnings.map((e) => `${e.line}:${e.column}: ${e.message}`),
    cpp: r.cppCode,
    hpp: r.headerCode,
  };
}

const SOURCE = `TYPE ST_X : STRUCT a : XINT; b : ARRAY[0..1] OF __UXINT; END_STRUCT; END_TYPE
TYPE T_Al : UXINT; END_TYPE
FUNCTION F : XWORD
VAR_INPUT p : PVOID; END_VAR
F := p;
END_FUNCTION
PROGRAM MAIN
VAR
  x : INT;
  xi : __XINT := -5;
  ux : UXINT;
  xw : XWORD;
  pv : PVOID;
  pp : POINTER TO XINT;
  s : ST_X;
END_VAR
pv := ADR(x);
xw := F(pv);
s.a := xi;
pp := ADR(s.a);
END_PROGRAM
`;

const LOWERED = SOURCE.replace(/__XINT|\bXINT\b/g, "LINT")
  .replace(/__UXINT|\bUXINT\b/g, "ULINT")
  .replace(/\bXWORD\b|\bPVOID\b/g, "__XWORD");

describe("platform_types — the feature", () => {
  it("is known but in neither the default set nor iec-3", () => {
    expect(KNOWN_FEATURES).toContain("platform_types");
    expect(DEFAULT_FEATURES.has("platform_types")).toBe(false);
    expect(resolveDialect({ dialect: "iec-3" }).features).not.toContain(
      "platform_types",
    );
  });

  it("maps each name, in any case, to its 64-bit type", () => {
    expect(
      ["__xint", "XINT", "__UXINT", "uxint", "XWORD", "PVOID"].map(
        platformTypeTarget,
      ),
    ).toEqual(["LINT", "LINT", "ULINT", "ULINT", "__XWORD", "__XWORD"]);
    expect(platformTypeTarget("XLINT")).toBeUndefined();
  });
});

describe("platform_types — compile", () => {
  it("compiles as the 64-bit types, everywhere a type is written", () => {
    const ref = diag(LOWERED);
    expect(ref.errors).toEqual([]);
    for (const opts of [
      { features: ["+platform_types"] },
      { features: ["+platform_types"], strict: true },
      { dialect: PROFILE },
    ] as Partial<CompileOptions>[]) {
      const r = diag(SOURCE, opts);
      expect(r.errors).toEqual([]);
      expect(r.cpp).toBe(ref.cpp);
      expect(r.hpp).toBe(ref.hpp);
    }
  });

  it("is refused at each use when off", () => {
    const expected = [
      "10:8: __XINT needs the feature platform_types",
      "11:8: UXINT needs the feature platform_types",
      "12:8: XWORD needs the feature platform_types",
      "13:8: PVOID needs the feature platform_types",
      "14:8: XINT needs the feature platform_types",
      "1:24: XINT needs the feature platform_types",
      "1:34: __UXINT needs the feature platform_types",
      "2:13: UXINT needs the feature platform_types",
      "3:14: XWORD needs the feature platform_types",
      "4:15: PVOID needs the feature platform_types",
    ].sort();
    expect(diag(SOURCE).errors).toEqual(expected);
    expect(diag(SOURCE, { strict: true }).errors).toEqual(expected);
    expect(
      diag(SOURCE, { dialect: "iec-3", features: ["+pointer_to"] }).errors,
    ).toEqual(expected);
  });

  it("keeps XINT a LINT: narrowing to DINT warns, under --strict errs", () => {
    const src = `PROGRAM MAIN
VAR xi : XINT; d : DINT; END_VAR
d := xi;
END_PROGRAM
`;
    expect(diag(src, { features: ["+platform_types"] }).warnings).toEqual([
      "3:6: Implicit narrowing conversion from LINT to DINT",
    ]);
    expect(
      diag(src, { features: ["+platform_types"], strict: true }).errors,
    ).toEqual([
      "3:6: Implicit conversion from LINT to DINT is not allowed; use LINT_TO_DINT",
    ]);
  });

  it("lets a TYPE or POU of the same name win", () => {
    const src = `TYPE XINT : STRUCT a : INT; END_STRUCT; END_TYPE
FUNCTION_BLOCK PVOID
VAR_OUTPUT q : INT; END_VAR
q := 3;
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR x : XINT; p : PVOID; uxint : INT; END_VAR
x.a := 1;
p();
uxint := p.q;
END_PROGRAM
`;
    const off = diag(src, { dialect: "iec-3" });
    const on = diag(src, { dialect: PROFILE });
    expect(off.errors).toEqual([]);
    expect(on.errors).toEqual([]);
    expect(on.cpp).toBe(off.cpp);
    expect(diag(src).cpp).toBe(off.cpp);
  });
});
