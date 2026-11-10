/**
 * A bare call of a name that is no function, function block instance,
 * method, action, standard function or runtime helper is an error
 * ("Undeclared function"); the callable forms stay accepted.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const DECLS = `
  FUNCTION F_REC : INT
  VAR_INPUT n : INT; END_VAR
    IF n > 0 THEN F_REC := n + F_REC(n - 1); ELSE F_REC := 0; END_IF
  END_FUNCTION
  FUNCTION_BLOCK FB_A
  VAR_INPUT i : INT; END_VAR
  VAR_OUTPUT o : INT; END_VAR
  METHOD MA : INT
    MA := 1;
  END_METHOD
    o := i;
  ACTION Act:
    o := o + 1;
  END_ACTION
  END_FUNCTION_BLOCK
  FUNCTION_BLOCK FB_B EXTENDS FB_A
  METHOD MB : INT
    MB := MA() + 1;
    Act();
  END_METHOD
    SUPER^();
  END_FUNCTION_BLOCK
`;

function errorsIn(body: string, dialect?: "iec-3"): string[] {
  return compile(
    `${DECLS}
    PROGRAM Main
    VAR a : FB_A; b : FB_B; arr : ARRAY[0..1] OF FB_A; r : INT; t : TIME; END_VAR
      ${body}
    END_PROGRAM`,
    dialect ? { dialect } : {},
  ).errors.map((e) => e.message);
}

describe("undeclared function calls", () => {
  it("refuses an unknown name called in an expression and as a statement", () => {
    expect(errorsIn("r := NO_SUCH_FN(r); NO_SUCH_FB(r);")).toEqual([
      "Undeclared function 'NO_SUCH_FN'",
      "Undeclared function 'NO_SUCH_FB'",
    ]);
    expect(errorsIn("r := NO_SUCH_FN(r);", "iec-3")).toEqual([
      "Undeclared function 'NO_SUCH_FN'",
    ]);
  });

  it("refuses an unknown name nested in an argument", () => {
    expect(errorsIn("r := F_REC(NOPE(1));")).toEqual([
      "Undeclared function 'NOPE'",
    ]);
  });

  it("accepts functions, FB instances, inherited methods, actions and recursion", () => {
    expect(
      errorsIn("a(i := 2); arr[1](i := 3); b(); r := b.MB(); r := F_REC(3);"),
    ).toEqual([]);
  });

  it("accepts standard functions, conversions and runtime helpers", () => {
    expect(
      errorsIn(
        "r := ABS(r); r := TRUNC_INT(2.5); r := LINT_TO_INT(TIME_TO_US(t));",
      ),
    ).toEqual([]);
  });

  it("accepts a bare call to a PROGRAM method", () => {
    const result = compile(
      `PROGRAM Main
       VAR r : INT; END_VAR
       METHOD Twice : INT
       VAR_INPUT x : INT; END_VAR
         Twice := x * 2;
       END_METHOD
         r := Twice(2);
       END_PROGRAM`,
      { features: ["program_methods"] },
    );
    expect(result.errors.map((e) => e.message)).toEqual([]);
  });

  it("leaves a unit with inline C++ unchecked", () => {
    expect(
      errorsIn("{external #define FROM_CPP(x) (x) }\n r := FROM_CPP(r);"),
    ).toEqual([]);
  });
});
