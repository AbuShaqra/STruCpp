/**
 * C++ generation for a PROGRAM reached by name from another POU (feature
 * program_methods): one shared header instance, `__program_<NAME>`, that
 * other POUs, the configuration, the debug table, the REPL harness and the
 * test harness all name. A program nobody reaches keeps its usual code.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { generateReplMain } from "../../src/backend/repl-main-gen.js";
import {
  buildPOUInfoFromAST,
  generateTestMain,
} from "../../src/backend/test-main-gen.js";
import { parseTestFile } from "../../src/testing/test-parser.js";

const ON = { features: ["+program_methods"] };

function compileOk(source: string): ReturnType<typeof compile> {
  const result = compile(source, ON);
  expect(result.errors.map((e) => `${e.line}: ${e.message}`)).toEqual([]);
  expect(result.success).toBe(true);
  return result;
}

const strip = (code: string): string[] =>
  code.split("\n").filter((l) => !l.startsWith("#line"));

const PRG = `PROGRAM PRG_A
VAR_INPUT inp : INT; END_VAR
VAR_OUTPUT done : BOOL; END_VAR
VAR cnt : INT; END_VAR
METHOD Bump : INT
VAR_INPUT k : INT; END_VAR
  cnt := cnt + k;
  Bump := cnt;
END_METHOD
  cnt := cnt + inp;
END_PROGRAM
`;

const CFG = `CONFIGURATION C
  VAR_GLOBAL g : INT; END_VAR
  RESOURCE R ON PLC
    TASK T(INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM PA WITH T : PRG_A;
    PROGRAM M WITH T : MAIN;
  END_RESOURCE
END_CONFIGURATION
`;

describe("codegen: a PROGRAM reached by name", () => {
  it("emits the shared instance after the program class, and uses it from other POUs", () => {
    const r = compileOk(`${PRG}FUNCTION_BLOCK FB_R
VAR_OUTPUT got : INT; END_VAR
  got := PRG_A.cnt;
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR x : INT; b : BOOL; END_VAR
  x := PRG_A.Bump(k := 5);
  PRG_A.inp := 2;
  PRG_A(inp := 3, done => b);
END_PROGRAM
`);
    const header = strip(r.headerCode);
    const classEnd = header.findIndex(
      (l, i) => i > header.indexOf("class Program_PRG_A : public ProgramBase {") && l === "};",
    );
    expect(header.slice(classEnd + 1, classEnd + 5)).toEqual([
      "",
      "// The one instance of PROGRAM PRG_A, reached by name from other POUs",
      "inline Program_PRG_A __program_PRG_A;",
      "",
    ]);
    expect(header.filter((l) => l.includes("__program_MAIN"))).toEqual([]);
    const cpp = r.cppCode;
    expect(cpp).toContain("GOT = __program_PRG_A.CNT;");
    expect(cpp).toContain("X = __program_PRG_A.BUMP(5);");
    expect(cpp).toContain("__program_PRG_A.INP = 2;");
    expect(cpp).toContain(
      [
        "    __program_PRG_A.INP = 3;",
        "    __program_PRG_A.run();",
        "    __program_PRG_A.ENO = true;",
        "    B = __program_PRG_A.DONE;",
      ].join("\n"),
    );
  });

  it("passes VAR_EXTERNAL globals to the shared instance and binds the configuration's reference", () => {
    const r = compileOk(`${PRG.replace(
      "VAR cnt : INT; END_VAR",
      "VAR cnt : INT; END_VAR\nVAR_EXTERNAL g : INT; END_VAR",
    )}PROGRAM MAIN
  PRG_A.Bump(1);
END_PROGRAM
${CFG}`);
    const header = strip(r.headerCode);
    expect(header).toContain("inline Program_PRG_A __program_PRG_A(&G);");
    expect(header).toContain("    Program_PRG_A& PA;");
    expect(header).toContain("    Program_MAIN M;");
    expect(r.cppCode).toContain("    : PA(__program_PRG_A),M()");
    expect(r.debugTableCpp).toContain("(void*)&::strucpp::__program_PRG_A.CNT");
    expect(r.debugTableCpp).not.toContain("g_config.PA.");
  });

  it("the REPL harness names the shared instance", () => {
    const r = compileOk(`${PRG}PROGRAM MAIN
  PRG_A.Bump(1);
END_PROGRAM
`);
    const main = generateReplMain(r.ast!, r.projectModel!);
    expect(main).toContain(
      "static Program_PRG_A& prog_PRG_A = __program_PRG_A;",
    );
    expect(main).toContain("static Program_MAIN prog_MAIN;");
  });

  it("the test harness binds a test's program variable to the shared instance", () => {
    const r = compileOk(`${PRG}PROGRAM MAIN
  PRG_A.Bump(1);
END_PROGRAM
`);
    const parsed = parseTestFile(
      `TEST 't'
VAR a : PRG_A; m : MAIN; END_VAR
  a();
END_TEST
`,
      "test_x.st",
    );
    const main = generateTestMain([parsed.testFile!], {
      headerFileName: "generated.hpp",
      pous: buildPOUInfoFromAST(r.ast!).pous,
      ast: r.ast!,
    });
    expect(main).toContain("Program_PRG_A& A = __program_PRG_A;");
    expect(main).toContain("Program_MAIN M;");
  });

  it("leaves a program nobody reaches as it was", () => {
    const withMethods = compileOk(`${PRG}PROGRAM MAIN
VAR x : INT; END_VAR
  x := 1;
END_PROGRAM
${CFG}`);
    expect(withMethods.headerCode).not.toContain("__program_");
    expect(withMethods.cppCode).not.toContain("__program_");
    expect(withMethods.headerCode).toContain("    Program_PRG_A PA;");
  });
});
