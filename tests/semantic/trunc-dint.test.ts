/**
 * The feature trunc_dint: TRUNC of any ANY_REAL returns DINT (without it,
 * REAL gives DINT and LREAL gives LINT). Not in the default set nor iec-3.
 */
import { describe, it, expect } from "vitest";
import { resolve } from "path";
import { compile } from "../../src/index.js";
import {
  DEFAULT_FEATURES,
  KNOWN_FEATURES,
  resolveDialect,
} from "../../src/dialect.js";
import { discoverStlibs } from "../../src/node/library-loader.js";
import { StdFunctionRegistry } from "../../src/semantic/std-function-registry.js";

const libraries = discoverStlibs(resolve(__dirname, "../../libs"));
const ON = ["+trunc_dint"];

function prog(decls: string, body: string): string {
  return `PROGRAM main
  VAR
    ${decls}
  END_VAR
  ${body}
END_PROGRAM
`;
}
const DECLS = "r : REAL; lr : LREAL; d : DINT; l : LINT; i : INT;";

function diag(
  source: string,
  opts: { features?: string[]; strict?: boolean; libs?: boolean } = {},
): { errors: string[]; warnings: string[] } {
  const r = compile(source, {
    features: opts.features,
    strict: opts.strict ?? false,
    ...(opts.libs === false ? {} : { libraries }),
  });
  return {
    errors: r.errors.map((e) => `${e.line}: ${e.message}`),
    warnings: r.warnings.map((e) => `${e.line}: ${e.message}`),
  };
}

describe("trunc_dint — the feature", () => {
  it("is known but in neither the default set nor iec-3", () => {
    expect(KNOWN_FEATURES).toContain("trunc_dint");
    expect(DEFAULT_FEATURES.has("trunc_dint")).toBe(false);
    expect(resolveDialect({ dialect: "iec-3" }).features).not.toContain(
      "trunc_dint",
    );
    expect(resolveDialect({ features: ON }).features).toContain("trunc_dint");
  });

  it("gates TRUNC's registry result type", () => {
    const trunc = new StdFunctionRegistry().lookup("TRUNC")!;
    const on = new Set(["trunc_dint"]);
    expect(trunc.returnTypeFor!("REAL")).toBe("DINT");
    expect(trunc.returnTypeFor!("LREAL")).toBe("LINT");
    expect(trunc.returnTypeFor!("REAL", on)).toBe("DINT");
    expect(trunc.returnTypeFor!("LREAL", on)).toBe("DINT");
    expect(trunc.returnTypeFor!("INT", on)).toBeUndefined();
  });
});

describe("trunc_dint — type checking", () => {
  for (const libs of [true, false]) {
    const tag = libs ? "with the bundled libraries" : "without libraries";

    it(`strict: d := TRUNC(lr) is refused off and accepted on (${tag})`, () => {
      const src = prog(DECLS, "d := TRUNC(lr);");
      expect(diag(src, { strict: true, libs }).errors.length).toBe(1);
      expect(diag(src, { strict: true, libs, features: ON }).errors).toEqual(
        [],
      );
    });

    it(`TRUNC(lr) into a LINT is fine both ways (${tag})`, () => {
      const src = prog(DECLS, "l := TRUNC(lr);");
      expect(diag(src, { strict: true, libs }).errors).toEqual([]);
      expect(diag(src, { strict: true, libs, features: ON }).errors).toEqual(
        [],
      );
    });
  }

  it("f : INT := TRUNC(lr) warns about LINT off and DINT on", () => {
    const src = `PROGRAM main
  VAR
    lr : LREAL := 2.5;
    f : INT := TRUNC(lr);
  END_VAR
  f := TRUNC(lr);
END_PROGRAM
`;
    const off = diag(src);
    const on = diag(src, { features: ON });
    expect(off.errors).toEqual([]);
    expect(on.errors).toEqual([]);
    expect(off.warnings.join("\n")).toContain("from LINT to INT");
    expect(off.warnings.join("\n")).not.toContain("from DINT to INT");
    expect(on.warnings.join("\n")).toContain("from DINT to INT");
    expect(on.warnings.join("\n")).not.toContain("LINT");
    expect(off.warnings.length).toBe(on.warnings.length);
  });

  it("strict: i := TRUNC(lr) names LINT_TO_INT off and DINT_TO_INT on", () => {
    const src = prog(DECLS, "i := TRUNC(lr);");
    expect(diag(src, { strict: true }).errors.join("\n")).toContain(
      "LINT_TO_INT",
    );
    expect(
      diag(src, { strict: true, features: ON }).errors.join("\n"),
    ).toContain("DINT_TO_INT");
  });

  it("TRUNC(r) of a REAL is DINT either way", () => {
    const src = prog(DECLS, "d := TRUNC(r);");
    expect(diag(src, { strict: true }).errors).toEqual([]);
    expect(diag(src, { strict: true, features: ON }).errors).toEqual([]);
  });
});

describe("trunc_dint — codegen", () => {
  it("emits a DINT truncation for an LREAL only with the feature", () => {
    const src = prog(DECLS, "l := TRUNC(lr);\nd := TRUNC(r);");
    const off = compile(src, { libraries }).cppCode;
    const on = compile(src, { libraries, features: ON }).cppCode;
    expect(off).toContain("TRUNC(IEC_LREAL(LR))");
    expect(off).not.toContain("TRUNC_DINT");
    expect(on).toContain("TRUNC_DINT(IEC_LREAL(LR))");
    expect(on).toContain("TRUNC(IEC_REAL(R))");
  });
});
