/**
 * Enumeration base type written after the value list:
 * `TYPE Mode : (A := 0, B := 1) DINT; END_TYPE`. IEC puts the base type
 * before the list; the postfix order needs the feature postfix_enum_base,
 * which no default set or `iec-3` enables. With it on, the declaration means
 * the same as the base-first form.
 */
import { describe, it, expect } from "vitest";
import { compile, parse } from "../../src/index.js";
import type { DialectProfile } from "../../src/dialect.js";

const POSTFIX_PROFILE: DialectProfile = {
  id: "postfix",
  name: "postfix",
  extends: "iec-3",
  features: ["postfix_enum_base"],
  semantics: {},
};

type Options = Parameters<typeof compile>[1];

const MODES: { name: string; options: Options }[] = [
  { name: "no dialect", options: {} },
  { name: "iec-3", options: { dialect: "iec-3" } },
];

const MESSAGE =
  "an enum base type written after the value list needs the feature postfix_enum_base";

/** A program using `Mode`; `decl` is the body of the TYPE block, on line 2. */
function program(decl: string): string {
  return `TYPE
${decl}
END_TYPE
PROGRAM P
VAR m : Mode; n : DINT; END_VAR
  m := Mode#B;
  n := 1;
END_PROGRAM
`;
}

function messages(source: string, options: Options = {}): string[] {
  return compile(source, options).errors.map(
    (e) => `${e.line}:${e.column} ${e.message}`,
  );
}

/** The AST of `source` with every source span removed. */
function shape(source: string): unknown {
  const result = parse(source);
  expect(result.errors).toEqual([]);
  return JSON.parse(
    JSON.stringify(result.ast?.types ?? [], (key: string, value: unknown) =>
      key === "sourceSpan" ? undefined : value,
    ),
  );
}

/** `shape` without the postfix marker. */
function shapeWithoutMarker(source: string): unknown {
  return JSON.parse(
    JSON.stringify(shape(source), (key: string, value: unknown) =>
      key === "postfixBase" ? undefined : value,
    ),
  );
}

describe("the postfix enum base needs the feature postfix_enum_base", () => {
  for (const mode of MODES) {
    it(`is refused at the base type (${mode.name})`, () => {
      expect(
        messages(program("Mode : (A := 0, B := 1) DINT;"), mode.options),
      ).toEqual([`2:25 ${MESSAGE}`]);
    });

    it(`is refused with a default (${mode.name})`, () => {
      expect(
        messages(program("Mode : (A := 0, B := 1) DINT := B;"), mode.options),
      ).toEqual([`2:25 ${MESSAGE}`]);
    });

    it(`is refused without member values (${mode.name})`, () => {
      expect(messages(program("Mode : (A, B) INT;"), mode.options)).toEqual([
        `2:15 ${MESSAGE}`,
      ]);
    });
  }

  it("names the loaded profiles that have it", () => {
    expect(
      messages(program("Mode : (A := 0, B := 1) DINT;"), {
        dialect: "iec-3",
        dialectFiles: ["postfix.json"],
        dialectIO: {
          readFile: () => JSON.stringify(POSTFIX_PROFILE),
          listDir: () => [],
        },
      }),
    ).toEqual([`2:25 ${MESSAGE} (profiles: postfix)`]);
  });

  it("is accepted with +postfix_enum_base", () => {
    for (const mode of MODES) {
      expect(
        messages(program("Mode : (A := 0, B := 1) DINT;"), {
          ...mode.options,
          features: ["+postfix_enum_base"],
        }),
      ).toEqual([]);
    }
  });

  it("is accepted through a profile object", () => {
    expect(
      messages(program("Mode : (A := 0, B := 1) DINT := B;"), {
        dialect: POSTFIX_PROFILE,
      }),
    ).toEqual([]);
  });
});

describe("the postfix form means the same as the base-first form", () => {
  const pairs: { name: string; postfix: string; prefix: string }[] = [
    {
      name: "DINT with values",
      postfix: "Mode : (A := 0, B := 1) DINT;",
      prefix: "Mode : DINT (A := 0, B := 1);",
    },
    {
      name: "INT without values",
      postfix: "Mode : (A, B) INT;",
      prefix: "Mode : INT (A, B);",
    },
    {
      name: "USINT with a default",
      postfix: "Mode : (A := 1, B := 7) USINT := B;",
      prefix: "Mode : USINT (A := 1, B := 7) := B;",
    },
    {
      name: "no semicolon before the next declaration",
      postfix: "Mode : (A := 0, B := 1) DINT\nOther : INT;",
      prefix: "Mode : DINT (A := 0, B := 1)\nOther : INT;",
    },
  ];
  const on: Options = { features: ["+postfix_enum_base"] };

  for (const pair of pairs) {
    it(`same AST, marker aside (${pair.name})`, () => {
      expect(shapeWithoutMarker(program(pair.postfix))).toEqual(
        shape(program(pair.prefix)),
      );
    });

    it(`same C++ (${pair.name})`, () => {
      const postfix = compile(program(pair.postfix), on);
      const prefix = compile(program(pair.prefix));
      expect(postfix.errors).toEqual([]);
      expect(prefix.errors).toEqual([]);
      expect(postfix.headerCode).toBe(prefix.headerCode);
      expect(postfix.cppCode).toBe(prefix.cppCode);
    });
  }

  it("marks only the postfix form", () => {
    expect(
      JSON.stringify(shape(program("Mode : (A := 0, B := 1) DINT;"))),
    ).toContain('"postfixBase":true');
    expect(
      JSON.stringify(shape(program("Mode : DINT (A := 0, B := 1);"))),
    ).not.toContain("postfixBase");
  });

  it("emits the base as the C++ underlying type", () => {
    const result = compile(program("Mode : (A := 0, B := 1) DINT;"), on);
    expect(result.headerCode).toContain(
      "enum class MODE : DINT_t { A = 0, B = 1 };",
    );
  });
});

describe("forms accepted today are unchanged in every profile", () => {
  const forms: { name: string; decl: string }[] = [
    { name: "base first", decl: "Mode : DINT (A := 0, B := 1);" },
    { name: "base first with a default", decl: "Mode : INT (A, B) := B;" },
    { name: "no base", decl: "Mode : (A := 0, B := 1);" },
    { name: "no base with a default", decl: "Mode : (A, B) := B;" },
    {
      name: "no base, no semicolon, next declaration",
      decl: "Mode : (A, B)\nOther : INT;",
    },
  ];
  for (const mode of MODES) {
    for (const form of forms) {
      it(`${form.name} (${mode.name})`, () => {
        expect(messages(program(form.decl), mode.options)).toEqual([]);
      });
    }
  }
});
