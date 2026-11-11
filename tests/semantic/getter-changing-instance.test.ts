/**
 * A GET without locals that calls a method of its FB, writes a member or
 * another property, or invokes a member FB is lowered to a method as one
 * with locals is (the C++ getter is const); a GET that only reads keeps
 * its const body.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const src = (getBody: string) => `FUNCTION_BLOCK Inner
VAR_OUTPUT o : INT; END_VAR
o := o + 1;
END_FUNCTION_BLOCK
FUNCTION_BLOCK Base
METHOD BM : INT
BM := 7;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB EXTENDS Base
VAR v : INT := 3; c : INT; inn : Inner; END_VAR
METHOD Twice : INT
Twice := v * 2;
END_METHOD
PROPERTY P : INT
GET
${getBody}
END_GET
END_PROPERTY
END_FUNCTION_BLOCK
PROGRAM Main
VAR f : FB; i : INT; END_VAR
i := f.P;
END_PROGRAM
`;

const MODES = [
  ["no dialect", { features: ["+property"] }],
  ["strict", { strict: true, features: ["+property"] }],
] as const;

describe("GET bodies that change the instance", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      for (const body of [
        "P := Twice() + THIS.Twice();",
        "P := BM() + SUPER.BM();",
        "c := c + 1; P := c;",
        "inn(); P := inn.o;",
      ]) {
        it(`lowers: ${body}`, () => {
          const r = compile(src(body), {
            ...options,
            features: [...options.features],
          });
          expect(r.errors).toEqual([]);
          expect(r.cppCode).toContain(
            "const_cast<FB*>(this)->__GET_FB_P(P_result);",
          );
        });
      }

      it("keeps a reading GET const and inline", () => {
        const r = compile(src("P := v + 1;"), {
          ...options,
          features: [...options.features],
        });
        expect(r.errors).toEqual([]);
        expect(r.cppCode).not.toContain("__GET_FB_P");
      });
    });
  }
});
