/**
 * A FOR control variable that is a REF_TO, or a REFERENCE TO without BY, is
 * refused (g++ refused each such loop); a REFERENCE TO with BY steps. A
 * POINTER TO steps an address: warned when its end value is an integer,
 * silent when it is an address (ADR, a pointer member, alias or element, a
 * FUNCTION returning a pointer). The variable is named as written.
 */
import { describe, it, expect } from "vitest";
import { analyze, compile } from "../../src/index.js";

const SOURCE = `TYPE PINT : POINTER TO INT; END_TYPE
TYPE ST : STRUCT pe : POINTER TO INT; END_STRUCT; END_TYPE
FUNCTION FD : LWORD
VAR_INPUT a : LWORD; END_VAR
FD := a;
END_FUNCTION
FUNCTION FP : POINTER TO INT
VAR_INPUT a : POINTER TO INT; END_VAR
FP := a;
END_FUNCTION
PROGRAM Main
VAR x : INT; pX, q : POINTER TO INT; rT : REF_TO DINT; rfA, rfB : REFERENCE TO INT; i, n : INT;
  st : ST; e : PINT; pa : ARRAY[0..1] OF POINTER TO INT; END_VAR
FOR pX := 0 TO 10 DO n := n + 1; END_FOR;
FOR pX := ADR(x) TO i DO n := n + 1; END_FOR;
FOR rT := 0 TO 10 DO n := n + 1; END_FOR;
FOR rfA := 0 TO 10 DO n := n + 1; END_FOR;
FOR rfB := 1 TO 10 BY 2 DO n := n + 1; END_FOR;
FOR pX := ADR(x) TO FD(ADR(x)) DO n := n + 1; END_FOR;
FOR pX := ADR(x) TO ADR(x) BY 1 DO n := n + 1; END_FOR;
FOR pX := 0 TO ADR(x) DO n := n + 1; END_FOR;
FOR pX := q TO q DO n := n + 1; END_FOR;
FOR pX := ADR(x) TO st.pe DO n := n + 1; END_FOR;
FOR pX := ADR(x) TO e DO n := n + 1; END_FOR;
FOR pX := ADR(x) TO pa[1] DO n := n + 1; END_FOR;
FOR pX := ADR(x) TO FP(ADR(x)) DO n := n + 1; END_FOR;
FOR i := 0 TO 10 DO n := n + 1; END_FOR;
END_PROGRAM
`;
const at = (e: { line: number; column: number; message: string }): string =>
  `${e.line}:${e.column}: ${e.message}`;
const pointerWarning =
  "FOR control variable 'pX' is a POINTER TO INT, not an integer, and its end value is not an address";

describe("FOR control variable of a pointer or reference type", () => {
  for (const run of [compile, analyze]) {
    it(`refuses a reference that cannot step and warns at a pointer up to an integer (${run.name})`, () => {
      const result = run(SOURCE, { fileName: "main.st" });
      expect(result.errors.map(at)).toEqual([
        "16:1: FOR control variable 'rT' must be an integer type, got REF_TO DINT",
        "17:1: FOR control variable 'rfA' is a REFERENCE TO INT: it steps only with BY",
      ]);
      expect(
        result.warnings
          .filter((w) => w.message.startsWith("FOR control variable"))
          .map(at),
      ).toEqual([
        `14:1: ${pointerWarning}`,
        `15:1: ${pointerWarning}`,
        `19:1: ${pointerWarning}`,
      ]);
    });
  }
});
