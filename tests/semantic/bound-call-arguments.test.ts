/**
 * LOWER_BOUND / UPPER_BOUND take two arguments, an array and an integer
 * dimension, named or positional. A wrong call is refused in every mode, in a
 * body and in an initial value, before code generation (an empty call in an
 * initial value threw there).
 */
import { describe, it, expect } from "vitest";
import { analyzeTestFile, compile, parseTestFile } from "../../src/index.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3", features: ["pointer_to"] }],
  ["strict", { strict: true }],
];

const HEADER = `TYPE A3 : ARRAY[1..3] OF INT; T2 : ARRAY[1..2, 3..4] OF INT; TA : T2; E_DIM : (ONE := 1, TWO := 2); END_TYPE
VAR_GLOBAL CONSTANT gi : INT := 1; END_VAR
VAR_GLOBAL ga : ARRAY[1..3] OF INT; gm : ARRAY[1..3, 0..4] OF INT; gp : POINTER TO A3; ge : E_DIM; END_VAR
`;
const LOCALS =
  "a : ARRAY[1..3] OF INT; m : ARRAY[1..3, 0..4] OF INT; ta : TA; p : POINTER TO A3; r : REF_TO A3; i : INT; s : STRING; e : E_DIM;";

/** The errors of `call` in a body, a local initial value and a global initial value. */
function errorsAt(call: string, options: Options): string[][] {
  const run = (src: string): string[] => {
    try {
      return compile(src, options).errors.map((e) => e.message);
    } catch (e) {
      return [`THROW ${(e as Error).message}`];
    }
  };
  const global = call.replace(/\b(a|m|p|i|e)\b(?!\s*:=)/g, "g$1");
  return [
    run(
      `${HEADER}PROGRAM Main\nVAR ${LOCALS} x : DINT; END_VAR\nx := ${call};\nEND_PROGRAM\n`,
    ),
    run(
      `${HEADER}PROGRAM Main\nVAR ${LOCALS} x : DINT := ${call}; END_VAR\nEND_PROGRAM\n`,
    ),
    run(
      HEADER.replace(
        "gp : POINTER TO A3;",
        `gp : POINTER TO A3; gx : DINT := ${global};`,
      ) + "PROGRAM Main\nEND_PROGRAM\n",
    ),
  ];
}

describe("LOWER_BOUND / UPPER_BOUND arguments", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      it("refuses an empty call instead of throwing", () => {
        for (const name of ["UPPER_BOUND", "LOWER_BOUND"]) {
          expect(errorsAt(`${name}()`, options)).toEqual([
            [`'${name}' requires 2 argument(s), got 0`],
            [`'${name}' requires 2 argument(s), got 0`],
            [`'${name}' requires 2 argument(s), got 0`],
          ]);
        }
      });

      it("refuses one argument and three", () => {
        expect(errorsAt("UPPER_BOUND(a)", options)).toEqual([
          ["'UPPER_BOUND' requires 2 argument(s), got 1"],
          ["'UPPER_BOUND' requires 2 argument(s), got 1"],
          ["'UPPER_BOUND' requires 2 argument(s), got 1"],
        ]);
        expect(errorsAt("LOWER_BOUND(a, 1, 1)", options)).toEqual([
          ["'LOWER_BOUND' requires 2 argument(s), got 3"],
          ["'LOWER_BOUND' requires 2 argument(s), got 3"],
          ["'LOWER_BOUND' requires 2 argument(s), got 3"],
        ]);
      });

      it("refuses a first argument that is no array", () => {
        const cases: Array<[string, string]> = [
          ["UPPER_BOUND(5, 1)", "a literal"],
          ["LOWER_BOUND([1, 2, 3], 1)", "a literal"],
          ["UPPER_BOUND(i, 1)", "INT"],
          ["UPPER_BOUND(p, 1)", "a POINTER TO: dereference it with ^"],
        ];
        for (const [call, got] of cases) {
          const name = call.slice(0, 11);
          const message = `ARR of ${name} must be an array, got ${got}`;
          const [body, local, global] = errorsAt(call, options);
          expect(body).toEqual([message]);
          expect(local).toEqual([message]);
          // (a pointer global is also read: refused under iec-3 and strict)
          expect(global).toContain(message);
        }
        expect(errorsAt("UPPER_BOUND(r, 1)", options)[0]).toEqual([
          "ARR of UPPER_BOUND must be an array, got a REF_TO: dereference it with ^",
        ]);
        expect(errorsAt("UPPER_BOUND(s, 1)", options)[0]).toEqual([
          "ARR of UPPER_BOUND must be an array, got STRING",
        ]);
      });

      it("accepts a dereferenced pointer or reference", () => {
        // (the global form reads the pointer: refused under iec-3 and strict)
        expect(errorsAt("UPPER_BOUND(p^, 1)", options).slice(0, 2)).toEqual([
          [],
          [],
        ]);
        expect(errorsAt("UPPER_BOUND(r^, 1)", options)[0]).toEqual([]);
      });

      it("refuses a constant dimension below 1", () => {
        expect(errorsAt("UPPER_BOUND(a, 0)", options)).toEqual([
          ["UPPER_BOUND has no dimension 0: the array has 1"],
          ["UPPER_BOUND has no dimension 0: the array has 1"],
          ["UPPER_BOUND has no dimension 0: the array has 1"],
        ]);
        expect(errorsAt("LOWER_BOUND(m, 1 - 2)", options)).toEqual([
          ["LOWER_BOUND has no dimension -1: the array has 2"],
          ["LOWER_BOUND has no dimension -1: the array has 2"],
          ["LOWER_BOUND has no dimension -1: the array has 2"],
        ]);
      });

      it("refuses a literal dimension above the rank of a 2-D array", () => {
        expect(errorsAt("UPPER_BOUND(m, 3)", options)).toEqual([
          ["UPPER_BOUND has no dimension 3: the array has 2"],
          ["UPPER_BOUND has no dimension 3: the array has 2"],
          ["UPPER_BOUND has no dimension 3: the array has 2"],
        ]);
      });

      it("reads the rank of an alias of an alias", () => {
        expect(errorsAt("UPPER_BOUND(ta, 0)", options).slice(0, 2)).toEqual([
          ["UPPER_BOUND has no dimension 0: the array has 2"],
          ["UPPER_BOUND has no dimension 0: the array has 2"],
        ]);
        expect(errorsAt("UPPER_BOUND(ta, 2)", options).slice(0, 2)).toEqual([
          [],
          [],
        ]);
      });

      it("refuses a dimension that is no integer", () => {
        const message =
          "Argument 'DIM' of 'UPPER_BOUND' expects ANY_INT, got REAL";
        expect(errorsAt("UPPER_BOUND(a, 1.5)", options)).toEqual([
          [message],
          [message],
          [message],
        ]);
      });

      it("refuses a dimension of an enumeration", () => {
        const message =
          "Argument 'DIM' of 'UPPER_BOUND' expects ANY_INT, got E_DIM";
        expect(errorsAt("UPPER_BOUND(a, E_DIM#ONE)", options)).toEqual([
          [message],
          [message],
          [message],
        ]);
        expect(
          errorsAt("UPPER_BOUND(DIM := (E_DIM#TWO), ARR := m)", options),
        ).toEqual([[message], [message], [message]]);
        const [body, local, global] = errorsAt("UPPER_BOUND(a, e)", options);
        expect(body).toEqual([message]);
        expect(local).toEqual([message]);
        // (the global form reads a global: refused under iec-3 and strict)
        expect(global).toContain(message);
      });

      it("accepts named arguments in either order and a valid 2-D dimension", () => {
        for (const call of [
          "UPPER_BOUND(DIM := 1, ARR := a)",
          "LOWER_BOUND(ARR := m, DIM := 2)",
          "UPPER_BOUND(DIM := 2, ARR := m)",
          "UPPER_BOUND(m, 2)",
          "UPPER_BOUND(a, i)",
        ]) {
          expect(errorsAt(call, options)).toEqual([[], [], []]);
        }
      });

      it("refuses named arguments that leave one out or name another", () => {
        expect(errorsAt("UPPER_BOUND(DIM := 1)", options)[2]).toEqual([
          "Function 'UPPER_BOUND' is missing parameter 'ARR'",
        ]);
        expect(errorsAt("UPPER_BOUND(ARR := a, X := 1)", options)[2]).toEqual([
          "Function 'UPPER_BOUND' has no parameter named 'X'",
        ]);
      });
    });
  }
});

describe("LOWER_BOUND / UPPER_BOUND in a test file", () => {
  const source = compile(`${HEADER}PROGRAM Main\nEND_PROGRAM\n`);
  /** The errors of `call` in a TEST's statement and in its VAR's initial value. */
  const testErrors = (call: string): string[][] =>
    [
      `TEST 'b'\nVAR ${LOCALS} x : DINT; END_VAR\nx := ${call};\nEND_TEST\n`,
      `TEST 'b'\nVAR ${LOCALS} x : DINT := ${call}; END_VAR\nEND_TEST\n`,
    ].map((text) => {
      const parsed = parseTestFile(text, "t.st");
      expect(parsed.errors).toEqual([]);
      return analyzeTestFile(
        parsed.testFile!,
        source.symbolTables!,
        source.ast,
      ).errors.map((e) => e.message);
    });

  it("counts the arguments as in a source", () => {
    expect(source.errors).toEqual([]);
    expect(testErrors("UPPER_BOUND(a)")).toEqual([
      ["'UPPER_BOUND' requires 2 argument(s), got 1"],
      ["'UPPER_BOUND' requires 2 argument(s), got 1"],
    ]);
    expect(testErrors("LOWER_BOUND()")).toEqual([
      ["'LOWER_BOUND' requires 2 argument(s), got 0"],
      ["'LOWER_BOUND' requires 2 argument(s), got 0"],
    ]);
  });

  it("checks the array and the dimension as in a source", () => {
    const cases: Array<[string, string]> = [
      [
        "UPPER_BOUND(5, 1)",
        "ARR of UPPER_BOUND must be an array, got a literal",
      ],
      ["UPPER_BOUND(m, 3)", "UPPER_BOUND has no dimension 3: the array has 2"],
      ["UPPER_BOUND(a, 0)", "UPPER_BOUND has no dimension 0: the array has 1"],
      [
        "UPPER_BOUND(a, 1.5)",
        "Argument 'DIM' of 'UPPER_BOUND' expects ANY_INT, got REAL",
      ],
      [
        "UPPER_BOUND(a, e)",
        "Argument 'DIM' of 'UPPER_BOUND' expects ANY_INT, got E_DIM",
      ],
      // A test file's variables carry only their declaration
      [
        "UPPER_BOUND(a, s)",
        "Argument 'DIM' of 'UPPER_BOUND' expects ANY_INT, got STRING",
      ],
      [
        "LOWER_BOUND(DIM := s, ARR := a)",
        "Argument 'DIM' of 'LOWER_BOUND' expects ANY_INT, got STRING",
      ],
      [
        "UPPER_BOUND(a, E_DIM#ONE)",
        "Argument 'DIM' of 'UPPER_BOUND' expects ANY_INT, got E_DIM",
      ],
    ];
    for (const [call, message] of cases) {
      expect(testErrors(call)).toEqual([[message], [message]]);
    }
  });

  it("refuses a REAL variable as DIM (it was truncated)", () => {
    const parsed = parseTestFile(
      `TEST 'b'\nVAR a : ARRAY[0..4] OF INT; r : REAL := 1.7; l : LREAL; x : DINT; END_VAR\nx := UPPER_BOUND(a, r);\nx := LOWER_BOUND(a, l);\nEND_TEST\n`,
      "t.st",
    );
    expect(parsed.errors).toEqual([]);
    expect(
      analyzeTestFile(
        parsed.testFile!,
        source.symbolTables!,
        source.ast,
      ).errors.map((e) => e.message),
    ).toEqual([
      "Argument 'DIM' of 'UPPER_BOUND' expects ANY_INT, got REAL",
      "Argument 'DIM' of 'LOWER_BOUND' expects ANY_INT, got LREAL",
    ]);
  });

  it("accepts correct calls", () => {
    for (const call of [
      "UPPER_BOUND(a, 1)",
      "LOWER_BOUND(DIM := 2, ARR := m)",
      "UPPER_BOUND(a, i)",
      "UPPER_BOUND(p^, 1)",
    ]) {
      expect(testErrors(call)).toEqual([[], []]);
    }
  });
});
