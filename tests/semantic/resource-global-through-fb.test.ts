/**
 * A function block's VAR_EXTERNAL reaches a RESOURCE global only from a
 * program instance of that resource: held directly, nested, in an ARRAY or
 * STRUCT, or through a base block, the instance of another resource is refused.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

type Options = Parameters<typeof compile>[1];
const MODES: Array<[string, Options]> = [
  ["no dialect", {}],
  ["iec-3", { dialect: "iec-3" }],
  ["strict", { strict: true }],
];

const source = (
  members: string,
  globalIn: "R1" | "R2",
): string => `FUNCTION_BLOCK FB_U
VAR_EXTERNAL rg : INT; END_VAR
VAR_OUTPUT o : INT; END_VAR
o := rg;
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_W
VAR inner : FB_U; END_VAR
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_X EXTENDS FB_U
END_FUNCTION_BLOCK
TYPE ST : STRUCT u : FB_U; END_STRUCT END_TYPE
PROGRAM Main
VAR ${members} END_VAR
END_PROGRAM
PROGRAM Other
VAR z : INT; END_VAR
z := 1;
END_PROGRAM
CONFIGURATION Cfg
RESOURCE R1 ON PLC
${globalIn === "R1" ? "VAR_GLOBAL rg : INT := 7; END_VAR" : ""}
TASK T1(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM inst WITH T1 : Main;
END_RESOURCE
RESOURCE R2 ON PLC
${globalIn === "R2" ? "VAR_GLOBAL rg : INT := 7; END_VAR" : ""}
TASK T2(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM inst2 WITH T2 : Other;
END_RESOURCE
END_CONFIGURATION
`;

const errors = (members: string, globalIn: "R1" | "R2", options: Options) =>
  compile(source(members, globalIn), options).errors.map((e) => e.message);

const msg = (fb: string): string =>
  `Program instance 'INST' of RESOURCE 'R1' reaches 'RG', a global of RESOURCE 'R2', through FUNCTION_BLOCK '${fb}'`;

describe("RESOURCE globals reached through function blocks", () => {
  for (const [label, options] of MODES) {
    describe(label, () => {
      it("refuses another resource's global, however the block is held", () => {
        expect(errors("u : FB_U;", "R2", options)).toEqual([msg("FB_U")]);
        expect(errors("w : FB_W;", "R2", options)).toEqual([msg("FB_U")]);
        expect(errors("a : ARRAY[0..1] OF FB_U;", "R2", options)).toEqual([
          msg("FB_U"),
        ]);
        expect(errors("s : ST;", "R2", options)).toEqual([msg("FB_U")]);
        expect(errors("x : FB_X;", "R2", options)).toEqual([msg("FB_U")]);
      });

      it("accepts the global of the instance's own resource", () => {
        expect(
          errors("u : FB_U; w : FB_W; s : ST; x : FB_X;", "R1", options),
        ).toEqual([]);
      });
    });
  }
});
