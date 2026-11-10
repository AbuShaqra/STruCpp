/**
 * Named arguments of a standard function call bind by the IEC parameter
 * names (MID(IN, L, P), LIMIT(MN, IN, MX), SEL(G, IN0, IN1)...), not by the
 * order they are written in, and a name the function does not declare is
 * refused.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { compile } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";
import { bindStdFunctionArguments } from "../../src/semantic/std-function-args.js";
import { StdFunctionRegistry } from "../../src/semantic/std-function-registry.js";
import type { Argument, Expression } from "../../src/frontend/ast.js";

const SPAN = { startLine: 1, startCol: 1, endLine: 1, endCol: 1 };

function arg(
  name: string | undefined,
  value: string,
  isOutput = false,
): Argument {
  const expr = {
    kind: "VariableExpression",
    name: value,
    sourceSpan: SPAN,
  } as unknown as Expression;
  return {
    kind: "Argument",
    ...(name !== undefined ? { name } : {}),
    isOutput,
    value: expr,
    sourceSpan: SPAN,
  };
}

const registry = new StdFunctionRegistry();
function bind(fn: string, args: Argument[]) {
  const desc = registry.lookup(fn)!;
  return bindStdFunctionArguments(
    desc.name,
    desc.params,
    desc.isVariadic,
    args,
  );
}
const values = (args: Argument[] | undefined): string[] =>
  (args ?? []).map((a) => (a.value as unknown as { name: string }).name);

describe("bindStdFunctionArguments", () => {
  it("leaves a call without named arguments as written", () => {
    const r = bind("MID", [
      arg(undefined, "s"),
      arg(undefined, "l"),
      arg(undefined, "p"),
    ]);
    expect(r.ordered).toBeUndefined();
    expect(r.issues).toEqual([]);
    expect(r.failed).toBe(false);
  });

  it("orders MID, LIMIT and SEL by their IEC names", () => {
    expect(
      values(
        bind("MID", [arg("IN", "s"), arg("P", "p"), arg("L", "l")]).ordered,
      ),
    ).toEqual(["s", "l", "p"]);
    expect(
      values(
        bind("LIMIT", [arg("IN", "x"), arg("MX", "hi"), arg("MN", "lo")])
          .ordered,
      ),
    ).toEqual(["lo", "x", "hi"]);
    expect(
      values(
        bind("SEL", [arg("IN1", "b"), arg("G", "g"), arg("IN0", "a")]).ordered,
      ),
    ).toEqual(["g", "a", "b"]);
  });

  it("fills free slots with positional arguments", () => {
    expect(
      values(
        bind("LIMIT", [arg(undefined, "lo"), arg("MX", "hi"), arg("IN", "x")])
          .ordered,
      ),
    ).toEqual(["lo", "x", "hi"]);
  });

  it("binds extensible inputs past the declared ones", () => {
    expect(
      values(
        bind("ADD", [arg("IN3", "c"), arg("IN1", "a"), arg("IN2", "b")])
          .ordered,
      ),
    ).toEqual(["a", "b", "c"]);
    expect(
      values(
        bind("MUX", [
          arg("IN2", "c"),
          arg("K", "k"),
          arg("IN0", "a"),
          arg("IN1", "b"),
        ]).ordered,
      ),
    ).toEqual(["k", "a", "b", "c"]);
  });

  it("closes up a left-out extensible input, except on MUX", () => {
    const add = bind("ADD", [arg("IN3", "c"), arg("IN1", "a")]);
    expect(values(add.ordered)).toEqual(["a", "c"]);
    expect(add.failed).toBe(false);
    const mux = bind("MUX", [arg("K", "k"), arg("IN0", "a"), arg("IN2", "c")]);
    expect(mux.ordered).toBeUndefined();
    expect(mux.failed).toBe(true);
    expect(mux.issues.map((i) => i.message)).toEqual([
      "Function 'MUX' is missing parameter 'IN1'",
    ]);
  });

  it("keeps EN and ENO, after the inputs", () => {
    const r = bind("LIMIT", [
      arg("EN", "en"),
      arg("MX", "hi"),
      arg("ENO", "eno", true),
      arg("IN", "x"),
      arg("MN", "lo"),
    ]);
    expect(values(r.ordered)).toEqual(["lo", "x", "hi", "en", "eno"]);
  });

  it("refuses unknown, repeated and missing names", () => {
    expect(
      bind("MID", [arg("IN", "s"), arg("L", "l"), arg("X", "p")]).issues.map(
        (i) => i.message,
      ),
    ).toEqual(["Function 'MID' has no parameter named 'X'"]);
    expect(
      bind("LIMIT", [
        arg("IN", "a"),
        arg("IN", "b"),
        arg("MX", "c"),
      ]).issues.map((i) => i.message),
    ).toEqual([
      "Parameter 'IN' of 'LIMIT' is given more than once",
      "Function 'LIMIT' is missing parameter 'MN'",
    ]);
    expect(
      bind("MID", [arg("IN", "s"), arg("P", "p")]).issues.map((i) => i.message),
    ).toEqual(["Function 'MID' is missing parameter 'L'"]);
    expect(bind("ADD", [arg("IN1", "a"), arg("IN02", "b")]).failed).toBe(true);
    expect(bind("ADD", [arg("IN1", "a"), arg("X3", "b")]).failed).toBe(true);
  });

  it("warns on '=>' to an input and still binds it", () => {
    const r = bind("MID", [arg("IN", "s"), arg("L", "l", true), arg("P", "p")]);
    expect(values(r.ordered)).toEqual(["s", "l", "p"]);
    expect(r.issues).toEqual([
      expect.objectContaining({
        severity: "warning",
        message:
          "Output argument '=>' used for input parameter 'l' — did you mean ':='?",
      }),
    ]);
  });
});

const LIBS_DIR = path.resolve(__dirname, "../../libs");
const libsAvailable = fs.existsSync(
  path.join(LIBS_DIR, "iec-std-functions.stlib"),
);

function errors(
  body: string,
  options: Parameters<typeof compile>[1] = {},
  decls = "",
): string[] {
  const src = `${decls}PROGRAM Main
VAR s : STRING := 'ABCDEFG'; i : INT; w : WSTRING; x : REAL; b : BOOL; END_VAR
${body}
END_PROGRAM
`;
  return compile(src, options).errors.map((e) => e.message);
}

function cpp(
  body: string,
  options: Parameters<typeof compile>[1] = {},
  decls = "",
): string {
  const src = `${decls}PROGRAM Main
VAR s : STRING := 'ABCDEFG'; i : INT; w : WSTRING; x : REAL; b : BOOL; eo : BOOL; END_VAR
${body}
END_PROGRAM
`;
  const r = compile(src, options);
  expect(r.errors).toEqual([]);
  return r.cppCode;
}

const VENDOR_FEATURES = [
  "+pointer_to",
  "+reference_to",
  "+ref_assign",
  "+program_methods",
  "+self_caret",
  "+property",
  "+postfix_enum_base",
  "+named_global_lists",
  "+struct_extends",
  "+union",
  "+fb_init",
  "+trunc_dint",
  "+interface_zero",
];

const MODES: Array<[string, Parameters<typeof compile>[1]]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
  [
    "strict, vendor features",
    { strict: true, dialect: "iec-3", features: VENDOR_FEATURES },
  ],
  ...(libsAvailable
    ? ([
        ["with the bundled libraries", { libraries: discoverStlibs(LIBS_DIR) }],
      ] as Array<[string, Parameters<typeof compile>[1]]>)
    : []),
];

describe("standard function named arguments", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      it("emits the IEC parameter order", () => {
        const code = cpp(
          `s := MID(IN := s, P := 2, L := 3);
i := LIMIT(IN := 50, MN := 0, MX := 10);
i := SEL(IN1 := 7, G := TRUE, IN0 := 3);
s := INSERT(P := 2, IN2 := 'xy', IN1 := s);
s := DELETE(P := 2, L := 3, IN := s);
s := REPLACE(P := 2, L := 3, IN2 := 'z', IN1 := s);
i := MUX(IN2 := 30, K := 2, IN0 := 10, IN1 := 20);
x := INT_TO_REAL(IN := 7);`,
          options,
        );
        expect(code).toContain("S = MID(S, 3, 2);");
        expect(code).toContain("I = LIMIT(0, 50, 10);");
        expect(code).toContain("I = SEL(true, 3, 7);");
        expect(code).toContain('S = INSERT(S, "xy", 2);');
        expect(code).toContain("S = DELETE_STR(S, 3, 2);");
        expect(code).toContain('S = REPLACE(S, "z", 3, 2);');
        expect(code).toContain("I = MUX(2, 10, 20, 30);");
        expect(code).toContain("X = TO_REAL(7);");
      });

      it("refuses a name the function does not declare", () => {
        expect(errors("s := MID(IN := s, L := 3, X := 2);", options)).toEqual([
          "Function 'MID' has no parameter named 'X'",
        ]);
        expect(errors("x := INT_TO_REAL(V := 7);", options)).toEqual([
          "Function 'INT_TO_REAL' has no parameter named 'V'",
        ]);
      });

      it("refuses a repeated or missing input", () => {
        expect(
          errors("i := LIMIT(MN := 0, IN := 1, IN := 2);", options),
        ).toEqual(["Parameter 'IN' of 'LIMIT' is given more than once"]);
        expect(errors("s := INSERT(P := 2, IN1 := s);", options)).toEqual([
          "Function 'INSERT' is missing parameter 'IN2'",
        ]);
        expect(
          errors("i := MUX(K := 0, IN0 := 1, IN2 := 3);", options),
        ).toEqual(["Function 'MUX' is missing parameter 'IN1'"]);
      });

      it("type-checks each argument against its own parameter", () => {
        expect(errors("s := MID(L := 3, IN := s, P := 2);", options)).toEqual(
          [],
        );
        // With libraries loaded the argument constraints are not checked yet.
        if (options?.libraries) return;
        expect(errors("s := MID(L := s, IN := s, P := 2);", options)).toEqual([
          "Argument 'L' of 'MID' expects INT, got STRING",
        ]);
      });
    });
  }

  it("leaves a user FUNCTION named like a standard function alone", () => {
    const decls = `FUNCTION LIMIT : INT
VAR_INPUT a, b, c : INT; END_VAR
LIMIT := a * 100 + b * 10 + c;
END_FUNCTION
`;
    expect(cpp("i := LIMIT(c := 1, a := 2, b := 3);", {}, decls)).toContain(
      "I = LIMIT_(2, 3, 1);",
    );
  });

  it("binds named arguments in a variable initializer", () => {
    const r = compile(`PROGRAM Main
VAR r : STRING := MID(P := 2, L := 3, IN := 'XYZWV'); END_VAR
END_PROGRAM
`);
    expect(r.errors).toEqual([]);
    expect(r.cppCode).toContain('R(MID("XYZWV", 3, 2))');
  });

  it("keeps EN and ENO working with named inputs", () => {
    const code = cpp(
      "i := LIMIT(EN := b, MX := 10, IN := 50, MN := 0, ENO => eo);",
    );
    expect(code).toContain("I = LIMIT(0, 50, 10);");
  });
});
