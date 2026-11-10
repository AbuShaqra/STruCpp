/**
 * Named arguments of a FUNCTION call, user or library, must name a parameter
 * of the function: the C++ binds them by name and dropped any other one, so
 * the call ran with the default. `PRG.X()` written inside PRG must name a
 * method or action of PRG, or the C++ names a member that does not exist.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { compile } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";

const FUNCS = `FUNCTION F_ADD : INT
VAR_INPUT a : INT; b : INT := 5; END_VAR
VAR_OUTPUT o : INT; END_VAR
VAR_IN_OUT io : INT; END_VAR
VAR t : INT; END_VAR
F_ADD := a + b; o := a; io := io + 1;
END_FUNCTION
`;

function errors(
  body: string,
  options: Parameters<typeof compile>[1] = {},
  decls = FUNCS,
): string[] {
  const src = `${decls}PROGRAM Main
VAR x : INT; y : INT; s : STRING; END_VAR
${body}
END_PROGRAM
`;
  return compile(src, options).errors.map((e) => e.message);
}

describe("function call named arguments", () => {
  const modes: Array<[string, Parameters<typeof compile>[1]]> = [
    ["no dialect", {}],
    ["iec-3", { dialect: "iec-3" }],
    ["strict", { strict: true }],
  ];
  for (const [label, options] of modes) {
    it(`refuses an unknown name on a user function (${label})`, () => {
      expect(
        errors("x := F_ADD(a := 1, io := y, nope := 2);", options),
      ).toEqual(["Function 'F_ADD' has no parameter named 'NOPE'"]);
    });
  }

  it("refuses a local variable of the function named as an argument", () => {
    expect(errors("x := F_ADD(a := 1, io := y, t := 2);")).toEqual([
      "Function 'F_ADD' has no parameter named 'T'",
    ]);
  });

  it("refuses an unknown name on a statement call", () => {
    expect(errors("F_ADD(a := 1, io := y, zz := 2, o => x);")).toEqual([
      "Function 'F_ADD' has no parameter named 'ZZ'",
    ]);
  });

  it("refuses an unknown output name", () => {
    expect(errors("x := F_ADD(a := 1, io := y, q => x);")).toEqual([
      "Function 'F_ADD' has no parameter named 'Q'",
    ]);
  });

  it("accepts inputs, in/outs, outputs and EN/ENO", () => {
    expect(
      errors("x := F_ADD(EN := TRUE, b := 2, io := y, o => x, a := 1);"),
    ).toEqual([]);
  });

  it("leaves standard functions to their own binding", () => {
    expect(errors("x := LIMIT(MN := 0, IN := 5, MX := 10);")).toEqual([]);
  });

  it("does not check an FB instance call here", () => {
    expect(
      errors(
        "f(i := 1);",
        {},
        `FUNCTION_BLOCK FB
VAR_INPUT i : INT; END_VAR
END_FUNCTION_BLOCK
PROGRAM P2
VAR f : FB; END_VAR
f(i := 1);
END_PROGRAM
`,
      ).filter((m) => m.includes("parameter named")),
    ).toEqual([]);
  });
});

const LIBS_DIR = path.resolve(__dirname, "../../libs");
const oscatAvailable = fs.existsSync(path.join(LIBS_DIR, "oscat-basic.stlib"));

describe.skipIf(!oscatAvailable)("library function named arguments", () => {
  const libraries = oscatAvailable ? discoverStlibs(LIBS_DIR) : [];

  it("refuses an unknown name", () => {
    expect(
      errors("s := LIST_GET(SEP := 44, LIST := s, NOPE := 2);", {
        libraries,
      }),
    ).toEqual(["Function 'LIST_GET' has no parameter named 'NOPE'"]);
  });

  it("accepts the declared names", () => {
    expect(
      errors("s := LIST_GET(SEP := 44, LIST := s, POS := 2);", { libraries }),
    ).toEqual([]);
  });
});

describe("a program's own method called by the program's name", () => {
  const PRG = (body: string): string => `PROGRAM PRG_A
VAR x : INT; END_VAR
METHOD M : INT
VAR_INPUT p : INT; END_VAR
M := p;
END_METHOD
ACTION Act:
x := 1;
END_ACTION
${body}
END_PROGRAM
`;
  const ext = { features: ["+program_methods"] };

  it("refuses a name that is no method or action", () => {
    expect(
      compile(PRG("x := PRG_A.nope();"), ext).errors.map((e) => e.message),
    ).toEqual(["PROGRAM PRG_A has no method or action 'NOPE'"]);
  });

  it("refuses it in a method of the program", () => {
    const src = `PROGRAM PRG_A
VAR x : INT; END_VAR
METHOD M : INT
M := PRG_A.Gone();
END_METHOD
END_PROGRAM
`;
    expect(compile(src, ext).errors.map((e) => e.message)).toEqual([
      "PROGRAM PRG_A has no method or action 'GONE'",
    ]);
  });

  for (const [label, options] of [
    ["no dialect", {}],
    ["iec-3", { dialect: "iec-3" }],
  ] as const) {
    it(`refuses it without program_methods (${label})`, () => {
      const src = `PROGRAM PRG_A
VAR x : INT; END_VAR
PRG_A.nope();
END_PROGRAM
`;
      expect(compile(src, options).errors.map((e) => e.message)).toEqual([
        "PROGRAM PRG_A has no method or action 'NOPE'",
      ]);
    });
  }

  it("refuses a member FB called by the program's name without program_methods", () => {
    const src = `FUNCTION_BLOCK FB
VAR_INPUT i : INT; END_VAR
END_FUNCTION_BLOCK
PROGRAM PRG_A
VAR f : FB; END_VAR
PRG_A.f(i := 1);
END_PROGRAM
`;
    expect(compile(src).errors.map((e) => e.message)).toEqual([
      "Cannot access members of program 'PRG_A' directly — declare a variable of type 'PRG_A' first.",
    ]);
  });

  it("accepts its methods, actions and members", () => {
    expect(
      compile(PRG("x := PRG_A.M(p := 1); PRG_A.Act();"), ext).errors,
    ).toEqual([]);
    const src = `FUNCTION_BLOCK FB
VAR_INPUT i : INT; END_VAR
END_FUNCTION_BLOCK
PROGRAM PRG_A
VAR f : FB; END_VAR
PRG_A.f(i := 1);
END_PROGRAM
`;
    expect(compile(src, ext).errors).toEqual([]);
  });

  it("accepts an action by the program's name without program_methods", () => {
    const src = `PROGRAM PRG_A
VAR x : INT; END_VAR
PRG_A.Act();
ACTION Act:
x := 2;
END_ACTION
END_PROGRAM
`;
    expect(compile(src).errors).toEqual([]);
  });

  it("leaves a local named like the program alone", () => {
    const src = `FUNCTION_BLOCK FB
VAR_INPUT i : INT; END_VAR
END_FUNCTION_BLOCK
PROGRAM PRG_A
VAR PRG_A : FB; END_VAR
PRG_A(i := 1);
END_PROGRAM
`;
    expect(
      compile(src).errors.filter((e) => e.message.includes("method or action")),
    ).toEqual([]);
  });
});
