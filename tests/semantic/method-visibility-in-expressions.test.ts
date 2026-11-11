/**
 * A PRIVATE or PROTECTED method called from outside is refused wherever the
 * call is written: in an expression, a condition, or through an instance of
 * a derived FB (the method declared by a base), as a statement call was.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];

const errors = (body: string, options: Options) =>
  compile(
    `FUNCTION_BLOCK FB
METHOD PRIVATE Pm : INT
Pm := 1;
END_METHOD
METHOD PROTECTED Qm : INT
Qm := 2;
END_METHOD
METHOD Pub : INT
Pub := Pm() + Qm();
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK D EXTENDS FB
METHOD Use : INT
Use := THIS.Qm() + Qm();
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main
VAR f : FB; d : D; i : INT; END_VAR
${body}
END_PROGRAM
`,
    options,
  ).errors.map((e) => e.message);

describe("method visibility in expressions", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      it("refuses PRIVATE and PROTECTED calls in expressions and conditions", () => {
        expect(errors("i := f.Pm() + 1;", options)).toEqual([
          "Cannot call PRIVATE method 'PM' of 'FB' from outside 'FB'.",
        ]);
        expect(errors("IF f.Qm() > 0 THEN i := 1; END_IF;", options)).toEqual([
          "Cannot call PROTECTED method 'QM' of 'FB' from 'PROGRAM'.",
        ]);
        expect(
          errors("WHILE f.Pm() > 5 DO i := 1; END_WHILE;", options),
        ).toEqual([
          "Cannot call PRIVATE method 'PM' of 'FB' from outside 'FB'.",
        ]);
      });

      it("refuses a base's PROTECTED method through a derived instance", () => {
        expect(errors("i := d.Qm();", options)).toEqual([
          "Cannot call PROTECTED method 'QM' of 'FB' from 'PROGRAM'.",
        ]);
      });

      it("accepts public calls and a derived FB's own use", () => {
        expect(errors("i := f.Pub() + d.Use();", options)).toEqual([]);
      });
    });
  }
});
