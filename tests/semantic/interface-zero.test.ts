/**
 * The feature interface_zero: `itf := 0` assigns NULL to an interface
 * variable (statement, initial value, interface input). Comparing an
 * interface with 0 is accepted in every dialect, as before.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import {
  DEFAULT_FEATURES,
  KNOWN_FEATURES,
  resolveDialect,
} from "../../src/dialect.js";

const ON = ["+interface_zero"];

const TYPES = `INTERFACE I_A
METHOD M : INT
END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB_A IMPLEMENTS I_A
METHOD M : INT
M := 7;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION F : BOOL
VAR_INPUT x : I_A; END_VAR
F := x = 0;
END_FUNCTION
FUNCTION_BLOCK FB_U
VAR_INPUT i : I_A; END_VAR
END_FUNCTION_BLOCK
`;

/** Lines of the program body start at line 25 of the unit. */
function unit(decls: string, body: string): string {
  return `${TYPES}PROGRAM MAIN
VAR
  itf : I_A;
  fb : FB_A;
  u : FB_U;
  b : BOOL;
  ${decls}
END_VAR
${body}
END_PROGRAM
`;
}

function errors(
  source: string,
  opts: { features?: string[]; dialect?: string; strict?: boolean } = {},
): string[] {
  return compile(source, opts).errors.map((e) => e.message);
}

describe("interface_zero — the feature", () => {
  it("is known but in neither the default set nor iec-3", () => {
    expect(KNOWN_FEATURES).toContain("interface_zero");
    expect(DEFAULT_FEATURES.has("interface_zero")).toBe(false);
    expect(resolveDialect({ dialect: "iec-3" }).features).not.toContain(
      "interface_zero",
    );
    expect(resolveDialect({ features: ON }).features).toContain(
      "interface_zero",
    );
  });
});

describe("interface_zero — on", () => {
  it("accepts itf := 0, an initial value 0 and 0 into an interface input", () => {
    const src = unit(
      "itf2 : I_A := 0;",
      "itf := 0;\nb := F(0);\nu(i := 0);\nb := F(x := 0);",
    );
    expect(errors(src, { features: ON })).toEqual([]);
    expect(errors(src, { features: ON, strict: true })).toEqual([]);
    expect(
      errors(src, { dialect: "iec-3", features: ON, strict: true }),
    ).toEqual([]);
  });

  it("lowers 0 into an interface as NULL", () => {
    const r = compile(unit("itf2 : I_A := 0;", "itf := 0;\nb := F(0);"), {
      features: ON,
    });
    expect(r.errors).toEqual([]);
    expect(r.cppCode).toContain("ITF = IEC_NULL;");
    expect(r.cppCode).toContain("ITF2(IEC_NULL)");
    expect(r.cppCode).toContain("F(IEC_NULL)");
  });

  it("still refuses any other integer", () => {
    for (const v of ["1", "-1", "INT#0", "16#1"]) {
      const m = errors(unit("", `itf := ${v};`), { features: ON });
      expect(m.length).toBe(1);
      expect(m[0]).toMatch(/^Cannot assign \w+ to I_A$/);
    }
  });
});

describe("interface_zero — off", () => {
  const MSG = "Assigning 0 to interface I_A needs the feature interface_zero";

  for (const dialect of [undefined, "iec-3"]) {
    const tag = dialect ?? "no dialect";

    it(`itf := 0 names the feature (${tag})`, () => {
      expect(errors(unit("", "itf := 0;"), { dialect })).toEqual([MSG]);
    });

    it(`an initial value 0 names the feature (${tag})`, () => {
      expect(errors(unit("itf2 : I_A := 0;", ""), { dialect })).toEqual([MSG]);
    });

    it(`0 into an interface input names the feature (${tag})`, () => {
      expect(errors(unit("", "b := F(0);"), { dialect })).toEqual([MSG]);
      expect(errors(unit("", "u(i := 0);"), { dialect })).toEqual([MSG]);
    });

    it(`itf := 1 stays refused as before (${tag})`, () => {
      expect(errors(unit("", "itf := 1;"), { dialect })).toEqual([
        "Cannot assign INT to I_A",
      ]);
    });
  }

  it("the message lists the loaded profiles that have the feature", () => {
    const m = errors(unit("", "itf := 0;"), {
      dialect: {
        id: "zero",
        name: "zero",
        features: ["interface_zero"],
        semantics: {},
      },
      features: ["-interface_zero"],
    });
    expect(m).toEqual([`${MSG} (profiles: zero)`]);
  });
});

describe("comparing an interface with 0 (every dialect, unchanged)", () => {
  for (const opts of [
    {},
    { dialect: "iec-3" },
    { features: ON },
    { strict: true },
    { dialect: "iec-3", strict: true },
  ]) {
    it(`itf = 0 and itf <> 0 are accepted (${JSON.stringify(opts)})`, () => {
      const r = compile(
        unit("", "b := itf = 0;\nb := itf <> 0;\nb := 0 = itf;"),
        opts,
      );
      expect(r.errors).toEqual([]);
      expect(r.cppCode).toContain("B = ITF == 0;");
      expect(r.cppCode).toContain("B = ITF != 0;");
    });
  }
});
