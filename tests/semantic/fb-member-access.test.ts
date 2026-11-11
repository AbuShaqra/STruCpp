/**
 * From outside a function block only its interface is reachable: a VAR_INPUT
 * is written (not read), a VAR_OUTPUT read (not written), a VAR_IN_OUT bound
 * in the call. VAR and VAR_TEMP are internal; a VAR section's access
 * specifier (Ed. 3 6.6.5.10) opens it (PUBLIC) or closes it to derived blocks
 * (PRIVATE). Inside the block and its derived blocks everything else stays
 * reachable. Test files follow the same rule.
 */
import { describe, it, expect } from "vitest";
import { compile, compileStlib } from "../../src/index.js";
import { parseTestFile } from "../../src/testing/test-parser.js";
import { analyzeTestFile } from "../../src/semantic/analyzer.js";
import { uppercaseSource } from "../../src/frontend/lexer.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];

const TYPES = `VAR_GLOBAL g : INT; END_VAR
FUNCTION_BLOCK FB_A
VAR_INPUT i : INT; END_VAR
VAR_OUTPUT o : INT; END_VAR
VAR_IN_OUT io : INT; END_VAR
VAR v : INT; END_VAR
VAR_TEMP t : INT; END_VAR
VAR_EXTERNAL g : INT; END_VAR
VAR PUBLIC pub : INT; END_VAR
VAR PRIVATE priv : INT; END_VAR
VAR PROTECTED prot : INT; END_VAR
VAR INTERNAL intl : INT; END_VAR
METHOD Own : INT
VAR other : FB_A; END_VAR
  Own := v + t + priv + THIS.priv + other.v + other.i + other.priv;
END_METHOD
  o := i + v;
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_D EXTENDS FB_A
METHOD M : INT
  M := v + THIS.v + SUPER.prot + intl + i;
END_METHOD
END_FUNCTION_BLOCK
`;

const errors = (body: string, options: Options, extra = ""): string[] =>
  compile(
    `${TYPES}${extra}PROGRAM Main
VAR f : FB_A; d : FB_D; x : INT; y : INT; END_VAR
${body}
END_PROGRAM
`,
    options,
  ).errors.map((e) => e.message);

const fb = "FUNCTION_BLOCK 'FB_A'";
const INTERNAL = (m: string): string =>
  `'${m}' is an internal variable of ${fb} and cannot be accessed from outside`;

describe("function block member access from outside", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      it("accepts writing an input, reading an output, a PUBLIC section and a call", () => {
        expect(
          errors(
            "f.i := 1; f(i := 2, io := x, o => y); y := f.o; f.pub := 3; x := d.pub; x := f.Own(); x := d.M();",
            options,
          ),
        ).toEqual([]);
      });

      it("refuses reading an input and writing an output", () => {
        expect(errors("x := f.i;", options)).toEqual([
          `'I' is a VAR_INPUT of ${fb}; from outside it can be written, not read`,
        ]);
        expect(errors("f.o := 1;", options)).toEqual([
          `'O' is a VAR_OUTPUT of ${fb}; from outside it can be read, not written`,
        ]);
      });

      it("refuses an in-out through the instance", () => {
        const msg = `'IO' is a VAR_IN_OUT of ${fb}; from outside it is bound in the call, not accessed through the instance`;
        expect(errors("x := f.io;", options)).toEqual([msg]);
        expect(errors("f.io := 1;", options)).toEqual([msg]);
      });

      it("refuses VAR, VAR_TEMP, PROTECTED, INTERNAL and PRIVATE sections", () => {
        expect(errors("x := f.v;", options)).toEqual([INTERNAL("V")]);
        expect(errors("f.v := 1;", options)).toEqual([INTERNAL("V")]);
        expect(errors("x := f.t;", options)).toEqual([INTERNAL("T")]);
        expect(errors("x := f.prot;", options)).toEqual([INTERNAL("PROT")]);
        expect(errors("x := f.intl;", options)).toEqual([INTERNAL("INTL")]);
        expect(errors("x := d.v;", options)).toEqual([INTERNAL("V")]);
        expect(errors("x := f.priv;", options)).toEqual([
          `'PRIV' is a PRIVATE variable of ${fb}; only 'FB_A' itself can access it`,
        ]);
      });

      it("refuses a VAR_EXTERNAL through the instance", () => {
        expect(errors("x := f.g;", options)).toEqual([
          `'G' is a VAR_EXTERNAL of ${fb}, not a member it exposes, and cannot be accessed from outside`,
        ]);
      });

      it("refuses an instance initializer that writes an internal variable", () => {
        expect(
          errors(
            "",
            options,
            "PROGRAM P2\nVAR h : FB_A := (v := 3, i := 1); END_VAR\nEND_PROGRAM\n",
          ),
        ).toEqual([INTERNAL("V")]);
      });

      it("refuses a derived block reaching a base's PRIVATE section", () => {
        const derived = (body: string): string =>
          `FUNCTION_BLOCK FB_E EXTENDS FB_A\nMETHOD M : INT\n  M := ${body};\nEND_METHOD\nEND_FUNCTION_BLOCK\n`;
        const msg = `'PRIV' is a PRIVATE variable of ${fb}; only 'FB_A' itself can access it`;
        expect(errors("", options, derived("priv"))).toEqual([msg]);
        expect(errors("", options, derived("THIS.priv"))).toEqual([msg]);
        expect(errors("", options, derived("SUPER.priv"))).toEqual([msg]);
      });

      it("refuses a chain through an internal FB instance, also from another block", () => {
        const outer = `FUNCTION_BLOCK FB_O
VAR inner : FB_A; END_VAR
VAR PUBLIC open : FB_A; END_VAR
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_U
VAR h : FB_O; r : INT; END_VAR
  r := h.open.o;
  r := h.inner.o;
END_FUNCTION_BLOCK
`;
        const msg =
          "'INNER' is an internal variable of FUNCTION_BLOCK 'FB_O' and cannot be accessed from outside";
        expect(
          errors(
            "",
            options,
            `${outer}PROGRAM P3\nVAR h : FB_O; x : INT; END_VAR\n  h.inner(i := 1);\n  x := h.inner.Own();\n  h.open(i := 1);\nEND_PROGRAM\n`,
          ),
        ).toEqual([msg, msg, msg]);
      });
    });
  }

  it("refuses a specifier outside a FUNCTION_BLOCK's VAR section, or two of them", () => {
    const msgs = (src: string): string[] =>
      compile(src).errors.map((e) => e.message);
    expect(
      msgs(
        "FUNCTION_BLOCK F1\nVAR_INPUT PUBLIC q : INT; END_VAR\nEND_FUNCTION_BLOCK\n",
      ),
    ).toEqual([
      "PUBLIC applies only to a VAR section of a FUNCTION_BLOCK, not to VAR_INPUT here",
    ]);
    expect(
      msgs("PROGRAM P\nVAR PRIVATE q : INT; END_VAR\nq := 1;\nEND_PROGRAM\n"),
    ).toEqual([
      "PRIVATE applies only to a VAR section of a FUNCTION_BLOCK, not to VAR here",
    ]);
    expect(
      msgs(
        "FUNCTION_BLOCK F1\nVAR PUBLIC PRIVATE q : INT; END_VAR\nEND_FUNCTION_BLOCK\n",
      ),
    ).toEqual([
      "A VAR section takes one access specifier, not PUBLIC and PRIVATE",
    ]);
  });

  it("keeps a variable named INTERNAL a variable", () => {
    expect(
      compile(
        "FUNCTION_BLOCK F1\nVAR internal : INT; END_VAR\ninternal := 1;\nEND_FUNCTION_BLOCK\n",
      ).errors,
    ).toEqual([]);
  });

  it("carries PUBLIC and PRIVATE in a library manifest", () => {
    const lib = compileStlib(
      [
        {
          source: `FUNCTION_BLOCK FB_L
VAR PUBLIC pub : INT; END_VAR
VAR PRIVATE priv : INT; END_VAR
VAR plain : INT; END_VAR
END_FUNCTION_BLOCK
`,
          fileName: "l.st",
        },
      ],
      { name: "acc-lib", version: "1.0.0", namespace: "strucpp" },
    );
    expect(lib.success).toBe(true);
    const locals = lib.archive!.manifest.functionBlocks[0]!.locals!;
    expect(locals.map((l) => [l.name, l.access])).toEqual([
      ["PUB", "PUBLIC"],
      ["PRIV", "PRIVATE"],
      ["PLAIN", undefined],
    ]);
    const use = (body: string, extra = ""): string[] =>
      compile(
        `${extra}PROGRAM Main\nVAR l : FB_L; x : INT; END_VAR\n${body}\nEND_PROGRAM\n`,
        { libraries: [lib.archive!] },
      ).errors.map((e) => e.message);
    expect(use("x := l.pub; l.pub := 1;")).toEqual([]);
    expect(use("x := l.plain;")).toEqual([
      "'PLAIN' is an internal variable of FUNCTION_BLOCK 'FB_L' and cannot be accessed from outside",
    ]);
    expect(
      use(
        "x := 1;",
        "FUNCTION_BLOCK FB_K EXTENDS FB_L\nMETHOD M : INT\n  M := plain + THIS.priv;\nEND_METHOD\nEND_FUNCTION_BLOCK\n",
      ),
    ).toEqual([
      "'PRIV' is a PRIVATE variable of FUNCTION_BLOCK 'FB_L'; only 'FB_L' itself can access it",
    ]);
  });

  it("lets a test reach the instance it MOCKs, and no further", () => {
    const source = compile(
      `FUNCTION_BLOCK FB_S
VAR_OUTPUT value : INT; END_VAR
VAR raw : INT; END_VAR
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_C
VAR sensor : FB_S; other : FB_S; END_VAR
  sensor();
END_FUNCTION_BLOCK
`,
      { headerFileName: "generated.hpp" },
    );
    expect(source.success).toBe(true);
    const parsed = parseTestFile(
      uppercaseSource(`TEST 'mock'
VAR ctrl : FB_C; END_VAR
  MOCK ctrl.sensor;
  ctrl();
  ASSERT_EQ(ctrl.sensor.value, 0);
  ASSERT_EQ(ctrl.sensor.raw, 0);
  ASSERT_EQ(ctrl.other.value, 0);
END_TEST
`),
      "test.st",
    );
    expect(parsed.errors).toEqual([]);
    const result = analyzeTestFile(parsed.testFile!, source.symbolTables!);
    expect(result.errors.map((e) => e.message)).toEqual([
      "'RAW' is an internal variable of FUNCTION_BLOCK 'FB_S' and cannot be accessed from outside",
      "'OTHER' is an internal variable of FUNCTION_BLOCK 'FB_C' and cannot be accessed from outside",
    ]);
  });

  it("applies the rule to a test file", () => {
    const source = compile(
      `FUNCTION_BLOCK FB_T
VAR_INPUT i : INT; END_VAR
VAR_OUTPUT o : INT; END_VAR
VAR v : INT; END_VAR
VAR PUBLIC pub : INT; END_VAR
  o := i;
END_FUNCTION_BLOCK
`,
      { headerFileName: "generated.hpp" },
    );
    expect(source.success).toBe(true);
    const parsed = parseTestFile(
      uppercaseSource(`TEST 'access'
VAR f : FB_T; END_VAR
  f.i := 2;
  f();
  ASSERT_EQ(f.o, 2);
  ASSERT_EQ(f.pub, 0);
  ASSERT_EQ(f.v, 0);
  ASSERT_EQ(f.i, 2);
END_TEST
`),
      "test.st",
    );
    expect(parsed.errors).toEqual([]);
    const result = analyzeTestFile(parsed.testFile!, source.symbolTables!);
    expect(result.errors.map((e) => e.message)).toEqual([
      "'V' is an internal variable of FUNCTION_BLOCK 'FB_T' and cannot be accessed from outside",
      "'I' is a VAR_INPUT of FUNCTION_BLOCK 'FB_T'; from outside it can be written, not read",
    ]);
  });
});
