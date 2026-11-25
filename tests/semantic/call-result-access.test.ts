/**
 * Member access and subscripts on a call result (feature call_result_access):
 * off in the default set and under iec-3, refused at the selector; with the
 * feature on, type-checked like a variable's access path. A call result is a
 * temporary, so writing to or binding a reference to one is refused in every
 * mode.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import type { CompileOptions } from "../../src/index.js";

type Options = Partial<CompileOptions>;

const TYPES = `TYPE ST_I : STRUCT v : DINT; END_STRUCT END_TYPE
TYPE ST_R : STRUCT nCode : INT; inner : ST_I; END_STRUCT END_TYPE
TYPE A3 : ARRAY[1..3] OF ST_I; END_TYPE
TYPE E_C : (C_A, C_B) END_TYPE
VAR_GLOBAL gr : ST_R; END_VAR
FUNCTION F : ST_R
VAR_INPUT a : INT; END_VAR
F.nCode := a;
END_FUNCTION
FUNCTION FA : A3
FA[2].v := 7;
END_FUNCTION
FUNCTION FS : STRING
FS := 'abc';
END_FUNCTION
FUNCTION FW : WORD
FW := 16#00F0;
END_FUNCTION
FUNCTION FE : E_C
FE := C_B;
END_FUNCTION
FUNCTION FR : REFERENCE TO ST_R
FR REF= gr;
END_FUNCTION
FUNCTION_BLOCK FB_B
VAR hidden : INT; END_VAR
VAR_OUTPUT q : INT; END_VAR
METHOD GetR : ST_R
VAR_INPUT a : INT; END_VAR
GetR.nCode := a;
END_METHOD
METHOD Self : FB_B
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_IO
VAR_IN_OUT io : INT; END_VAR
VAR_INPUT ri : REFERENCE TO INT; END_VAR
END_FUNCTION_BLOCK
`;

/** `TYPES` and a PROGRAM whose body is `body`, which starts on line `BODY_LINE`. */
function program(body: string): string {
  return `${TYPES}PROGRAM Main
VAR x : INT; y : DINT; z : BOOL; b : FB_B; o : FB_IO; r : REFERENCE TO INT; p : REF_TO INT; END_VAR
${body}
END_PROGRAM
`;
}

const BODY_LINE = TYPES.split("\n").length + 2;

const ON: Options = { features: ["+call_result_access"] };

/** iec-3 with the reference features the shared declarations use. */
const IEC3: Options = {
  dialect: "iec-3",
  features: ["+reference_to", "+ref_assign"],
};

function messages(body: string, options: Options = ON): string[] {
  return compile(program(body), options).errors.map((e) => e.message);
}

describe("the feature call_result_access", () => {
  const READS = [
    "x := F(1).nCode;",
    "y := F(3).inner.v;",
    "y := FA()[2].v;",
    "x := b.GetR(5).nCode;",
    "x := b.Self().GetR(2).nCode;",
    "z := F(1).nCode.1;",
    "z := FW().4;",
    "x := b.Self().q;",
  ];

  it.each(READS)("`%s` compiles with the feature on", (stmt) => {
    const result = compile(program(stmt), ON);
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
  });

  it.each(READS)(
    "`%s` compiles under iec-3 with +call_result_access",
    (stmt) => {
      const result = compile(program(stmt), {
        dialect: "iec-3",
        features: [...IEC3.features!, "+call_result_access"],
      });
      expect(result.errors).toEqual([]);
    },
  );

  it("is refused in the default set at the `.`", () => {
    const result = compile(program("x := F(1).nCode;"));
    expect(result.success).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({
        message:
          "Member access on a call result needs the feature call_result_access; assign the result to a variable first",
        line: BODY_LINE,
        column: 10,
      }),
    ]);
  });

  it("is refused under iec-3 at the `[`", () => {
    const result = compile(program("y := FA()[2].v;"), IEC3);
    expect(result.errors).toEqual([
      expect.objectContaining({
        message:
          "An array index on a call result needs the feature call_result_access; assign the result to a variable first",
        line: BODY_LINE,
        column: 10,
      }),
    ]);
  });

  it("refuses a method's result as well, once per access", () => {
    expect(messages("x := b.GetR(5).nCode + b.GetR(6).nCode;", {})).toEqual([
      "Member access on a call result needs the feature call_result_access; assign the result to a variable first",
      "Member access on a call result needs the feature call_result_access; assign the result to a variable first",
    ]);
  });

  it("leaves a method chain on a call result alone in every mode", () => {
    for (const options of [{}, IEC3]) {
      expect(messages("b := b.Self().Self();", options)).toEqual([]);
    }
  });
});

describe("type checking an access on a call result", () => {
  it("reports a member the STRUCT does not have", () => {
    expect(messages("x := F(1).nope;")).toEqual([
      "STRUCT 'ST_R' has no member 'nope'",
    ]);
  });

  it("reports a member of an elementary result", () => {
    expect(messages("x := F(1).nCode.foo;")).toEqual([
      "A value of type 'INT' has no member 'foo'",
    ]);
  });

  it("refuses an internal variable of a function block result", () => {
    expect(messages("x := b.Self().hidden;")).toEqual([
      "'hidden' is an internal variable of FUNCTION_BLOCK 'FB_B' and cannot be accessed from outside",
    ]);
  });

  it("refuses an index on a result that is not an ARRAY", () => {
    expect(messages("x := F(1)[1].nCode;")).toEqual([
      "An array index on a call result needs an ARRAY, not ST_R; assign the result to a variable first",
    ]);
    expect(messages("x := FS()[1];")).toEqual([
      "An array index on a call result needs an ARRAY, not STRING; assign the result to a variable first",
    ]);
  });

  it("refuses a member of an enumeration result", () => {
    expect(messages("x := FE().C_A;")).toEqual([
      "Member access on a call result needs a STRUCT or FUNCTION_BLOCK, not E_C; assign the result to a variable first",
    ]);
  });

  it("refuses a bit of a STRUCT result", () => {
    expect(messages("z := F(1).1;")).toEqual([
      "A bit access on a call result needs a bit string, not ST_R; assign the result to a variable first",
    ]);
  });

  it("refuses a member of a REFERENCE TO result", () => {
    expect(messages("x := FR().nCode;")).toEqual([
      "Member access on a call result needs a STRUCT or FUNCTION_BLOCK, not a REFERENCE TO or POINTER TO; assign the result to a variable first",
    ]);
  });

  it("types the access: a STRUCT member into an INT is refused", () => {
    expect(messages("x := F(1).inner;")).toEqual(["Cannot assign ST_I to INT"]);
  });
});

describe("a call result is never written", () => {
  const WRITTEN =
    "A call result cannot be written: it is a temporary value; assign the result to a variable first";
  const BOUND =
    "A call result cannot be bound to a reference: it is a temporary value; assign the result to a variable first";

  it.each([
    ["`:=` target", "F(1).nCode := 3;", [WRITTEN]],
    ["`:=` target, indexed", "FA()[2].v := 3;", [WRITTEN]],
    ["`:=` target of a method", "b.GetR(1).nCode := 3;", [WRITTEN]],
    ["`=>` output", "b(q => F(1).nCode);", [WRITTEN]],
    ["`REF=` target", "F(1).nCode REF= x;", [WRITTEN]],
    ["`REF=` source", "r REF= F(1).nCode;", [BOUND]],
    ["REF()", "p := REF(F(1).nCode);", [BOUND]],
    [
      "VAR_IN_OUT argument",
      "o(io := F(1).nCode, ri := x);",
      ["VAR_IN_OUT 'io' must be bound to a variable, not an expression"],
    ],
    [
      "REFERENCE TO input",
      "o(io := x, ri := F(1).nCode);",
      [
        "REFERENCE TO input 'ri' needs a variable to refer to, not an expression",
      ],
    ],
    [
      "ADR",
      "y := TO_DINT(ADR(F(1).nCode));",
      ["ADR() requires a variable reference, not an expression"],
    ],
  ])("%s is refused with the feature on", (_name, stmt, expected) => {
    const found = messages(stmt);
    for (const message of expected) expect(found).toContain(message);
  });

  it("is refused with the feature off too, beside the feature refusal", () => {
    const found = messages("F(1).nCode := 3;", {});
    expect(found).toContain(WRITTEN);
    expect(found).toContain(
      "Member access on a call result needs the feature call_result_access; assign the result to a variable first",
    );
  });
});

describe("a method call on a call result", () => {
  const SRC = `TYPE ST_S : STRUCT a : INT; END_STRUCT END_TYPE
TYPE ST_H : STRUCT w : FB_W; END_STRUCT END_TYPE
FUNCTION_BLOCK FB_W
VAR_OUTPUT q : INT; END_VAR
METHOD Run : INT
VAR_INPUT n : INT; END_VAR
Run := n;
END_METHOD
METHOD Me : FB_W
END_METHOD
END_FUNCTION_BLOCK
VAR_GLOBAL gw : FB_W; END_VAR
FUNCTION FW : FB_W
END_FUNCTION
FUNCTION FS : ST_S
END_FUNCTION
FUNCTION FH : ST_H
END_FUNCTION
FUNCTION FI : INT
END_FUNCTION
FUNCTION RF : REFERENCE TO FB_W
RF REF= gw;
END_FUNCTION
FUNCTION PF : POINTER TO FB_W
PF := ADR(gw);
END_FUNCTION
PROGRAM Main
VAR x : INT; f : FB_W; END_VAR
`;
  const errors = (body: string): string[] =>
    compile(`${SRC}${body}\nEND_PROGRAM\n`).errors.map((e) => e.message);

  it("compiles on a function block result, with no feature", () => {
    expect(errors("x := FW().Run(1) + f.Me().Run(n := 2);")).toEqual([]);
  });

  it.each([
    [
      "a REFERENCE TO result",
      "x := RF().Run(1);",
      "Cannot call method 'Run' on 'RF()': its result is a REFERENCE TO or POINTER TO; assign the result to a variable first",
    ],
    [
      "a POINTER TO result",
      "x := PF().Run(1);",
      "Cannot call method 'Run' on 'PF()': its result is a REFERENCE TO or POINTER TO; assign the result to a variable first",
    ],
    [
      "a STRUCT result",
      "x := FS().Run(1);",
      "Cannot call method 'Run' on 'FS()': it is not a function block instance",
    ],
    [
      "an INT result",
      "x := FI().Run(1);",
      "Cannot call method 'Run' on 'FI()': it is not a function block instance",
    ],
    [
      "a method the block does not have",
      "x := FW().Nope();",
      "Function block 'FB_W' has no method 'NOPE'",
    ],
    [
      "a parameter the method does not have",
      "x := FW().Run(n := 1, b := 2);",
      "Method 'Run' of 'FB_W' has no parameter named 'B'",
    ],
    [
      "too many arguments",
      "x := FW().Run(1, 2);",
      "Method 'Run' of 'FB_W' takes 1 argument, got 2",
    ],
    [
      "a method's function block result",
      "x := f.Me().Nope();",
      "Function block 'FB_W' has no method 'NOPE'",
    ],
    [
      "a chained method's result",
      "x := f.Me().Me().Run(1, 2);",
      "Method 'Run' of 'FB_W' takes 1 argument, got 2",
    ],
  ])("refuses %s", (_name, body, message) => {
    expect(errors(body)).toEqual([message]);
  });

  it("refuses invoking a function block member of a call result", () => {
    expect(
      compile(`${SRC}x := FH().w(1);\nEND_PROGRAM\n`, ON).errors.map(
        (e) => e.message,
      ),
    ).toContain(
      "'FH().W' is a member of a call result, not a method; assign the result to a variable first",
    );
  });
});

describe("the declared result of the method actually called", () => {
  it("a REFERENCE TO result of another block's method of the same name does not refuse", () => {
    const src = `TYPE ST_R : STRUCT nCode : INT; END_STRUCT END_TYPE
VAR_GLOBAL gi : INT; END_VAR
FUNCTION_BLOCK FB_A
METHOD Get : REFERENCE TO INT
Get REF= gi;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_B
METHOD Get : ST_R
Get.nCode := 7;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main
VAR a : FB_A; b : FB_B; x : INT; END_VAR
x := b.Get().nCode;
x := a.Get().nCode;
END_PROGRAM
`;
    expect(compile(src, ON).errors.map((e) => e.message)).toEqual([
      "Member access on a call result needs a STRUCT or FUNCTION_BLOCK, not a REFERENCE TO or POINTER TO; assign the result to a variable first",
    ]);
  });
});

describe("with the feature off, one error per access", () => {
  it.each([
    "x := F(1).nope;",
    "x := FS()[1];",
    "x := FR().nCode;",
    "x := F(1).inner;",
  ])("`%s` gets only the feature refusal", (stmt) => {
    expect(messages(stmt, {})).toEqual([
      expect.stringContaining("needs the feature call_result_access"),
    ]);
  });
});
