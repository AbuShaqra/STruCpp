/**
 * Self and super forms. `SUPER.M()` and `SUPER.member` are IEC and accepted in
 * every dialect. `THIS^.member` / `THIS^.M()` need the feature self_caret,
 * which no default set or `iec-3` enables. `REF=` on a THIS member needs
 * ref_assign. Bare `THIS^` and the `SUPER^` forms stay accepted everywhere.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import type { DialectProfile } from "../../src/dialect.js";

const CARET_PROFILE: DialectProfile = {
  id: "caret",
  name: "caret",
  extends: "iec-3",
  features: ["self_caret"],
  semantics: {},
};

type Options = Parameters<typeof compile>[1];

const MODES: { name: string; options: Options }[] = [
  { name: "no dialect", options: {} },
  { name: "iec-3", options: { dialect: "iec-3" } },
];

/** Base/derived pair; `body` is the derived method body, starting on line 15. */
function hierarchy(body: string): string {
  return `FUNCTION_BLOCK FB_Base
VAR x : INT; END_VAR
METHOD M : INT
  M := 1;
END_METHOD
METHOD Twice : INT
VAR_INPUT k : INT; END_VAR
  Twice := k * 2;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_D EXTENDS FB_Base
VAR y : INT; END_VAR
METHOD OVERRIDE M : INT
VAR t : INT; END_VAR
${body}
  M := 2;
END_METHOD
END_FUNCTION_BLOCK
`;
}

function messages(source: string, options: Options = {}): string[] {
  return compile(source, options).errors.map(
    (e) => `${e.line}:${e.column} ${e.message}`,
  );
}

describe("SUPER. is IEC and accepted in every dialect", () => {
  const forms: { name: string; body: string }[] = [
    { name: "SUPER.M() in an expression", body: "  y := SUPER.M();" },
    { name: "SUPER.M() as a statement", body: "  SUPER.M();" },
    { name: "SUPER.M with arguments", body: "  y := SUPER.Twice(k := 3);" },
    { name: "SUPER.member", body: "  y := SUPER.x;" },
  ];
  for (const mode of MODES) {
    for (const form of forms) {
      it(`${form.name} (${mode.name})`, () => {
        expect(messages(hierarchy(form.body), mode.options)).toEqual([]);
      });
    }
  }

  it("SUPER.M() calls the base implementation in the generated C++", () => {
    const result = compile(hierarchy("  y := SUPER.M();\n  SUPER.M();"));
    expect(result.errors).toEqual([]);
    expect(result.cppCode).toMatch(/FB_BASE::M\(\)/);
  });

  it("SUPER.M() and SUPER^.M() generate the same C++", () => {
    const dot = compile(hierarchy("  y := SUPER.M();"));
    const caret = compile(hierarchy("  y := SUPER^.M();"));
    expect(dot.errors).toEqual([]);
    expect(dot.cppCode).toBe(caret.cppCode);
  });
});

describe("THIS^.member needs the feature self_caret", () => {
  const forms: { name: string; body: string; column: number }[] = [
    { name: "a read", body: "  y := THIS^.x;", column: 8 },
    { name: "a write", body: "  THIS^.y := 5;", column: 3 },
    { name: "a method call", body: "  t := THIS^.Twice(k := 1);", column: 8 },
    { name: "a call statement", body: "  THIS^.Twice(k := 1);", column: 3 },
  ];
  const message = "THIS^.member needs the feature self_caret";

  for (const form of forms) {
    for (const mode of MODES) {
      it(`${form.name} is refused (${mode.name})`, () => {
        const found = messages(hierarchy(form.body), mode.options);
        expect(found).toEqual([`15:${form.column} ${message}`]);
      });
    }

    it(`${form.name} is accepted with --feature +self_caret`, () => {
      expect(
        messages(hierarchy(form.body), {
          dialect: "iec-3",
          features: ["+self_caret"],
        }),
      ).toEqual([]);
      expect(
        messages(hierarchy(form.body), { features: ["+self_caret"] }),
      ).toEqual([]);
    });

    it(`${form.name} is accepted under a profile with self_caret`, () => {
      expect(
        messages(hierarchy(form.body), { dialect: CARET_PROFILE }),
      ).toEqual([]);
    });

    it(`${form.name} names the loaded profiles that have the feature`, () => {
      const found = messages(hierarchy(form.body), {
        dialect: {
          id: "plain",
          name: "plain",
          extends: "iec-3",
          features: [],
          semantics: {},
        },
      });
      expect(found).toEqual([`15:${form.column} ${message}`]);
    });
  }

  it("THIS^.x and THIS.x generate the same C++", () => {
    const caret = compile(hierarchy("  y := THIS^.x;\n  THIS^.y := 4;"), {
      features: ["+self_caret"],
    });
    const dot = compile(hierarchy("  y := THIS.x;\n  THIS.y := 4;"));
    expect(caret.errors).toEqual([]);
    expect(caret.cppCode).toBe(dot.cppCode);
  });

  it("the default set leaves self_caret off", () => {
    const off = compile(hierarchy("  y := THIS^.x;"), { features: [] });
    expect(off.success).toBe(false);
  });
});

describe("REF= on a THIS member", () => {
  function refSource(target: string): string {
    return `FUNCTION_BLOCK FB_R
VAR
  v : INT;
  r : REF_TO INT;
END_VAR
METHOD Bind
  ${target} REF= v;
END_METHOD
END_FUNCTION_BLOCK
`;
  }
  const refMessage = "REF= needs the feature ref_assign";
  const caretMessage = "THIS^.member needs the feature self_caret";

  it("THIS.r REF= v compiles with no dialect flag", () => {
    expect(messages(refSource("THIS.r"))).toEqual([]);
  });

  it("THIS.r REF= v is refused under iec-3 at the statement", () => {
    expect(
      messages(refSource("THIS.r"), {
        dialect: "iec-3",
        features: ["+pointer_to"],
      }),
    ).toEqual([`7:3 ${refMessage}`]);
  });

  it("THIS.r REF= v is accepted under iec-3 with ref_assign", () => {
    expect(
      messages(refSource("THIS.r"), {
        dialect: "iec-3",
        features: ["+ref_assign"],
      }),
    ).toEqual([]);
  });

  it("THIS^.r REF= v needs self_caret as well", () => {
    expect(messages(refSource("THIS^.r"))).toEqual([`7:3 ${caretMessage}`]);
    expect(
      messages(refSource("THIS^.r"), {
        dialect: "iec-3",
      }),
    ).toEqual([`7:3 ${refMessage}`, `7:3 ${caretMessage}`]);
    expect(
      messages(refSource("THIS^.r"), { features: ["+self_caret"] }),
    ).toEqual([]);
    expect(
      messages(refSource("THIS^.r"), {
        dialect: "iec-3",
        features: ["+self_caret", "+ref_assign"],
      }),
    ).toEqual([]);
  });

  it("REF= on a THIS member that is not a reference is refused", () => {
    const src = refSource("THIS.v").replace("v REF= v", "v REF= r");
    expect(messages(src).length).toBeGreaterThan(0);
  });
});

/**
 * Pinned: what passes today keeps passing until the IEC audit decides
 * otherwise. Narrowing any of these must show up as a change here.
 */
describe("today's caret forms stay accepted in every dialect (pinned)", () => {
  const forms: { name: string; body: string }[] = [
    { name: "bare THIS^ as a value", body: "  b := THIS^;" },
    { name: "bare THIS^ as an argument", body: "  y := Take(o := THIS^);" },
    { name: "SUPER^.M() in an expression", body: "  y := SUPER^.M();" },
    { name: "SUPER^.M() as a statement", body: "  SUPER^.M();" },
    { name: "SUPER^.member", body: "  y := SUPER^.x;" },
  ];
  function source(body: string): string {
    return `FUNCTION Take : INT
VAR_INPUT o : FB_Base; END_VAR
  Take := 1;
END_FUNCTION
${hierarchy(body).replace("VAR t : INT; END_VAR", "VAR t : INT; b : FB_Base; END_VAR")}`;
  }
  for (const mode of MODES) {
    for (const form of forms) {
      it(`${form.name} (${mode.name})`, () => {
        expect(messages(source(form.body), mode.options)).toEqual([]);
      });
    }
  }

  it("SUPER^() in a function block body (no dialect)", () => {
    const src = `FUNCTION_BLOCK FB_Base
VAR n : INT; END_VAR
  n := n + 1;
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_D EXTENDS FB_Base
  SUPER^();
END_FUNCTION_BLOCK
`;
    expect(messages(src)).toEqual([]);
    expect(messages(src, { dialect: "iec-3" })).toEqual([]);
  });
});
