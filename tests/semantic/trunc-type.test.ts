/**
 * TRUNC returns an integer: DINT for REAL, LINT for LREAL. Strict refuses
 * narrowing it into INT; non-strict accepts it (OSCAT relies on that).
 */
import { describe, it, expect } from "vitest";
import { resolve } from "path";
import { compile } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";

const libraries = discoverStlibs(resolve(__dirname, "../../libs"));

function prog(decls: string, body: string): string {
  return `PROGRAM main
  VAR
    ${decls}
  END_VAR
  ${body}
END_PROGRAM
`;
}
const DECLS = "r : REAL; lr : LREAL; d : DINT; l : LINT; i_int : INT;";

function msgs(source: string, strict: boolean): string[] {
  return compile(source, { strict, libraries }).errors.map(
    (e) => `${e.line}: ${e.message}`,
  );
}

describe("TRUNC result type", () => {
  it("TRUNC(REAL) is DINT", () => {
    expect(msgs(prog(DECLS, "d := TRUNC(r);"), true)).toEqual([]);
  });
  it("TRUNC(LREAL) is LINT", () => {
    expect(msgs(prog(DECLS, "l := TRUNC(lr);"), true)).toEqual([]);
  });
  it("TRUNC(LREAL) does not fit a DINT in strict mode", () => {
    expect(msgs(prog(DECLS, "d := TRUNC(lr);"), true).length).toBeGreaterThan(
      0,
    );
  });
  it("a bare REAL literal argument gives DINT (literal is REAL)", () => {
    expect(msgs(prog(DECLS, "d := TRUNC(2.7);"), true)).toEqual([]);
  });
  it("strict refuses i_int := TRUNC(r) naming DINT_TO_INT", () => {
    const m = msgs(prog(DECLS, "i_int := TRUNC(r);"), true);
    expect(m.length).toBe(1);
    expect(m[0]).toContain("DINT_TO_INT");
  });
  it("non-strict accepts i_int := TRUNC(r)", () => {
    expect(msgs(prog(DECLS, "i_int := TRUNC(r);"), false)).toEqual([]);
  });
});
