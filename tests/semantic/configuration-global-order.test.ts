/**
 * CONFIGURATION and RESOURCE VAR_GLOBALs: each is created after the globals
 * its initial value names; a cycle is an error. A RESOURCE declares only
 * VAR_GLOBAL, under names of its own, reached by its own program instances.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];

const PROGRAMS = `PROGRAM Main
VAR_EXTERNAL r : INT; END_VAR
VAR x : INT; END_VAR
x := r;
END_PROGRAM
PROGRAM Other
VAR y : INT; END_VAR
y := 1;
END_PROGRAM
`;

const source = (cfg: string, res: string, res2 = ""): string =>
  `${PROGRAMS}CONFIGURATION Cfg
${cfg}
RESOURCE R1 ON PLC
${res}
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM inst WITH T : Main;
END_RESOURCE
RESOURCE R2 ON PLC
${res2}
TASK T2(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM inst2 WITH T2 : Other;
END_RESOURCE
END_CONFIGURATION
`;

const errors = (src: string, options: Options): string[] =>
  compile(src, options).errors.map((e) => e.message);

describe("CONFIGURATION and RESOURCE globals", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      it("creates a global after the globals it names", () => {
        const result = compile(
          source("VAR_GLOBAL r : INT := b + 1; b : INT := 5; END_VAR", ""),
          options,
        );
        expect(result.errors).toEqual([]);
        expect(result.headerCode.indexOf("GlobalVar<IEC_INT> B{")).toBeLessThan(
          result.headerCode.indexOf("GlobalVar<IEC_INT> R{"),
        );
        expect(result.headerCode).toContain("R{B.value + 1}");
      });

      it("reports a cycle", () => {
        expect(
          errors(
            source("VAR_GLOBAL r : INT := b + 1; b : INT := r; END_VAR", ""),
            options,
          ),
        ).toEqual([
          "The initial values of the globals 'R' and 'B' depend on each other (R -> B -> R)",
        ]);
      });

      it("accepts and orders the globals of a RESOURCE", () => {
        const result = compile(
          source(
            "VAR_GLOBAL a : INT := 3; END_VAR",
            "VAR_GLOBAL r : INT := s * 2 + a; s : INT := a + 1; END_VAR",
          ),
          options,
        );
        expect(result.errors).toEqual([]);
        const h = result.headerCode;
        expect(h.indexOf("GlobalVar<IEC_INT> S{")).toBeLessThan(
          h.indexOf("GlobalVar<IEC_INT> R{"),
        );
      });

      it("refuses a RESOURCE block other than VAR_GLOBAL", () => {
        expect(errors(source("", "VAR r : INT; END_VAR"), options)).toContain(
          "RESOURCE 'R1' declares a VAR block; a RESOURCE declares only VAR_GLOBAL",
        );
      });

      it("refuses a name a RESOURCE shares with another block", () => {
        expect(
          errors(
            source(
              "",
              "VAR_GLOBAL r : INT; END_VAR",
              "VAR_GLOBAL r : INT; END_VAR",
            ),
            options,
          ),
        ).toEqual([
          "Global 'R' of RESOURCE 'R2' is also declared by RESOURCE 'R1'; the globals of a configuration and its resources need distinct names",
        ]);
        expect(
          errors(
            source(
              "VAR_GLOBAL r : INT; END_VAR",
              "VAR_GLOBAL r : INT; END_VAR",
            ),
            options,
          ),
        ).toEqual([
          "Global 'R' of RESOURCE 'R1' is also declared by CONFIGURATION 'CFG'; the globals of a configuration and its resources need distinct names",
        ]);
      });

      it("refuses reaching another RESOURCE's global", () => {
        expect(
          errors(source("", "", "VAR_GLOBAL r : INT; END_VAR"), options),
        ).toEqual([
          "Program instance 'INST' of RESOURCE 'R1' reaches 'R', a global of RESOURCE 'R2'",
        ]);
        expect(
          errors(
            source(
              "VAR_GLOBAL q : INT := r; END_VAR",
              "VAR_GLOBAL r : INT; END_VAR",
            ),
            options,
          ),
        ).toEqual([
          "The initial value of 'Q' names 'R', a global of RESOURCE 'R1'",
        ]);
      });
    });
  }
});
