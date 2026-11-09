/**
 * C++ generation of METHODs in a PROGRAM (feature program_methods).
 *
 * A program method is a plain, non-virtual member function of
 * `Program_<NAME>` (D7): programs have no inheritance, so nothing needs
 * dispatch, and the class's vtable (the `ProgramBase` overrides) stays exactly
 * as for a program without methods (Review Focus 5). The method body sees the
 * program's VARs with their own types and goes through the same VAR_EXTERNAL
 * rewriting as `run()` (Review Focus 6).
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { CodeGenerator } from "../../src/backend/codegen.js";

const ON = { features: ["+program_methods"] };

function compileOk(source: string): ReturnType<typeof compile> {
  const result = compile(source, ON);
  expect(result.errors.map((e) => `${e.line}: ${e.message}`)).toEqual([]);
  expect(result.success).toBe(true);
  return result;
}

/** The text of `class <name> ... };` in a header, without #line directives. */
function classBlock(header: string, name: string): string {
  const lines = header
    .split("\n")
    .filter((l) => !l.startsWith("#line"));
  const start = lines.findIndex((l) => l.startsWith(`class ${name} :`));
  expect(start).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((l, i) => i > start && l === "};");
  return lines.slice(start, end + 1).join("\n");
}

/** A function body `<sig> { ... }` from the implementation, by its signature. */
function functionBody(cpp: string, signature: string): string {
  const lines = cpp.split("\n").filter((l) => !l.startsWith("#line"));
  const start = lines.findIndex((l) => l.startsWith(signature));
  expect(start).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((l, i) => i > start && l === "}");
  return lines.slice(start, end + 1).join("\n");
}

const WITH_METHODS = `PROGRAM MAIN
VAR
  n : INT;
  x AT %IX0.0 : BOOL;
END_VAR
METHOD Count : INT
  n := n + 1;
  Count := n;
END_METHOD
METHOD Add : INT
VAR_INPUT k : INT; END_VAR
  n := n + k;
  Add := n;
END_METHOD
METHOD Reset
  n := 0;
END_METHOD
METHOD PRIVATE Hidden
  n := 5;
END_METHOD
  Count();
END_PROGRAM
`;

// The same program without its methods: the class must be the same apart
// from the method declarations.
const WITHOUT_METHODS = `PROGRAM MAIN
VAR
  n : INT;
  x AT %IX0.0 : BOOL;
END_VAR
  n := n + 1;
END_PROGRAM
`;

describe("PROGRAM methods: the class declaration", () => {
  it("declares each method as a member with no virtual", () => {
    const cls = classBlock(compileOk(WITH_METHODS).headerCode, "Program_MAIN");
    expect(cls).toContain("    IEC_INT COUNT();");
    expect(cls).toContain("    IEC_INT ADD(IEC_INT K);");
    expect(cls).toContain("    void RESET();");
    expect(cls).toMatch(/private:\n {4}void HIDDEN\(\);\npublic:/);
    expect(cls).not.toContain("virtual");
    expect(cls).not.toContain(" final");
  });

  it("leaves the ProgramBase override block unchanged", () => {
    const withM = classBlock(compileOk(WITH_METHODS).headerCode, "Program_MAIN");
    const without = classBlock(
      compileOk(WITHOUT_METHODS).headerCode,
      "Program_MAIN",
    );
    // The program with a located VAR has the threaded override too.
    expect(without).toContain("void run() override;");
    expect(without).toContain("void located_range(");
    // Everything but the methods section is byte-identical.
    const methodsStart = withM.indexOf("\n\n    // Methods\n");
    expect(methodsStart).toBeGreaterThan(0);
    const stripped = withM.slice(0, methodsStart) + "\n};";
    expect(stripped).toBe(without);
    // Methods come after the overrides and add none.
    const overrides = (s: string): string[] =>
      s.split("\n").filter((l) => l.includes("override"));
    expect(overrides(withM)).toEqual(overrides(without));
  });

  it("a program without methods has no methods section", () => {
    const cls = classBlock(
      compileOk(WITHOUT_METHODS).headerCode,
      "Program_MAIN",
    );
    expect(cls).not.toContain("// Methods");
  });

  it("a VAR_INST of a program method is a mangled member", () => {
    const result = compileOk(`PROGRAM MAIN
METHOD Tick : INT
VAR_INST calls : INT; END_VAR
  calls := calls + 1;
  Tick := calls;
END_METHOD
  Tick();
END_PROGRAM
`);
    const cls = classBlock(result.headerCode, "Program_MAIN");
    expect(cls).toContain("    IEC_INT __TICK__CALLS;");
    expect(
      functionBody(result.cppCode, "IEC_INT Program_MAIN::TICK()"),
    ).toContain("__TICK__CALLS = __TICK__CALLS + 1;");
  });
});

describe("PROGRAM methods: the implementation", () => {
  it("defines the methods as Program_<NAME> members after run()", () => {
    const cpp = compileOk(WITH_METHODS).cppCode;
    const run = cpp.indexOf("void Program_MAIN::run() {");
    const count = cpp.indexOf("IEC_INT Program_MAIN::COUNT() {");
    expect(run).toBeGreaterThan(0);
    expect(count).toBeGreaterThan(run);
    expect(cpp).toContain("IEC_INT Program_MAIN::ADD(IEC_INT K) {");
    expect(cpp).toContain("void Program_MAIN::RESET() {");
    expect(functionBody(cpp, "IEC_INT Program_MAIN::COUNT()")).toContain(
      "return COUNT_result;",
    );
  });

  it("a program method sees its own VAR types when an FB generated just before has a variable of the same name and another type", () => {
    // The program's `motor : Motor` collides with its type's name, so the
    // member is MOTOR_, and an FB instance call becomes input assignments
    // plus `MOTOR_()`. Both come from the method's scope: with the FB's
    // `motor : BOOL`, or no program VARs, it would be `MOTOR(7)`.
    const result = compileOk(`FUNCTION_BLOCK Motor
VAR_INPUT speed : INT; END_VAR
END_FUNCTION_BLOCK
FUNCTION_BLOCK Before
VAR motor : BOOL; END_VAR
METHOD Go
  motor := NOT motor;
END_METHOD
  motor := NOT motor;
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR motor : Motor; b : Before; END_VAR
METHOD Go
  motor.speed := 5;
  motor(speed := 7);
END_METHOD
  Go();
  b();
END_PROGRAM
`);
    const go = functionBody(result.cppCode, "void Program_MAIN::GO()");
    expect(go).toContain("MOTOR_.SPEED = 5;");
    expect(go).toContain("MOTOR_.SPEED = 7;");
    expect(go).toContain("MOTOR_();");
    expect(go).not.toContain("MOTOR(");
    expect(functionBody(result.cppCode, "void BEFORE::GO()")).toContain(
      "MOTOR = !MOTOR;",
    );
  });

  it("a program method's VAR_EXTERNAL goes through the GlobalVar pointer, as in run()", () => {
    const result = compileOk(`CONFIGURATION C
  VAR_GLOBAL g : INT := 7; END_VAR
  RESOURCE R ON PLC
    TASK T(INTERVAL := T#100ms, PRIORITY := 1);
    PROGRAM Inst WITH T : MAIN;
  END_RESOURCE
END_CONFIGURATION
PROGRAM MAIN
VAR_EXTERNAL g : INT; END_VAR
METHOD Bump
  g := g + 1;
END_METHOD
  g := g + 1;
  Bump();
END_PROGRAM
`);
    const run = functionBody(result.cppCode, "void Program_MAIN::run()");
    const bump = functionBody(result.cppCode, "void Program_MAIN::BUMP()");
    const stmt = (body: string): string =>
      body.split("\n").find((l) => l.includes("G->write"))!.trim();
    expect(stmt(run)).toMatch(/G->write\(.*G->read\(\)/);
    expect(stmt(bump)).toBe(stmt(run));
  });

  it("MAIN.Name() inside MAIN is a call on this", () => {
    const result = compileOk(`PROGRAM MAIN
VAR n : INT; END_VAR
METHOD One : INT
  One := 1;
END_METHOD
METHOD Two : INT
  Two := MAIN.One() + 1;
END_METHOD
  n := MAIN.Two();
  MAIN.One();
END_PROGRAM
`);
    const run = functionBody(result.cppCode, "void Program_MAIN::run()");
    expect(run).toContain("N = this->TWO();");
    expect(run).toContain("this->ONE();");
    expect(functionBody(result.cppCode, "IEC_INT Program_MAIN::TWO()")).toContain(
      "this->ONE() + 1",
    );
  });

  it("the AST path (no project model) generates the same members", () => {
    const front = compileOk(WITH_METHODS);
    const gen = new CodeGenerator(front.symbolTables!);
    const out = gen.generate(front.ast!);
    const cls = classBlock(out.headerCode, "Program_MAIN");
    expect(cls).toContain("    IEC_INT COUNT();");
    expect(cls).toContain("    IEC_INT ADD(IEC_INT K);");
    expect(cls).not.toContain("virtual");
    expect(out.cppCode).toContain("IEC_INT Program_MAIN::ADD(IEC_INT K) {");
    expect(functionBody(out.cppCode, "IEC_INT Program_MAIN::ADD(")).toContain(
      "N = N + K;",
    );
  });
});
