/**
 * A variable of PROGRAM type whose program is never reached by name is called
 * through its own instance: inputs bound, then `run()`.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

function body(src: string): string {
  const r = compile(src, { headerFileName: "generated.hpp" });
  expect(r.errors).toEqual([]);
  const m = /void Program_MAIN::run\(\) \{\n([\s\S]*?)\n\}/.exec(r.cppCode);
  return m?.[1] ?? "";
}

describe("call of a PROGRAM-typed variable", () => {
  it("runs the instance and binds its inputs", () => {
    const b = body(`
      PROGRAM PCount
      VAR_INPUT step : INT := 1; END_VAR
      VAR n : INT; END_VAR
        n := n + step;
      END_PROGRAM
      PROGRAM Main
      VAR p : PCount; END_VAR
        p();
        p(step := 5);
        p(2);
      END_PROGRAM`);
    expect(b).toContain("P.run();");
    expect(b).toContain("P.STEP = 5;");
    expect(b).toContain("P.STEP = 2;");
    expect(b).not.toContain("P();");
  });
});
