/**
 * Named arguments of a function block instance call (`inst(a := 1)`,
 * `outer.sub(a := 1)`, `outer.m.sub(a := 1)`) must name a member of the
 * block: the C++ assigns `inst.NAME`, which does not build otherwise. VAR
 * locals still bind (the C++ builds), and library blocks are not checked.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

type Options = Parameters<typeof compile>[1];

const MODES: { name: string; options: Options }[] = [
  { name: "no dialect", options: {} },
  { name: "iec-3", options: { dialect: "iec-3" } },
];

const TYPES = `FUNCTION_BLOCK FB_Sub
VAR_INPUT a : INT; END_VAR
VAR_OUTPUT q : INT; END_VAR
VAR_IN_OUT io : INT; END_VAR
VAR loc : INT; END_VAR
q := a;
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_SubX EXTENDS FB_Sub
VAR_INPUT b : INT; END_VAR
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Mid
VAR sub : FB_Sub; subx : FB_SubX; END_VAR
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Outer
VAR sub : FB_Sub; m : FB_Mid; END_VAR
END_FUNCTION_BLOCK
`;

/** Line of the first body statement in {@link program}. */
const BODY_LINE = TYPES.split("\n").length + 2;

function program(body: string): string {
  return `${TYPES}PROGRAM MAIN
VAR s : FB_Sub; sx : FB_SubX; o : FB_Outer; v : INT; r : INT; END_VAR
${body}
END_PROGRAM
`;
}

function messages(source: string, options: Options = {}): string[] {
  return compile(source, options).errors.map(
    (e) => `${e.line}:${e.column} ${e.message}`,
  );
}

describe("unknown named arguments on FB instance calls are refused", () => {
  for (const mode of MODES) {
    it(`plain call s(zz := 3) (${mode.name})`, () => {
      expect(messages(program("s(zz := 3, io := v);"), mode.options)).toEqual([
        `${BODY_LINE}:3 FB_SUB has no input or output named ZZ`,
      ]);
    });

    it(`member call o.sub(zz := 3) (${mode.name})`, () => {
      expect(
        messages(program("o.sub(zz := 3, io := v);"), mode.options),
      ).toEqual([`${BODY_LINE}:7 FB_SUB has no input or output named ZZ`]);
    });

    it(`chain call o.m.sub(zz := 3) (${mode.name})`, () => {
      expect(
        messages(program("o.m.sub(zz := 3, io := v);"), mode.options),
      ).toEqual([`${BODY_LINE}:9 FB_SUB has no input or output named ZZ`]);
    });

    it(`an unknown output binding o.sub(zz => r) (${mode.name})`, () => {
      expect(
        messages(program("o.sub(io := v, zz => r);"), mode.options),
      ).toEqual([`${BODY_LINE}:16 FB_SUB has no input or output named ZZ`]);
    });
  }

  it("reports once under --strict", () => {
    expect(messages(program("s(zz := 3, io := v);"), { strict: true })).toEqual(
      [`${BODY_LINE}:3 FB_SUB has no input or output named ZZ`],
    );
  });
});

describe("named arguments that name a member stay accepted", () => {
  for (const mode of MODES) {
    it(`inputs, outputs and in/outs, own and inherited (${mode.name})`, () => {
      expect(
        messages(
          program(
            [
              "s(a := 1, io := v, q => r);",
              "sx(a := 1, b := 2, io := v, q => r);",
              "o.sub(a := 1, io := v, q => r);",
              "o.m.subx(b := 2, a := 1, io := v);",
              "s(EN := TRUE, a := 1, io := v);",
            ].join("\n"),
          ),
          mode.options,
        ),
      ).toEqual([]);
    });

    it(`a VAR local still binds by name (${mode.name})`, () => {
      expect(
        messages(
          program("s(loc := 1, io := v);\no.m.sub(loc := 2, io := v);"),
          mode.options,
        ),
      ).toEqual([]);
    });
  }
});
