/**
 * A write to an interface-typed shared global (scalar or array element) hoists
 * its value into an interface temp, not `auto`: `auto` copied the FB instance
 * and left the global referring to that temp after the block.
 */

import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const SOURCE = `
INTERFACE I_S
METHOD Reset : BOOL
END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB_A IMPLEMENTS I_S
METHOD Reset : BOOL
Reset := TRUE;
END_METHOD
END_FUNCTION_BLOCK
TYPE ST_G : STRUCT one : I_S; n : INT; END_STRUCT; END_TYPE
PROGRAM Main
VAR a : FB_A; t : ST_G; END_VAR
VAR_EXTERNAL gIf : I_S; gArr : ARRAY[1..2] OF I_S; gS : ST_G; END_VAR
gIf := a;
gArr[2] := a;
gS.one := a;
gS := t;
END_PROGRAM
CONFIGURATION Cfg
VAR_GLOBAL gIf : I_S; gArr : ARRAY[1..2] OF I_S; gS : ST_G; END_VAR
RESOURCE Res ON PLC
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM P WITH T : Main;
END_RESOURCE
END_CONFIGURATION
`;

describe("interface-typed shared global writes", () => {
  const result = compile(SOURCE);

  it("compiles", () => {
    expect(result.errors).toEqual([]);
  });

  it("binds the instance through an interface temp", () => {
    const temps = [
      ...result.cppCode.matchAll(/^\s*(.+) __gwv_\d+ = (\w+);/gm),
    ].map((m) => `${m[1]} = ${m[2]}`);
    expect(temps).toEqual([
      "IEC_ITF<I_S> = A",
      "IEC_ITF<I_S> = A",
      "IEC_ITF<I_S> = A",
      "auto = T",
    ]);
  });
});
