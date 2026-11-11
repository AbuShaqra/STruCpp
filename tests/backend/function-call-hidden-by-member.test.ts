/**
 * A FUNCTION, library function or standard function called where a variable
 * of its name (any case) is in scope is emitted namespace-qualified, since
 * the C++ variable hides the function there. An FB instance of the name is
 * what such a call invokes (#92), and that call has no value.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];

const FN = `FUNCTION G : INT
VAR_INPUT x : INT; END_VAR
G := x + 1;
END_FUNCTION
FUNCTION_BLOCK FB
VAR_OUTPUT o : INT; END_VAR
o := 1;
END_FUNCTION_BLOCK
`;

describe("function calls hidden by a variable of their name", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      it("qualifies a user FUNCTION and a standard function", () => {
        const r = compile(
          `${FN}PROGRAM Main
VAR g : INT := 5; limit : INT := 50; i : INT; END_VAR
i := G(g) + LIMIT(0, limit, 10);
END_PROGRAM
`,
          options,
        );
        expect(r.errors).toEqual([]);
        expect(r.cppCode).toContain("::strucpp::G(G)");
        expect(r.cppCode).toMatch(/::strucpp::LIMIT\(/);
      });

      it("leaves a call without such a variable as it was", () => {
        const r = compile(
          `${FN}PROGRAM Main
VAR i : INT; END_VAR
i := G(1);
END_PROGRAM
`,
          options,
        );
        expect(r.cppCode).toContain("I = G(1);");
      });

      it("refuses a value of an FB instance call", () => {
        const r = compile(
          `${FN}PROGRAM Main
VAR g : FB; i : INT; END_VAR
g(); i := G(4);
END_PROGRAM
`,
          options,
        );
        expect(r.errors.map((e) => e.message)).toEqual([
          "'G' is a FUNCTION_BLOCK instance: its call has no value",
        ]);
      });
    });
  }
});
