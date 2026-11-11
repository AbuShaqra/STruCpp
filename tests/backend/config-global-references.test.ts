/**
 * A CONFIGURATION REF_TO global's REF(g) initial value binds it like a
 * POINTER TO global's ADR(g); `p^` on a VAR_EXTERNAL pointer or reference
 * dereferences the value the shared global holds.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["strict", { strict: true }],
];

const SOURCE = `PROGRAM Main
VAR_EXTERNAL p : REF_TO INT; q : POINTER TO INT; END_VAR
VAR y : INT; END_VAR
y := p^ + q^;
p^ := 9;
END_PROGRAM
CONFIGURATION Cfg
VAR_GLOBAL
  p : REF_TO INT := REF(g);
  q : POINTER TO INT := ADR(g);
  g : INT := 4;
END_VAR
RESOURCE R ON PLC
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM inst WITH T : Main;
END_RESOURCE
END_CONFIGURATION
`;

describe("CONFIGURATION global references", () => {
  for (const [label, options] of MODES) {
    it(label, () => {
      const r = compile(SOURCE, {
        ...options,
        headerFileName: "generated.hpp",
      });
      expect(r.errors).toEqual([]);
      expect(r.headerCode).not.toContain("GlobalVar<IEC_REF_TO<INT_t>> P{};");
      expect(r.cppCode).toContain("P->read()");
      expect(r.cppCode).toContain("Q->read()");
      expect(r.cppCode).not.toMatch(/\(\*P\)|\(\*Q\)/);
    });
  }
});
