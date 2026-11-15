/**
 * THIS and SUPER take a whole access path (`THIS.a.b`, `THIS.arr[i]`,
 * `SUPER.s.b`), as a value and as an assignment target; `SUPER.x := v` assigns
 * a base member and `SUPER();` (Ed. 3) calls the base body like `SUPER^();`.
 * The member access rule applies at every step.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { withoutSites } from "../support/fault-sites.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];

const TYPES = `TYPE ST : STRUCT b : INT; END_STRUCT END_TYPE
FUNCTION_BLOCK FB_X
VAR_OUTPUT q : INT; END_VAR
VAR v : INT; END_VAR
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_B
VAR_OUTPUT x : INT; END_VAR
VAR s : ST; arrB : ARRAY[1..2] OF INT; inner : FB_X; END_VAR
x := x + 1;
END_FUNCTION_BLOCK
`;

const compileDerived = (body: string, options: Options) =>
  compile(
    `${TYPES}FUNCTION_BLOCK FB_D EXTENDS FB_B
VAR_OUTPUT o : INT; END_VAR
VAR a : ST; arr : ARRAY[1..2] OF INT; xs : ARRAY[1..2] OF FB_X; END_VAR
${body}
END_FUNCTION_BLOCK
`,
    { ...options, headerFileName: "generated.hpp" },
  );

describe("THIS and SUPER access paths", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      it("accepts paths as values and targets, SUPER() and SUPER.x :=", () => {
        const r = compileDerived(
          `SUPER();
THIS.a.b := 3;
THIS.arr[2] := 4;
SUPER.s.b := 5;
SUPER.arrB[1] := 6;
SUPER.x := SUPER.x + 100;
o := THIS.a.b + THIS.arr[2] + SUPER.s.b + SUPER.arrB[1] + THIS.xs[1].q + SUPER.inner.q;`,
          options,
        );
        expect(r.errors).toEqual([]);
        expect(withoutSites(r.cppCode)).toContain("FB_B::operator()();");
        expect(withoutSites(r.cppCode)).toContain("this->A.B = 3;");
        expect(withoutSites(r.cppCode)).toContain("(*this).ARR.at(2) = 4;");
        expect(withoutSites(r.cppCode)).toContain("FB_B::S.B = 5;");
        expect(withoutSites(r.cppCode)).toContain(
          "static_cast<FB_B&>(*this).ARRB.at(1) = 6;",
        );
        expect(withoutSites(r.cppCode)).toContain("FB_B::X = FB_B::X + 100;");
      });

      it("applies the member access rule at every step", () => {
        const msg =
          "'V' is an internal variable of FUNCTION_BLOCK 'FB_X' and cannot be accessed from outside";
        expect(
          compileDerived(
            "o := THIS.xs[1].v;\no := SUPER.inner.v;",
            options,
          ).errors.map((e) => e.message),
        ).toEqual([msg, msg]);
      });
    });
  }
});
