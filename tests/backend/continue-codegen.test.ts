import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const src = (body: string) =>
  `PROGRAM Main\nVAR i : INT; n : INT; END_VAR\n${body}\nEND_PROGRAM\n`;

describe("CONTINUE code generation", () => {
  it("emits continue; in a C++ for", () => {
    const r = compile(
      src("FOR i := 1 TO 5 DO IF i = 3 THEN CONTINUE; END_IF; n := n + i; END_FOR;"),
    );
    expect(r.errors.map((e) => e.message)).toEqual([]);
    expect(r.cppCode).toMatch(/for \([^\n]*\{[\s\S]*continue;[\s\S]*\}/);
  });

  it("emits continue; for CASE inside a loop", () => {
    const r = compile(
      src("WHILE n < 5 DO n := n + 1; CASE n OF 2: CONTINUE; END_CASE; END_WHILE;"),
    );
    expect(r.errors.map((e) => e.message)).toEqual([]);
    expect(r.cppCode).toContain("continue;");
  });
});
