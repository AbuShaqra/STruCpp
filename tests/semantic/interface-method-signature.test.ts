/**
 * A method an FB provides for an interface method must have the interface's
 * C++ signature, or the FB stays abstract (or the override conflicts) and
 * g++ fails. A parameter named otherwise only warns; a default value differing
 * is silent.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
  [
    "strict, vendor features",
    { strict: true, dialect: "iec-3", features: ["+program_methods"] },
  ],
];

const IFACE = `INTERFACE I
METHOD M : INT
VAR_INPUT a : INT; END_VAR
END_METHOD
END_INTERFACE
`;

function build(method: string, call = "r := f.M(2);", iface = IFACE) {
  return compile(
    `${iface}FUNCTION_BLOCK FB IMPLEMENTS I
${method}
END_FUNCTION_BLOCK
PROGRAM Main
VAR f : FB; r : INT; END_VAR
${call}
END_PROGRAM
`,
    MODE_OPTIONS,
  );
}
let MODE_OPTIONS: Options = {};

const WHERE = "Method 'M' of FUNCTION_BLOCK 'FB' does not match interface 'I'";

describe("interface method signatures", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      const errors = (method: string, call?: string, iface?: string) => {
        MODE_OPTIONS = options;
        return build(method, call, iface).errors.map((e) => e.message);
      };

      it("refuses an extra output or in/out", () => {
        expect(
          errors(`METHOD M : INT
VAR_INPUT a : INT; END_VAR
VAR_OUTPUT o : INT; END_VAR
M := a; o := 1;
END_METHOD`),
        ).toEqual([`${WHERE}: it has 2 parameter(s), the interface 1`]);
      });

      it("refuses another parameter type or STRING length", () => {
        expect(
          errors(`METHOD M : INT
VAR_INPUT a : DINT; END_VAR
M := 1;
END_METHOD`),
        ).toEqual([
          `${WHERE}: parameter 1 'A' is DINT, the interface's 'A' is INT`,
        ]);
      });

      it("refuses another STRING length of an in/out or output", () => {
        expect(
          errors(
            `METHOD M : INT
VAR_IN_OUT t : STRING(20); END_VAR
M := 1;
END_METHOD`,
            "",
            `INTERFACE I
METHOD M : INT
VAR_IN_OUT t : STRING(10); END_VAR
END_METHOD
END_INTERFACE
`,
          ),
        ).toEqual([
          `${WHERE}: parameter 1 'T' is STRING(20), the interface's 'T' is STRING(10)`,
        ]);
      });

      it("refuses an input turned into an output", () => {
        expect(
          errors(`METHOD M : INT
VAR_OUTPUT a : INT; END_VAR
a := 1; M := 2;
END_METHOD`),
        ).toEqual([
          `${WHERE}: parameter 1 'A' is VAR_OUTPUT, the interface's 'A' is VAR_INPUT`,
        ]);
      });

      it("refuses another or a missing return type", () => {
        expect(
          errors(`METHOD M : DINT
VAR_INPUT a : INT; END_VAR
M := a;
END_METHOD`),
        ).toEqual([`${WHERE}: it returns DINT, the interface INT`]);
        expect(
          errors(
            `METHOD M
VAR_INPUT a : INT; END_VAR
END_METHOD`,
            "f.M(2);",
          ),
        ).toEqual([`${WHERE}: it returns nothing, the interface INT`]);
      });

      it("checks the methods of a base interface and an inherited method", () => {
        const base = `INTERFACE IB
METHOD M : INT
VAR_INPUT a : INT; END_VAR
END_METHOD
END_INTERFACE
INTERFACE I EXTENDS IB
END_INTERFACE
`;
        MODE_OPTIONS = options;
        expect(
          build(
            `METHOD M : INT
VAR_INPUT a : DINT; END_VAR
M := 1;
END_METHOD`,
            "r := f.M(2);",
            base,
          ).errors.map((e) => e.message),
        ).toEqual([
          "Method 'M' of FUNCTION_BLOCK 'FB' does not match interface 'IB': parameter 1 'A' is DINT, the interface's 'A' is INT",
        ]);
        const inherited = compile(
          `${IFACE}FUNCTION_BLOCK Base
METHOD M : INT
VAR_INPUT a : DINT; END_VAR
M := 1;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB EXTENDS Base IMPLEMENTS I
END_FUNCTION_BLOCK
PROGRAM Main
VAR f : FB; END_VAR
f();
END_PROGRAM
`,
          options,
        );
        expect(inherited.errors.map((e) => e.message)).toEqual([
          `${WHERE}: parameter 1 'A' is DINT, the interface's 'A' is INT`,
        ]);
      });

      it("warns on a parameter named otherwise", () => {
        MODE_OPTIONS = options;
        const r = build(`METHOD M : INT
VAR_INPUT b : INT; END_VAR
M := b;
END_METHOD`);
        expect(r.errors).toEqual([]);
        expect(r.warnings.map((w) => w.message)).toContain(
          "Parameter 1 'B' of method 'M' of FUNCTION_BLOCK 'FB' is named 'A' in interface 'I': a call with named arguments through the FB differs from one through the interface",
        );
      });

      it("accepts what C++ overrides alike", () => {
        // A default value, STRING and STRING(254) (also by reference), and
        // an output for an in/out.
        MODE_OPTIONS = options;
        const r = build(
          `METHOD M : INT
VAR_INPUT a : INT := 5; s : STRING(254); END_VAR
VAR_IN_OUT o : INT; t : STRING(254); END_VAR
M := a;
END_METHOD`,
          "",
          `INTERFACE I
METHOD M : INT
VAR_INPUT a : INT; s : STRING; END_VAR
VAR_OUTPUT o : INT; END_VAR
VAR_IN_OUT t : STRING; END_VAR
END_METHOD
END_INTERFACE
`,
        );
        expect(r.errors).toEqual([]);
        expect(r.warnings.map((w) => w.message).join("\n")).not.toContain(
          "interface",
        );
      });
    });
  }
});
