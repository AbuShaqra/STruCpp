/**
 * A file-level global read or written inside a class (FB, PROGRAM, method,
 * action, property accessor) whose member functions include one of the
 * global's name is emitted namespace-qualified, since the C++ member function
 * would hide it. The method keeps its name and its result variable.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const IFACE = `INTERFACE I_Station
METHOD Reset : BOOL
END_METHOD
END_INTERFACE
`;

function cpp(source: string, features?: string[]): string {
  const r = compile(source, features ? { features } : {});
  expect(r.errors).toEqual([]);
  return r.cppCode;
}

describe("a global named like a member function of the class", () => {
  it("qualifies a located global read in the FB body (interface method)", () => {
    const out = cpp(`VAR_GLOBAL
Reset AT %IX0.0 : BOOL;
END_VAR
${IFACE}FUNCTION_BLOCK FB_A IMPLEMENTS I_Station
VAR_OUTPUT seen : BOOL; END_VAR
METHOD Reset : BOOL
Reset := TRUE;
END_METHOD
seen := Reset;
END_FUNCTION_BLOCK
PROGRAM Main
VAR a : FB_A; i : I_Station; b : BOOL; END_VAR
i := a; a();
b := i.Reset() AND Reset;
END_PROGRAM
`);
    expect(out).toContain("SEEN = ::strucpp::RESET;");
    expect(out).toContain("RESET_result = true;");
    // Main has no member function RESET: the global keeps its plain name.
    expect(out).toContain(".RESET()) & (RESET));");
  });

  it("qualifies it in another method, a property getter and a write", () => {
    const out = cpp(`VAR_GLOBAL CONSTANT Reset : BOOL := TRUE; END_VAR
VAR_GLOBAL Pulse : INT; END_VAR
FUNCTION_BLOCK FB_A
VAR_OUTPUT o : BOOL; END_VAR
METHOD Reset : BOOL
Reset := FALSE;
END_METHOD
METHOD Pulse : INT
Pulse := 1;
END_METHOD
METHOD Check : BOOL
Check := Reset;
END_METHOD
PROPERTY P : BOOL
GET
P := NOT Reset;
END_GET
END_PROPERTY
o := Check() AND P;
Pulse := Pulse + 1;
END_FUNCTION_BLOCK
`);
    expect(out).toContain("CHECK_result = ::strucpp::RESET;");
    expect(out).toContain("P_result = !::strucpp::RESET;");
    expect(out).toMatch(/::strucpp::PULSE = .*::strucpp::PULSE/);
    expect(out).toContain("PULSE_result = 1;");
  });

  it("qualifies it in a derived FB, an FB action name and a PROGRAM action name", () => {
    const out = cpp(`VAR_GLOBAL Reset : BOOL; Go : INT; END_VAR
FUNCTION_BLOCK FB_A
METHOD Reset : BOOL
Reset := TRUE;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_B EXTENDS FB_A
VAR_OUTPUT o : BOOL; END_VAR
o := Reset;
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_C
VAR_OUTPUT n : INT; END_VAR
ACTION Go
n := 0;
END_ACTION
n := Go;
END_FUNCTION_BLOCK
PROGRAM Main
VAR n : INT; END_VAR
ACTION Go
n := 0;
END_ACTION
n := Go;
END_PROGRAM
`);
    expect(out).toContain("O = ::strucpp::RESET;");
    expect(out).toMatch(/\bN = ::strucpp::GO;[\s\S]*\bN = ::strucpp::GO;/);
  });

  it("qualifies it in a PROGRAM with a method of its name (program_methods)", () => {
    const out = cpp(
      `VAR_GLOBAL Reset : BOOL; END_VAR
PROGRAM Main
VAR b : BOOL; END_VAR
METHOD Reset : BOOL
Reset := TRUE;
END_METHOD
b := Reset;
END_PROGRAM
`,
      ["+program_methods"],
    );
    expect(out).toContain("B = ::strucpp::RESET;");
    expect(out).toContain("RESET_result = true;");
  });

  it("leaves a global unqualified where no member function has its name", () => {
    const out = cpp(`VAR_GLOBAL Reset : BOOL; END_VAR
FUNCTION_BLOCK FB_A
VAR_OUTPUT o : BOOL; END_VAR
METHOD Check : BOOL
VAR Reset : BOOL; END_VAR
Check := Reset;
END_METHOD
o := Reset;
END_FUNCTION_BLOCK
`);
    expect(out).not.toContain("::strucpp::RESET");
    expect(out).toContain("O = RESET;");
  });

  it("does not qualify a method's local named like a sibling method", () => {
    const out = cpp(`VAR_GLOBAL Reset : BOOL; END_VAR
FUNCTION_BLOCK FB_A
VAR_OUTPUT o : BOOL; END_VAR
METHOD Reset : BOOL
Reset := TRUE;
END_METHOD
METHOD Check : BOOL
VAR Reset : BOOL := TRUE; END_VAR
Check := Reset;
END_METHOD
o := Check();
END_FUNCTION_BLOCK
`);
    expect(out).toContain("CHECK_result = RESET;");
  });

  it("qualifies a list-qualified global in the body of an FB with a method of its name", () => {
    const r = compile(
      `FUNCTION_BLOCK FB_A
VAR_OUTPUT o : BOOL; END_VAR
METHOD Reset : BOOL
Reset := GVL_A.Reset;
END_METHOD
o := GVL_A.Reset;
END_FUNCTION_BLOCK
`,
      {
        fileName: "main.st",
        additionalSources: [
          {
            source: "VAR_GLOBAL Reset : BOOL; END_VAR\n",
            fileName: "GVL_A.st",
          },
        ],
        features: ["+named_global_lists"],
      },
    );
    expect(r.errors).toEqual([]);
    expect(r.cppCode).toContain("O = ::strucpp::RESET;");
    expect(r.cppCode).toContain("RESET_result = GVL_A__RESET;");
  });

  it("qualifies a global FB instance whose method is called", () => {
    const out = cpp(`FUNCTION_BLOCK FB_Pump
VAR_OUTPUT level : INT; END_VAR
METHOD Twice : INT
Twice := level * 2;
END_METHOD
END_FUNCTION_BLOCK
VAR_GLOBAL Pump : FB_Pump; END_VAR
FUNCTION_BLOCK FB_Station
VAR_OUTPUT n : INT; END_VAR
METHOD Pump : INT
Pump := 1;
END_METHOD
n := Pump.Twice() + Pump();
END_FUNCTION_BLOCK
`);
    expect(out).toContain("::strucpp::PUMP.TWICE()");
    expect(out).toContain("strucpp::iec_add<DINT_t>({::strucpp::PUMP.TWICE(), PUMP()});");
  });

  it("a method local of a VAR_EXTERNAL's mangled name is the local", () => {
    const out = cpp(`FUNCTION_BLOCK FB_T
VAR_OUTPUT n : INT; END_VAR
METHOD Bump : INT
n := n + 1;
Bump := n;
END_METHOD
END_FUNCTION_BLOCK
VAR_GLOBAL gT : FB_T; END_VAR
FUNCTION_BLOCK FB_A
VAR_EXTERNAL gT : FB_T; END_VAR
METHOD M1 : INT
VAR gT : FB_T; END_VAR
M1 := gT.Bump();
END_METHOD
METHOD M2 : INT
VAR gT : FB_T; END_VAR
M2 := gT.n;
END_METHOD
END_FUNCTION_BLOCK
`);
    expect(out).toContain("M1_result = GT.BUMP();");
    expect(out).toContain("M2_result = GT.N;");
    expect(out).not.toContain("GT_");
  });

  it("a call statement NAME(); inside a class with a method NAME calls the method", () => {
    const out = cpp(`FUNCTION_BLOCK FB_Pump
VAR_OUTPUT runs : INT; END_VAR
runs := runs + 1;
END_FUNCTION_BLOCK
VAR_GLOBAL Pump : FB_Pump; END_VAR
FUNCTION_BLOCK FB_S
VAR_OUTPUT v, seen : INT; END_VAR
METHOD Pump : INT
Pump := 10;
END_METHOD
Pump();
v := Pump();
seen := Pump.runs;
END_FUNCTION_BLOCK
`);
    expect(out).toMatch(/^\s*PUMP\(\);$/m);
    expect(out).not.toContain("::strucpp::PUMP();");
    expect(out).toContain("V = PUMP();");
    expect(out).toContain("SEEN = ::strucpp::PUMP.RUNS;");
  });

  it("a dotted call on a global of a runtime name reaches its mangled name", () => {
    const out = cpp(`FUNCTION_BLOCK FB_T
VAR_OUTPUT n : INT; END_VAR
METHOD Bump : INT
n := n + 1;
Bump := n;
END_METHOD
END_FUNCTION_BLOCK
VAR_GLOBAL GT : FB_T; CODE : FB_T; END_VAR
FUNCTION_BLOCK FB_A
VAR_OUTPUT r : INT; END_VAR
VAR_EXTERNAL GT : FB_T; END_VAR
r := GT.Bump();
END_FUNCTION_BLOCK
FUNCTION F_Code : INT
VAR_EXTERNAL CODE : FB_T; END_VAR
F_Code := CODE.Bump();
END_FUNCTION
PROGRAM Main
VAR y : INT; END_VAR
y := GT.Bump() + CODE.Bump();
END_PROGRAM
`);
    expect(out).toContain("R = GT_.BUMP();");
    expect(out).toContain("F_CODE_result = CODE_.BUMP();");
    expect(out).toContain("Y = strucpp::iec_add<DINT_t>({GT_.BUMP(), CODE_.BUMP()});");
  });
});
