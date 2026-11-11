/**
 * An INTERFACE as an ARRAY element or a STRUCT field is emitted as the
 * reference an interface variable is (`IEC_ITF<I>`), not the abstract class.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];

const SOURCE = `INTERFACE ICnt
METHOD Inc : INT
END_METHOD
END_INTERFACE
TYPE TA : ARRAY[0..1] OF ICnt; END_TYPE
TYPE ST : STRUCT one : ICnt; list : ARRAY[0..1] OF ICnt; END_STRUCT END_TYPE
PROGRAM Main
VAR arr : ARRAY[0..1] OF ICnt; t : TA; s : ST; END_VAR
END_PROGRAM
`;

describe("INTERFACE ARRAY elements and STRUCT fields", () => {
  for (const [label, options] of MODES) {
    it(label, () => {
      const r = compile(SOURCE, {
        ...options,
        headerFileName: "generated.hpp",
      });
      expect(r.errors).toEqual([]);
      expect(r.headerCode).toContain("IEC_ITF<ICNT> ONE");
      expect(r.headerCode).toContain("Array1D<IEC_ITF<ICNT>, 0, 1> LIST");
      expect(r.headerCode).toContain("Array1D<IEC_ITF<ICNT>, 0, 1> ARR;");
      expect(r.headerCode).not.toMatch(/Array1D<ICNT,|\bICNT ONE/);
    });
  }
});
