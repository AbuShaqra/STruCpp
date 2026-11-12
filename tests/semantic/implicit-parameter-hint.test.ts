/**
 * The "missing required input" error names {attribute 'implicit-parameter'}
 * for a FUNCTION input that carries it, in every dialect.
 */
import { describe, it, expect } from "vitest";
import { compile, type CompileOptions } from "../../src/index.js";

const LOGGER = `FUNCTION LOG : BOOL
VAR_INPUT
  msg : STRING;
  {attribute 'implicit-parameter' := 'pouname'}
  pouName : STRING;
  {attribute 'implicit-parameter':='position'}
  position : STRING := '';
  {attribute 'implicit-parameter' := 'instance-path'} path : STRING;
  {attribute 'other'}
  level : INT;
END_VAR
LOG := TRUE;
END_FUNCTION
`;

function errors(body: string, opts: Partial<CompileOptions> = {}): string[] {
  const src = `${LOGGER}PROGRAM MAIN
VAR b : BOOL; END_VAR
${body}
END_PROGRAM
`;
  return compile(src, opts).errors.map((e) => `${e.line}: ${e.message}`);
}

const MODES: Partial<CompileOptions>[] = [
  {},
  { strict: true },
  { dialect: "iec-3" },
  {
    dialect: {
      id: "codesys3",
      name: "codesys3",
      extends: "iec-3",
      features: ["conditional_pragmas"],
      semantics: {},
    },
  },
];

describe("implicit-parameter hint", () => {
  it("names the attribute for the inputs that carry it", () => {
    for (const opts of MODES) {
      expect(errors("b := LOG('x', level := 1);", opts)).toEqual([
        "16: 'LOG' is missing required inputs: POUNAME, PATH; this compiler does not fill {attribute 'implicit-parameter'} inputs (POUNAME, PATH): pass them or give them an initial value",
      ]);
    }
  });

  it("names only the missing inputs that carry it", () => {
    expect(errors("b := LOG(pouName := 'M', path := 'p');")).toEqual([
      "16: 'LOG' is missing required inputs: MSG, LEVEL",
    ]);
    expect(errors("b := LOG(msg := 'x', path := 'p');")).toEqual([
      "16: 'LOG' is missing required inputs: POUNAME, LEVEL; this compiler does not fill {attribute 'implicit-parameter'} inputs (POUNAME): pass it or give it an initial value",
    ]);
  });

  it("is not given for an attribute away from the input", () => {
    const src = `FUNCTION F : BOOL
{attribute 'implicit-parameter' := 'pouname'}
VAR_INPUT

  a : STRING;
END_VAR
F := TRUE;
END_FUNCTION
PROGRAM MAIN
VAR b : BOOL; END_VAR
b := F();
END_PROGRAM
`;
    expect(compile(src).errors.map((e) => e.message)).toEqual([
      "'F' is missing required input: A",
    ]);
  });

  it("changes nothing when every input is passed", () => {
    for (const opts of MODES) {
      expect(errors("b := LOG('x', 'P', '', 'Q', 1);", opts)).toEqual([]);
    }
  });
});
