/**
 * An enumeration value (`E#M`, `E.M` or a bare member) has its enumeration's
 * type, as an enumeration variable does, so it is not an integer: it cannot
 * be assigned to one, computed with, compared with one, or bound a FOR loop.
 * TO_INT and the other conversions give its number.
 */

import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const HEADER = `
TYPE E2 : (A, B); END_TYPE
TYPE E3 : (B, C, D); END_TYPE
TYPE EV : (X := 5, Y := 10); END_TYPE
TYPE S1 : STRUCT e : E2; i : INT; END_STRUCT END_TYPE
FUNCTION FE : E2 VAR_INPUT v : E2; END_VAR FE := v; END_FUNCTION
FUNCTION_BLOCK FB VAR_INPUT w : E2; END_VAR END_FUNCTION_BLOCK
PROGRAM Main
VAR
  i : INT; en : E2; en3 : E3; dd : DINT; bb : BOOL; r : REAL; w : WORD;
  str : STRING; ae : ARRAY[0..1] OF E2; s : S1; fbi : FB;
END_VAR
`;

function errorsFor(body: string, dialect?: "iec-3"): string[] {
  const result = compile(`${HEADER}${body}\nEND_PROGRAM\n`, {
    ...(dialect ? { dialect } : {}),
  });
  return result.errors.map((e) => e.message);
}

describe("an enumeration value is not an integer", () => {
  it.each([
    ["i := E2#B;", "Cannot assign E2 to INT"],
    ["i := E2.B;", "Cannot assign E2 to INT"],
    ["i := A;", "Cannot assign E2 to INT"],
    ["i := X;", "Cannot assign EV to INT"],
    ["dd := EV#Y;", "Cannot assign EV to DINT"],
    ["r := E2#B;", "Cannot assign E2 to REAL"],
    ["w := E2#B;", "Cannot assign E2 to WORD"],
    ["bb := E2#B;", "Cannot assign E2 to BOOL"],
    ["str := E2#B;", "Cannot assign E2 to STRING"],
    ["s.i := E2#B;", "Cannot assign E2 to INT"],
  ])("refuses %s", (body, message) => {
    expect(errorsFor(body)).toEqual([message]);
    expect(errorsFor(body, "iec-3")).toEqual([message]);
  });

  it("refuses a value of another enumeration", () => {
    expect(errorsFor("en := E3#C;")).toEqual(["Cannot assign E3 to E2"]);
    expect(errorsFor("en := C;")).toEqual(["Cannot assign E3 to E2"]);
    expect(errorsFor("en := E3.C;")).toEqual(["Cannot assign E3 to E2"]);
    expect(errorsFor("s.e := E3#C;")).toEqual(["Cannot assign E3 to E2"]);
    expect(errorsFor("ae[0] := E3#C;")).toEqual(["Cannot assign E3 to E2"]);
  });

  it.each([
    ["i := E2#B + 1;", "+"],
    ["dd := dd - E2#B;", "-"],
    ["i := E2#B * 2;", "*"],
    ["i := E2#B MOD 2;", "MOD"],
    ["IF E2#B + 1 > 0 THEN i := 1; END_IF;", "+"],
    ["en := en + 1;", "+"],
    ["dd := dd + en;", "+"],
    ["bb := en AND bb;", "AND"],
    ["i := -E2#B;", "-"],
    ["en := -en;", "-"],
    ["bb := NOT E2#B;", "NOT"],
  ])("refuses arithmetic in %s", (body, op) => {
    expect(errorsFor(body)).toEqual([
      `Operator '${op}' cannot be applied to the enumeration E2; convert it first, for example with TO_INT`,
    ]);
  });

  it.each([
    ["bb := E2#B > 0;", "Cannot compare E2 with INT"],
    ["bb := i = E2#B;", "Cannot compare INT with E2"],
    ["bb := en = 0;", "Cannot compare E2 with INT"],
    ["bb := en = E3#C;", "Cannot compare E2 with E3"],
    ["bb := en = C;", "Cannot compare E2 with E3"],
    ["bb := E2#A = E3#C;", "Cannot compare E2 with E3"],
    ["IF en > 0 THEN i := 1; END_IF;", "Cannot compare E2 with INT"],
  ])("refuses the comparison %s", (body, message) => {
    expect(errorsFor(body)).toEqual([message]);
  });

  it.each([
    ["FOR i := E2#A TO E2#B DO dd := dd + 1; END_FOR;", 2],
    ["FOR i := 0 TO E2#B DO dd := dd + 1; END_FOR;", 1],
    ["FOR i := 0 TO 3 BY E2#B DO dd := dd + 1; END_FOR;", 1],
    ["FOR i := en TO 3 DO dd := dd + 1; END_FOR;", 1],
  ])("refuses the FOR bounds of %s", (body, count) => {
    expect(errorsFor(body)).toEqual(
      Array.from({ length: count }, () => "Cannot assign E2 to INT"),
    );
  });

  it("refuses MAX and MIN of enumerations", () => {
    expect(errorsFor("en := MAX(E2#A, E2#B);")).toContain(
      "Argument 'IN1' of 'MAX' expects ANY_ELEMENTARY, got E2",
    );
    expect(errorsFor("en := MIN(E2#A, en);")).toContain(
      "Argument 'IN1' of 'MIN' expects ANY_ELEMENTARY, got E2",
    );
    expect(errorsFor("en := MAX(en, en);")).toContain(
      "Argument 'IN1' of 'MAX' expects ANY_ELEMENTARY, got E2",
    );
  });

  it("keeps enumeration use of a value", () => {
    const body = `
      en := E2#B; en := E2.B; en := A; en := B; en3 := B;
      s.e := E2#B; ae[0] := E2#B; ae[1] := A;
      en := FE(E2#B); en := FE(A); fbi(w := E2#B); fbi(w := A);
      bb := en = E2#B; bb := en = A; bb := E2#A < E2#B; bb := E2#A = A;
      bb := E2#A <> en; bb := en >= E2#A; bb := en > en;
      bb := E2#A = E2#B AND en <> E2#A;
      i := TO_INT(E2#B); i := TO_INT(A); i := TO_INT(en) + 1;
      dd := TO_DINT(EV#Y) + 1;
      en := MOVE(E2#B);
      CASE en OF A: i := 1; E2#B: i := 2; END_CASE;
      WHILE en < E2#B DO en := E2#B; END_WHILE;
      FOR i := TO_INT(E2#A) TO TO_INT(E2#B) DO dd := dd + 1; END_FOR;
    `;
    expect(errorsFor(body)).toEqual([]);
    expect(errorsFor(body, "iec-3")).toEqual([]);
  });
});
