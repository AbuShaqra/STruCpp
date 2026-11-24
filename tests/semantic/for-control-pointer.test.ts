/**
 * A FOR control variable that is a REF_TO or REFERENCE TO is refused (g++
 * refused every such loop). A POINTER TO steps an address: warned when its
 * end value is not an address, silent when it is (`TO ADR(x)`).
 */
import { describe, it, expect } from "vitest";
import { analyze, compile } from "../../src/index.js";

const SOURCE = `PROGRAM Main
VAR x : INT; p, q : POINTER TO INT; r : REF_TO DINT; rf : REFERENCE TO INT; i, n : INT; END_VAR
FOR p := 0 TO 10 DO n := n + 1; END_FOR;
FOR p := ADR(x) TO i DO n := n + 1; END_FOR;
FOR r := 0 TO 10 DO n := n + 1; END_FOR;
FOR rf := 0 TO 10 DO n := n + 1; END_FOR;
FOR p := ADR(x) TO ADR(x) BY 1 DO n := n + 1; END_FOR;
FOR p := 0 TO ADR(x) DO n := n + 1; END_FOR;
FOR p := q TO q DO n := n + 1; END_FOR;
FOR i := 0 TO 10 DO n := n + 1; END_FOR;
END_PROGRAM
`;
const at = (e: { line: number; column: number; message: string }): string =>
  `${e.line}:${e.column}: ${e.message}`;

describe("FOR control variable of a pointer or reference type", () => {
  for (const run of [compile, analyze]) {
    it(`refuses a reference and warns at a pointer up to a non-address (${run.name})`, () => {
      const result = run(SOURCE);
      expect(result.errors.map(at)).toEqual([
        "5:1: FOR control variable 'R' must be an integer type, got REF_TO DINT",
        "6:1: FOR control variable 'RF' must be an integer type, got REFERENCE TO INT",
      ]);
      expect(
        result.warnings
          .filter((w) => w.message.startsWith("FOR control variable"))
          .map(at),
      ).toEqual([
        "3:1: FOR control variable 'P' is a POINTER TO INT, not an integer, and its end value is not an address",
        "4:1: FOR control variable 'P' is a POINTER TO INT, not an integer, and its end value is not an address",
      ]);
    });
  }
});
