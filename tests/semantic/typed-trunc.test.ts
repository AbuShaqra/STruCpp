/**
 * Typed truncation (IEC 61131-3 Ed. 3, Table 22): TRUNC_<int> takes any
 * ANY_REAL, <real>_TRUNC_<int> a fixed REAL or LREAL; both return <int>.
 */
import { describe, it, expect } from "vitest";
import { resolve } from "path";
import { compile } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";
import { StdFunctionRegistry } from "../../src/semantic/std-function-registry.js";

const libraries = discoverStlibs(resolve(__dirname, "../../libs"));
const INTS = ["SINT", "INT", "DINT", "LINT", "USINT", "UINT", "UDINT", "ULINT"];
const REALS = ["REAL", "LREAL"];

function prog(decls: string, body: string): string {
  return `PROGRAM main
  VAR
    ${decls}
  END_VAR
  ${body}
END_PROGRAM
`;
}

function msgs(source: string, strict = false, dialect?: string): string[] {
  return compile(source, { strict, libraries, dialect }).errors.map(
    (e) => `${e.line}: ${e.message}`,
  );
}

function warnings(source: string): string[] {
  return compile(source, { libraries }).warnings.map(
    (e) => `${e.line}: ${e.message}`,
  );
}

describe("typed truncation — registry", () => {
  const registry = new StdFunctionRegistry();

  it("resolves TRUNC_<int> and <real>_TRUNC_<int> for every ANY_REAL x ANY_INT", () => {
    for (const to of INTS) {
      const over = registry.resolveTypedTrunc(`trunc_${to.toLowerCase()}`);
      expect(over?.specificReturnType).toBe(to);
      expect(over?.params[0]?.constraint).toBe("ANY_REAL");
      expect(registry.isStandardFunction(`TRUNC_${to}`)).toBe(true);
      for (const from of REALS) {
        const typed = registry.resolveTypedTrunc(`${from}_TRUNC_${to}`);
        expect(typed?.specificReturnType).toBe(to);
        expect(typed?.params[0]?.specificType).toBe(from);
        expect(typed?.cppName).toBe(`${from}_TRUNC_${to}`);
      }
    }
  });

  it("does not resolve other names", () => {
    for (const n of [
      "TRUNC",
      "TRUNC_REAL",
      "TRUNC_BYTE",
      "INT_TRUNC_DINT",
      "REAL_TRUNC_REAL",
      "D_TRUNC",
      "XTRUNC_INT",
    ]) {
      expect(registry.resolveTypedTrunc(n)).toBeUndefined();
    }
  });

  it("stays out of the published function list (getAll)", () => {
    expect(registry.getAll().some((d) => d.name.includes("TRUNC_"))).toBe(
      false,
    );
  });
});

describe("typed truncation — type checking", () => {
  const DECLS =
    "r : REAL; lr : LREAL; si : SINT; i : INT; d : DINT; l : LINT; us : USINT; ui : UINT; ud : UDINT; ul : ULINT;";

  it("every result type fits its own target under --strict and iec-3", () => {
    const vars: Record<string, string> = {
      SINT: "si",
      INT: "i",
      DINT: "d",
      LINT: "l",
      USINT: "us",
      UINT: "ui",
      UDINT: "ud",
      ULINT: "ul",
    };
    const body = INTS.map(
      (t) =>
        `${vars[t]} := TRUNC_${t}(r); ${vars[t]} := TRUNC_${t}(lr); ${vars[t]} := REAL_TRUNC_${t}(r); ${vars[t]} := LREAL_TRUNC_${t}(lr);`,
    ).join("\n");
    expect(msgs(prog(DECLS, body), true)).toEqual([]);
    expect(msgs(prog(DECLS, body), true, "iec-3")).toEqual([]);
  });

  it("TRUNC_INT's result is INT: narrowing into SINT is refused under --strict", () => {
    const m = msgs(prog(DECLS, "si := TRUNC_INT(r);"), true);
    expect(m.length).toBe(1);
    expect(m[0]).toContain("INT_TO_SINT");
  });

  it("TRUNC_SINT widens into DINT without a diagnostic", () => {
    expect(msgs(prog(DECLS, "d := TRUNC_SINT(lr);"), true)).toEqual([]);
  });

  it("REAL_TRUNC_INT of an LREAL warns about narrowing its argument", () => {
    const src = prog(DECLS, "i := REAL_TRUNC_INT(lr);");
    expect(msgs(src)).toEqual([]);
    expect(warnings(src).join("\n")).toContain("expects REAL, got LREAL");
  });

  it("TRUNC_INT of a STRING is refused", () => {
    const m = msgs(prog("s : STRING; i : INT;", "i := TRUNC_INT(s);"));
    expect(m.join("\n")).toContain("expects ANY_REAL");
  });

  it("TRUNC_INT takes exactly one argument", () => {
    const m = msgs(prog(DECLS, "i := TRUNC_INT(r, r);"));
    expect(m.join("\n")).toContain("'TRUNC_INT' requires 1 argument");
  });

  it("a user FUNCTION named TRUNC_INT keeps its own signature", () => {
    const src = `FUNCTION TRUNC_INT : INT
VAR_INPUT a : INT; b : INT; END_VAR
TRUNC_INT := a + b;
END_FUNCTION
${prog("i : INT;", "i := TRUNC_INT(1, 2);")}`;
    const r = compile(src, { libraries });
    expect(r.errors).toEqual([]);
    expect(r.cppCode).toContain("TRUNC_INT(");
    expect(r.cppCode).not.toContain("IEC_REAL(");
  });
});
