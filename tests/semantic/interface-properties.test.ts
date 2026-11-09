/**
 * PROPERTY prototypes in an INTERFACE (feature property). Not in IEC 61131-3
 * Ed. 3, so refused with no dialect and under iec-3. A prototype declares its
 * accessors explicitly (`GET END_GET`, `SET END_SET`, no bodies). Covers the
 * IMPLEMENTS contract (own and EXTENDS-inherited properties), access through
 * an interface variable, and that FB PROPERTY stays accepted everywhere.
 * The lexer upper-cases identifiers, so messages name them upper-cased.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import type { DialectProfile } from "../../src/dialect.js";

const PROPERTY_PROFILE: DialectProfile = {
  id: "props",
  name: "props",
  extends: "iec-3",
  features: ["property"],
  semantics: {},
};

type Options = Parameters<typeof compile>[1];

const ON: Options = { features: ["+property"] };

/** `IState` declares State (GET) on line 2 and Level (GET and SET) on line 5. */
const ITF = `INTERFACE IState
PROPERTY State : INT
GET END_GET
END_PROPERTY
PROPERTY Level : INT
GET END_GET
SET END_SET
END_PROPERTY
END_INTERFACE
`;

/** An implementation of IState; line 10 is its FUNCTION_BLOCK line. */
const FB_OK = `FUNCTION_BLOCK FB_S IMPLEMENTS IState
VAR n : INT; END_VAR
PROPERTY State : INT
GET
  State := n;
END_GET
END_PROPERTY
PROPERTY Level : INT
GET
  Level := n;
END_GET
SET
  n := Level;
END_SET
END_PROPERTY
END_FUNCTION_BLOCK
`;

function messages(source: string, options: Options = {}): string[] {
  return compile(source, options).errors.map(
    (e) => `${e.line}:${e.column} ${e.message}`,
  );
}

describe("interface PROPERTY needs the feature property", () => {
  const modes: { name: string; options: Options }[] = [
    { name: "no dialect", options: {} },
    { name: "iec-3", options: { dialect: "iec-3" } },
  ];
  for (const mode of modes) {
    it(`is refused under ${mode.name}, at each PROPERTY`, () => {
      expect(messages(ITF + FB_OK, mode.options)).toEqual([
        "2:1 PROPERTY in an INTERFACE needs the feature property",
        "5:1 PROPERTY in an INTERFACE needs the feature property",
      ]);
    });
  }

  it("names the loaded profiles that have it", () => {
    expect(
      messages(ITF, {
        dialect: "iec-3",
        dialectFiles: ["props.json"],
        dialectIO: {
          readFile: () => JSON.stringify(PROPERTY_PROFILE),
          listDir: () => [],
        },
      }),
    ).toContain(
      "2:1 PROPERTY in an INTERFACE needs the feature property (profiles: props)",
    );
  });

  it("is accepted with +property", () => {
    expect(messages(ITF + FB_OK, ON)).toEqual([]);
  });

  it("is accepted through a profile object that enables it", () => {
    expect(messages(ITF + FB_OK, { dialect: PROPERTY_PROFILE })).toEqual([]);
  });

  it("an INTERFACE with methods only needs no feature", () => {
    const source = `INTERFACE IM
METHOD Read : INT
END_METHOD
END_INTERFACE
`;
    expect(messages(source, { dialect: "iec-3" })).toEqual([]);
  });
});

describe("an interface PROPERTY declares its accessors", () => {
  it("a PROPERTY with neither GET nor SET is an error", () => {
    const source = `INTERFACE IBare
PROPERTY State : INT
END_PROPERTY
END_INTERFACE
`;
    expect(messages(source, ON)).toEqual([
      "2:1 Property 'STATE' in INTERFACE 'IBARE' declares no accessor: declare GET and/or SET",
    ]);
  });

  it("an accessor with a body is an error", () => {
    const source = `INTERFACE IBody
PROPERTY State : INT
GET
  State := 1;
END_GET
END_PROPERTY
END_INTERFACE
`;
    expect(messages(source, ON)).toEqual([
      "2:1 GET of property 'STATE' in INTERFACE 'IBODY' has a body; an interface accessor is written GET END_GET",
    ]);
  });

  it("SET only is accepted", () => {
    const source = `INTERFACE IW
PROPERTY Target : REAL
SET END_SET
END_PROPERTY
END_INTERFACE
`;
    expect(messages(source, ON)).toEqual([]);
  });
});

describe("IMPLEMENTS: the FB provides each declared accessor", () => {
  it("a missing property is an error at the FB", () => {
    const fb = `FUNCTION_BLOCK FB_X IMPLEMENTS IState
PROPERTY Level : INT
GET
  Level := 1;
END_GET
SET
END_SET
END_PROPERTY
END_FUNCTION_BLOCK
`;
    expect(messages(ITF + fb, ON)).toEqual([
      "10:1 FUNCTION_BLOCK 'FB_X' implements 'ISTATE' but does not provide property 'STATE'.",
    ]);
  });

  it("a missing GET is an error at the FB's property", () => {
    const fb = `FUNCTION_BLOCK FB_X IMPLEMENTS IState
VAR n : INT; END_VAR
PROPERTY State : INT
SET
  n := State;
END_SET
END_PROPERTY
PROPERTY Level : INT
GET
  Level := 1;
END_GET
SET
END_SET
END_PROPERTY
END_FUNCTION_BLOCK
`;
    expect(messages(ITF + fb, ON)).toEqual([
      "12:1 FUNCTION_BLOCK 'FB_X' implements 'ISTATE' but its property 'STATE' has no GET accessor.",
    ]);
  });

  it("a missing SET is an error at the FB's property", () => {
    const fb = `FUNCTION_BLOCK FB_X IMPLEMENTS IState
PROPERTY State : INT
GET
  State := 1;
END_GET
END_PROPERTY
PROPERTY Level : INT
GET
  Level := 1;
END_GET
END_PROPERTY
END_FUNCTION_BLOCK
`;
    expect(messages(ITF + fb, ON)).toEqual([
      "16:1 FUNCTION_BLOCK 'FB_X' implements 'ISTATE' but its property 'LEVEL' has no SET accessor.",
    ]);
  });

  it("a different type is an error at the FB's property", () => {
    const fb = `FUNCTION_BLOCK FB_X IMPLEMENTS IState
PROPERTY State : REAL
GET
  State := 1.0;
END_GET
END_PROPERTY
PROPERTY Level : INT
GET
  Level := 1;
END_GET
SET
END_SET
END_PROPERTY
END_FUNCTION_BLOCK
`;
    expect(messages(ITF + fb, ON)).toEqual([
      "11:1 Property 'STATE' of FUNCTION_BLOCK 'FB_X' has type REAL, but 'ISTATE' declares it INT.",
    ]);
  });

  it("an FB may provide more accessors than the interface asks", () => {
    const fb = `FUNCTION_BLOCK FB_X IMPLEMENTS IState
VAR n : INT; END_VAR
PROPERTY State : INT
GET
  State := n;
END_GET
SET
  n := State;
END_SET
END_PROPERTY
PROPERTY Level : INT
GET
  Level := n;
END_GET
SET
  n := Level;
END_SET
END_PROPERTY
END_FUNCTION_BLOCK
`;
    expect(messages(ITF + fb, ON)).toEqual([]);
  });

  it("a property inherited from the base FB satisfies the contract", () => {
    const fb = `FUNCTION_BLOCK FB_Base IMPLEMENTS IState
VAR n : INT; END_VAR
PROPERTY State : INT
GET
  State := n;
END_GET
END_PROPERTY
PROPERTY Level : INT
GET
  Level := n;
END_GET
SET
  n := Level;
END_SET
END_PROPERTY
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_D EXTENDS FB_Base
PROPERTY State : INT
GET
  State := 7;
END_GET
END_PROPERTY
END_FUNCTION_BLOCK
`;
    expect(messages(ITF + fb, ON)).toEqual([]);
  });

  it("an ABSTRACT FB need not provide them", () => {
    const fb = `FUNCTION_BLOCK ABSTRACT FB_A IMPLEMENTS IState
END_FUNCTION_BLOCK
`;
    expect(messages(ITF + fb, ON)).toEqual([]);
  });

  it("properties of a base interface (EXTENDS) are part of the contract", () => {
    const source = `${ITF}INTERFACE IMore EXTENDS IState
PROPERTY Extra : BOOL
GET END_GET
END_PROPERTY
END_INTERFACE
FUNCTION_BLOCK FB_M IMPLEMENTS IMore
PROPERTY Extra : BOOL
GET
  Extra := TRUE;
END_GET
END_PROPERTY
PROPERTY State : INT
GET
  State := 1;
END_GET
END_PROPERTY
END_FUNCTION_BLOCK
`;
    expect(messages(source, ON)).toEqual([
      "15:1 FUNCTION_BLOCK 'FB_M' implements 'IMORE' but does not provide property 'LEVEL'.",
    ]);
  });
});

describe("access through an interface variable", () => {
  function program(body: string): string {
    return `${ITF}${FB_OK}PROGRAM MAIN
VAR fb : FB_S; s : IState; x : INT; END_VAR
  s := fb;
${body}
END_PROGRAM
`;
  }

  it("reads (GET) and writes (SET) are accepted", () => {
    expect(
      messages(
        program("  x := s.State;\n  s.Level := 3;\n  x := s.Level;"),
        ON,
      ),
    ).toEqual([]);
  });

  it("a write to a property the interface declares without SET is refused", () => {
    expect(messages(program("  s.State := 3;"), ON)).toEqual([
      "29:3 Property 'STATE' of INTERFACE 'ISTATE' has no SET accessor; it cannot be written through the interface.",
    ]);
  });

  it("a read of a property the interface declares without GET is refused", () => {
    const source = `INTERFACE IW
PROPERTY Target : INT
SET END_SET
END_PROPERTY
END_INTERFACE
FUNCTION_BLOCK FB_W IMPLEMENTS IW
VAR t : INT; END_VAR
PROPERTY Target : INT
SET
  t := Target;
END_SET
END_PROPERTY
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR fb : FB_W; w : IW; x : INT; END_VAR
  w := fb;
  w.Target := 2;
  x := w.Target;
END_PROGRAM
`;
    expect(messages(source, ON)).toEqual([
      "18:8 Property 'TARGET' of INTERFACE 'IW' has no GET accessor; it cannot be read through the interface.",
    ]);
  });

  it("a write through a base interface's property declared without SET is refused", () => {
    const source = `${ITF}INTERFACE IMore EXTENDS IState
END_INTERFACE
FUNCTION_BLOCK FB_M IMPLEMENTS IMore
VAR n : INT; END_VAR
PROPERTY State : INT
GET
  State := n;
END_GET
SET
  n := State;
END_SET
END_PROPERTY
PROPERTY Level : INT
GET
  Level := n;
END_GET
SET
  n := Level;
END_SET
END_PROPERTY
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR fb : FB_M; m : IMore; END_VAR
  m := fb;
  m.Level := 1;
  m.State := 2;
END_PROGRAM
`;
    expect(messages(source, ON)).toEqual([
      "35:3 Property 'STATE' of INTERFACE 'IMORE' has no SET accessor; it cannot be written through the interface.",
    ]);
  });
});

describe("FB PROPERTY is unchanged in every profile", () => {
  const source = `FUNCTION_BLOCK FB_P
VAR n : INT; END_VAR
PROPERTY Value : INT
GET
  Value := n;
END_GET
SET
  n := Value;
END_SET
END_PROPERTY
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR p : FB_P; x : INT; END_VAR
  p.Value := 4;
  x := p.Value;
END_PROGRAM
`;
  const modes: { name: string; options: Options }[] = [
    { name: "no dialect", options: {} },
    { name: "iec-3", options: { dialect: "iec-3" } },
    { name: "+property", options: ON },
  ];
  for (const mode of modes) {
    it(`is accepted under ${mode.name}`, () => {
      expect(messages(source, mode.options)).toEqual([]);
    });
  }
});
