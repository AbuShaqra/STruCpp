/**
 * In a SET body the property's name is the value being set, also where an
 * enumeration has a member of that name; elsewhere the bare member is still
 * the enumeration's.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const SRC = `TYPE Mode : (Idle, Speed, Stop); END_TYPE
FUNCTION_BLOCK FB
VAR v : INT; mv : Mode; END_VAR
PROPERTY Speed : INT
SET
v := Speed;
END_SET
END_PROPERTY
METHOD M
mv := Stop;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main
VAR f : FB; END_VAR
f.Speed := 1;
END_PROGRAM
`;

describe("SET body reads its property name", () => {
  for (const [label, options] of [
    ["no dialect", { features: ["+property"] }],
    ["strict", { strict: true, features: ["+property"] }],
    // The FB property needs fb_property, off in iec-3: kept here.
    [
      "iec-3 with property",
      { dialect: "iec-3", features: ["+property", "+fb_property"] },
    ],
  ] as const) {
    it(label, () => {
      const r = compile(SRC, { ...options, features: [...options.features] });
      expect(r.errors).toEqual([]);
      expect(r.cppCode).toMatch(
        /void FB::set_SPEED\(IEC_INT SPEED\) \{\n\s*V = SPEED;/,
      );
      expect(r.cppCode).toMatch(/MV = MODE::STOP;/i);
    });
  }
});
