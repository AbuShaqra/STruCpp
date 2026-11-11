/**
 * `=` / `<>` of a STRUCT reached through `^` (REF_TO, POINTER TO) or a
 * REFERENCE TO compares member-wise, as of two STRUCT variables; comparing
 * the references themselves is unchanged.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const run = (body: string) =>
  compile(
    `TYPE P : STRUCT x : INT; y : INT; END_STRUCT END_TYPE
PROGRAM Main
VAR s1, s2 : P; r1, r2 : REF_TO P; p1 : POINTER TO P; rr : REFERENCE TO P; b : BOOL; END_VAR
${body}
END_PROGRAM
`,
    {},
  );

describe("dereferenced STRUCT equality", () => {
  it("compares r1^ = r2^ and p1^ <> s2 member-wise", () => {
    const r = run("b := r1^ = r2^; b := p1^ <> s2;");
    expect(r.errors).toEqual([]);
    expect(r.cppCode).toContain("__l.X == __r.X");
    expect(r.cppCode).toMatch(/\(\(\*R1\), \(\*R2\)\)|\(\*R1\), \(\*R2\)\)/);
  });

  it("compares a REFERENCE TO through its target", () => {
    const r = run("b := rr = s2;");
    expect(r.errors).toEqual([]);
    expect(r.cppCode).toContain("(RR.target(), S2)");
  });

  it("still compares two REF_TO as references", () => {
    const r = run("b := r1 = r2;");
    expect(r.errors).toEqual([]);
    expect(r.cppCode).not.toContain("__l.X");
  });
});
