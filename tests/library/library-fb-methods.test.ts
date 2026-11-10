/**
 * A library archive lists each function block's methods (signature,
 * defaults, visibility); a consumer binds `inst.M(...)` arguments by name and
 * fills omitted inputs from it. An archive without the list keeps passing the
 * arguments through as written.
 */
import { describe, it, expect } from "vitest";
import { compile, compileStlib } from "../../src/index.js";
import type { StlibArchive } from "../../src/library/library-manifest.js";

const LIB = `FUNCTION_BLOCK FB_Cnt
VAR_OUTPUT n : INT; END_VAR
METHOD Add : INT
VAR_INPUT k : INT := 3; m : INT := 1; END_VAR
VAR_OUTPUT old : INT; END_VAR
VAR_IN_OUT acc : INT; END_VAR
  old := n;
  n := n + k * m;
  acc := acc + n;
  Add := n;
END_METHOD
METHOD PROTECTED Inner
END_METHOD
END_FUNCTION_BLOCK`;

function library(): StlibArchive {
  const lib = compileStlib([{ source: LIB, fileName: "cnt.st" }], {
    name: "cnt-lib",
    version: "1.0.0",
    namespace: "strucpp",
  });
  expect(lib.success).toBe(true);
  return lib.archive!;
}

const PROGRAM = `PROGRAM Main
VAR tn : FB_Cnt; a : INT; b : INT; o : INT; s : INT; END_VAR
  a := tn.Add(acc := s);
  b := tn.Add(m := 2, k := 5, old => o, acc := s);
END_PROGRAM`;

describe("library function block methods", () => {
  it("are listed in the manifest", () => {
    const fb = library().manifest.functionBlocks.find(
      (b) => b.name === "FB_CNT",
    );
    expect(fb?.methods).toEqual([
      {
        name: "ADD",
        returnType: { name: "ADD", type: "INT" },
        parameters: [
          { name: "K", type: "INT", direction: "input", initialValue: "3" },
          { name: "M", type: "INT", direction: "input", initialValue: "1" },
          { name: "OLD", type: "INT", direction: "output" },
          { name: "ACC", type: "INT", direction: "inout" },
        ],
      },
      { name: "INNER", parameters: [], visibility: "PROTECTED" },
    ]);
  });

  it("bind named arguments and fill omitted inputs", () => {
    const r = compile(PROGRAM, {
      headerFileName: "generated.hpp",
      libraries: [library()],
    });
    expect(r.errors).toEqual([]);
    expect(r.cppCode).toContain("A = TN.ADD(3, 1, __output_tmp_0, S);");
    expect(r.cppCode).toContain("B = TN.ADD(5, 2, O, S);");
  });

  it("an archive without the list passes the arguments through", () => {
    const archive = library();
    for (const fb of archive.manifest.functionBlocks) delete fb.methods;
    const r = compile(PROGRAM, {
      headerFileName: "generated.hpp",
      libraries: [archive],
    });
    expect(r.errors).toEqual([]);
    expect(r.cppCode).toContain("A = TN.ADD(S);");
    expect(r.cppCode).toContain("B = TN.ADD(2, 5, O, S);");
  });
});
