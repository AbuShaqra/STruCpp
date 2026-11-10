/**
 * A call of a function block instance that is a member of another instance
 * (`inst.sub(k := 5)`) or a file-level global (`gfb(a := 2)`) binds its
 * arguments by name; a bit selected by a named constant (`w.C3`) is a shift
 * by the constant; a method call on a variable renamed for its type name
 * uses the renamed variable.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

function body(src: string): string {
  const r = compile(src, { headerFileName: "generated.hpp" });
  expect(r.errors).toEqual([]);
  const m = /void Program_MAIN::run\(\) \{\n([\s\S]*?)\n\}/.exec(r.cppCode);
  return m?.[1] ?? "";
}

const FBS = `
  FUNCTION_BLOCK FBS
  VAR_INPUT k : INT; END_VAR
  VAR_OUTPUT o : INT; END_VAR
    o := o + k + 1;
  END_FUNCTION_BLOCK
  FUNCTION_BLOCK FBH
  VAR sub : FBS; END_VAR
  END_FUNCTION_BLOCK
`;

describe("FB call on a member or global instance", () => {
  it("binds named arguments of a member instance call", () => {
    const b = body(`${FBS}
      PROGRAM Main
      VAR inst : FBH; END_VAR
        inst.sub(k := 5);
        inst.sub();
      END_PROGRAM`);
    expect(b).toContain("INST.SUB.K = 5;");
    expect(b).toContain("INST.SUB();");
    expect(b).not.toContain("INST.SUB(5)");
  });

  it("binds named arguments of a global instance call", () => {
    const b = body(`${FBS}
      VAR_GLOBAL gfb : FBS; END_VAR
      PROGRAM Main
        gfb(k := 2);
        gfb(3);
      END_PROGRAM`);
    expect(b).toContain("GFB.K = 2;");
    expect(b).toContain("GFB.K = 3;");
    expect(b).not.toContain("GFB(2)");
  });

  it("a local instance shadows a global of the same name", () => {
    const b = body(`${FBS}
      VAR_GLOBAL g : INT; END_VAR
      PROGRAM Main
      VAR g2 : FBS; END_VAR
        g2(k := 1);
      END_PROGRAM`);
    expect(b).toContain("G2.K = 1;");
  });
});

describe("bit selected by a named constant", () => {
  it("reads and writes through a local or global constant", () => {
    const b = body(`
      VAR_GLOBAL CONSTANT G5 : INT := 5; END_VAR
      PROGRAM Main
      VAR CONSTANT C3 : INT := 3; END_VAR
      VAR w : WORD; b : BOOL; END_VAR
        b := w.C3;
        w.G5 := TRUE;
      END_PROGRAM`);
    expect(b).toContain(
      "B = ((static_cast<uint64_t>(W) >> static_cast<uint64_t>(C3)) & 1);",
    );
    expect(b).toContain("(1ULL << static_cast<uint64_t>(G5))");
    expect(b).not.toContain("W.C3");
  });
});

describe("method call on a variable renamed for its type name", () => {
  it("calls the method on the renamed variable", () => {
    const b = body(`
      FUNCTION_BLOCK FBB
      METHOD M : INT
        M := 1;
      END_METHOD
      END_FUNCTION_BLOCK
      PROGRAM Main
      VAR fbb : FBB; r : INT; END_VAR
        r := fbb.M();
      END_PROGRAM`);
    expect(b).toContain("R = FBB_.M();");
  });
});
