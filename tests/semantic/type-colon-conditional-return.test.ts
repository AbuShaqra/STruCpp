/**
 * The features type_colon_optional (`TYPE X STRUCT ... END_STRUCT` without
 * the colon) and conditional_return (`RETURN (cond);`).
 */
import { describe, it, expect } from "vitest";
import { compile, parse, type CompileOptions } from "../../src/index.js";
import {
  DEFAULT_FEATURES,
  KNOWN_FEATURES,
  resolveDialect,
  type DialectProfile,
} from "../../src/dialect.js";

const TWINCAT3: DialectProfile = {
  id: "twincat3",
  name: "twincat3",
  extends: "iec-3",
  features: ["pointer_to", "reference_to", "type_colon_optional"],
  semantics: {},
};
const CODESYS3: DialectProfile = {
  ...TWINCAT3,
  id: "codesys3",
  features: [...TWINCAT3.features, "conditional_return"],
};

function diag(
  source: string,
  opts: Partial<CompileOptions> = {},
): { errors: string[]; cpp: string } {
  const r = compile(source, { headerFileName: "generated.hpp", ...opts });
  return {
    errors: r.errors.map((e) => `${e.line}:${e.column}: ${e.message}`).sort(),
    cpp: r.cppCode,
  };
}

const COLONLESS = `TYPE
  ST_A STRUCT a : INT; END_STRUCT
  ST_B STRUCT b : ST_A; END_STRUCT;
END_TYPE
PROGRAM MAIN
VAR s : ST_B; END_VAR
s.b.a := 1;
END_PROGRAM
`;
const WITH_COLON = COLONLESS.replace("ST_A STRUCT", "ST_A : STRUCT").replace(
  "ST_B STRUCT",
  "ST_B : STRUCT",
);

const CONDITIONAL = `FUNCTION F : INT
VAR_INPUT x : INT; END_VAR
F := 1;
RETURN (x > 5);
F := 2;
END_FUNCTION
PROGRAM MAIN
VAR n : INT; END_VAR
n := F(7);
END_PROGRAM
`;
const AS_IF = CONDITIONAL.replace(
  "RETURN (x > 5);",
  "IF (x > 5) THEN RETURN; END_IF;",
);

describe("the features", () => {
  it("are known but in neither the default set nor iec-3", () => {
    for (const f of ["type_colon_optional", "conditional_return"] as const) {
      expect(KNOWN_FEATURES).toContain(f);
      expect(DEFAULT_FEATURES.has(f)).toBe(false);
      expect(resolveDialect({ dialect: "iec-3" }).features).not.toContain(f);
    }
  });
});

describe("type_colon_optional", () => {
  it("parses into the same TYPE as the colon form", () => {
    const a = parse(COLONLESS);
    const b = parse(WITH_COLON);
    expect(a.errors).toEqual([]);
    const shape = (u: typeof a): string =>
      JSON.stringify(
        u.ast!.types.map((t) => t.definition),
        (k, v: unknown) =>
          k === "sourceSpan" || k === "nameSpans" ? undefined : v,
      );
    expect(shape(a)).toBe(shape(b));
    expect(a.ast!.types[0]!.colonOmittedSpan?.startCol).toBe(8);
    expect(b.ast!.types[0]!.colonOmittedSpan).toBeUndefined();
  });

  it("generates the C++ of the colon form when on", () => {
    const ref = diag(WITH_COLON);
    for (const opts of [
      { features: ["+type_colon_optional"] },
      { features: ["+type_colon_optional"], strict: true },
      { dialect: TWINCAT3 },
      { dialect: CODESYS3 },
    ] as Partial<CompileOptions>[]) {
      const r = diag(COLONLESS, opts);
      expect(r.errors).toEqual([]);
      expect(r.cpp).toBe(ref.cpp);
    }
  });

  it("is refused at STRUCT when off", () => {
    for (const opts of [
      {},
      { strict: true },
      { dialect: "iec-3" },
    ] as Partial<CompileOptions>[]) {
      expect(diag(COLONLESS, opts).errors).toEqual([
        "2:8: TYPE ST_A without ':' before STRUCT needs the feature type_colon_optional",
        "3:8: TYPE ST_B without ':' before STRUCT needs the feature type_colon_optional",
      ]);
    }
  });

  it("leaves other type forms needing the colon", () => {
    const r = diag(
      `TYPE X INT; END_TYPE
PROGRAM MAIN
END_PROGRAM
`,
      { dialect: TWINCAT3 },
    );
    expect(r.errors[0]).toBe("1:8: Expected `Colon`, found identifier `INT`.");
  });
});

describe("conditional_return", () => {
  it("is IF cond THEN RETURN; END_IF when on", () => {
    const ref = diag(AS_IF);
    for (const opts of [
      { features: ["+conditional_return"] },
      { features: ["+conditional_return"], strict: true },
      { dialect: CODESYS3 },
    ] as Partial<CompileOptions>[]) {
      const r = diag(CONDITIONAL, opts);
      expect(r.errors).toEqual([]);
      expect(r.cpp).toBe(ref.cpp);
    }
  });

  it("is refused at RETURN when off, twincat3 included", () => {
    for (const opts of [
      {},
      { strict: true },
      { dialect: "iec-3" },
      { dialect: TWINCAT3 },
    ] as Partial<CompileOptions>[]) {
      expect(diag(CONDITIONAL, opts).errors).toEqual([
        "4:1: RETURN (condition) needs the feature conditional_return",
      ]);
    }
  });

  it("checks the condition like an IF condition", () => {
    const src = CONDITIONAL.replace("RETURN (x > 5);", "RETURN (x);");
    expect(diag(src, { features: ["+conditional_return"] }).errors).toEqual([
      "4:8: Condition must be a boolean or bit type, got INT",
    ]);
  });

  it("takes only a parenthesised condition", () => {
    const src = CONDITIONAL.replace("RETURN (x > 5);", "RETURN x > 5;");
    expect(diag(src, { features: ["+conditional_return"] }).errors).toContain(
      "4:8: Expected `Semicolon`, found identifier `X`.",
    );
  });

  it("works in a METHOD and an FB body", () => {
    const src = `FUNCTION_BLOCK FB_A
VAR_INPUT go : BOOL; END_VAR
VAR_OUTPUT n : INT; END_VAR
METHOD M : INT
VAR_INPUT k : INT; END_VAR
M := k;
RETURN (k < 0);
M := k * 2;
END_METHOD
RETURN (NOT go);
n := n + 1;
END_FUNCTION_BLOCK
`;
    expect(diag(src, { dialect: CODESYS3 }).errors).toEqual([]);
    expect(diag(src, { dialect: TWINCAT3 }).errors).toEqual([
      "10:1: RETURN (condition) needs the feature conditional_return",
      "7:1: RETURN (condition) needs the feature conditional_return",
    ]);
  });
});
