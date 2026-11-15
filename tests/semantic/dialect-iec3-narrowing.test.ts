/**
 * Vendor forms the compiler accepted before profiles: each is a dialect
 * feature in the default set and off in `iec-3`. Accepted with no dialect
 * flag, refused at the construct under `iec-3` (in sources and in test
 * files), accepted again under `iec-3` with `--feature +<id>`.
 */
import { describe, it, expect } from "vitest";
import { compile, type CompileOptions } from "../../src/index.js";
import { parseTestFile } from "../../src/testing/test-parser.js";
import { analyzeTestFile } from "../../src/semantic/analyzer.js";
import { resolveDialect } from "../../src/dialect.js";

interface Case {
  name: string;
  feature: string;
  /** Each refusal as `line:column: message`, in source order. */
  refusals: string[];
  source: string;
}

const CASES: Case[] = [
  {
    name: "PROPERTY in a FUNCTION_BLOCK",
    feature: "fb_property",
    refusals: [
      "3:1: PROPERTY in a FUNCTION_BLOCK needs the feature fb_property",
    ],
    source: `FUNCTION_BLOCK FB_A
VAR v : INT; END_VAR
PROPERTY P : INT
GET P := v; END_GET
SET v := P; END_SET
END_PROPERTY
END_FUNCTION_BLOCK
PROGRAM Main
VAR f : FB_A; x : INT; END_VAR
f.P := 3;
x := f.P;
END_PROGRAM
`,
  },
  {
    name: "ACTION in a FUNCTION_BLOCK and at top level",
    feature: "st_actions",
    refusals: [
      "3:1: ACTION needs the feature st_actions",
      "6:1: ACTION needs the feature st_actions",
    ],
    source: `FUNCTION_BLOCK FB_A
VAR_OUTPUT n : INT; END_VAR
ACTION Bump: n := n + 1; END_ACTION
Bump();
END_FUNCTION_BLOCK
ACTION FB_A.Bump2: n := n + 2; END_ACTION
PROGRAM Main
VAR f : FB_A; END_VAR
f.Bump();
f.Bump2();
END_PROGRAM
`,
  },
  {
    name: "ACTION in a PROGRAM",
    feature: "st_actions",
    refusals: ["4:1: ACTION needs the feature st_actions"],
    source: `PROGRAM Main
VAR n : INT; END_VAR
Count();
ACTION Count: n := n + 1; END_ACTION
END_PROGRAM
`,
  },
  {
    name: "bare THIS^ and the SUPER^ forms",
    feature: "bare_self_caret",
    refusals: [
      "11:8: THIS^ needs the feature bare_self_caret",
      "12:8: SUPER^ needs the feature bare_self_caret",
      "13:8: SUPER^ needs the feature bare_self_caret",
      "14:9: SUPER^ needs the feature bare_self_caret",
      "15:3: SUPER^ needs the feature bare_self_caret",
      "17:1: SUPER^ needs the feature bare_self_caret",
    ],
    source: `INTERFACE I_A
METHOD M : INT END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB_B IMPLEMENTS I_A
VAR x : INT; END_VAR
METHOD M : INT M := 1; END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_C EXTENDS FB_B
VAR i : I_A; k : INT; END_VAR
METHOD OVERRIDE M : INT
  i := THIS^;
  M := SUPER^.M() + 1;
  k := SUPER^.x;
  SUPER^.x := 3;
  SUPER^.M();
END_METHOD
SUPER^();
END_FUNCTION_BLOCK
PROGRAM Main
VAR f : FB_C; END_VAR
f();
END_PROGRAM
`,
  },
  {
    name: "an enumeration value written E.M",
    feature: "enum_dot_qualify",
    refusals: [
      "1:31: E_S.RUNNING needs the feature enum_dot_qualify; write E_S#RUNNING",
      "2:31: E_S.IDLE needs the feature enum_dot_qualify; write E_S#IDLE",
      "4:16: E_S.IDLE needs the feature enum_dot_qualify; write E_S#IDLE",
      "5:8: E_S.IDLE needs the feature enum_dot_qualify; write E_S#IDLE",
      "5:27: E_S.RUNNING needs the feature enum_dot_qualify; write E_S#RUNNING",
      "6:11: E_S.IDLE needs the feature enum_dot_qualify; write E_S#IDLE",
    ],
    source: `TYPE E_S : (Idle, Running) := E_S.Running; END_TYPE
TYPE ST_A : STRUCT s : E_S := E_S.Idle; END_STRUCT END_TYPE
PROGRAM Main
VAR s : E_S := E_S.Idle; a : ST_A; END_VAR
IF s = E_S.Idle THEN s := E_S.Running; END_IF;
CASE s OF E_S.Idle: s := E_S#Running; END_CASE;
END_PROGRAM
`,
  },
  {
    name: "= and <> of two STRUCT values",
    feature: "struct_compare",
    refusals: [
      "4:6: = of two STRUCT values needs the feature struct_compare",
      "5:4: <> of two STRUCT values needs the feature struct_compare",
      "7:6: = of two STRUCT values needs the feature struct_compare",
    ],
    source: `TYPE ST_P : STRUCT a : INT; b : INT; END_STRUCT END_TYPE
PROGRAM Main
VAR p, q : ST_P; e : BOOL; r1, r2 : REF_TO ST_P; END_VAR
e := p = q;
IF p <> q THEN e := TRUE; END_IF;
r1 := REF(p); r2 := REF(q);
e := r1^ = r2^;
e := p.a = q.a;
END_PROGRAM
`,
  },
  {
    name: "__NEW and __DELETE",
    feature: "dynamic_memory",
    refusals: [
      "3:6: __NEW needs the feature dynamic_memory",
      "4:1: __DELETE needs the feature dynamic_memory",
    ],
    source: `PROGRAM Main
VAR p : REF_TO INT; END_VAR
p := __NEW(INT);
__DELETE(p);
END_PROGRAM
`,
  },
  {
    name: "VAR_INST in a METHOD",
    feature: "var_inst",
    refusals: ["3:1: VAR_INST needs the feature var_inst"],
    source: `FUNCTION_BLOCK FB_A
METHOD M : INT
VAR_INST n : INT; END_VAR
n := n + 1;
M := n;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main
VAR f : FB_A; x : INT; END_VAR
x := f.M();
END_PROGRAM
`,
  },
];

/** The errors as `line:column: message`, in source order. */
const located = (opts: Partial<CompileOptions>, src: string): string[] =>
  [...compile(src, opts).errors]
    .sort((a, b) => a.line - b.line || a.column - b.column)
    .map((e) => `${e.line}:${e.column}: ${e.message}`);

describe.each(CASES)("$name", (c) => {
  it("compiles with no dialect flag", () => {
    const result = compile(c.source);
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
  });

  it("is refused under iec-3 at the construct", () => {
    expect(located({ dialect: "iec-3" }, c.source)).toEqual(c.refusals);
  });

  it("is accepted under iec-3 with the feature turned on", () => {
    const result = compile(c.source, {
      dialect: "iec-3",
      features: [`+${c.feature}`],
    });
    expect(result.errors).toEqual([]);
  });

  it("is refused with no dialect flag when the feature is turned off", () => {
    const messages = compile(c.source, {
      features: [`-${c.feature}`],
    }).errors.map((e) => e.message);
    expect(messages).toContain(c.refusals[0]!.replace(/^\d+:\d+: /, ""));
  });
});

describe("the default set and iec-3", () => {
  const NEW = [
    "fb_property",
    "st_actions",
    "bare_self_caret",
    "enum_dot_qualify",
    "struct_compare",
    "dynamic_memory",
    "var_inst",
  ];

  it("has every new feature in the default set and none in iec-3", () => {
    const def = resolveDialect({}).features;
    const iec = resolveDialect({ dialect: "iec-3" }).features;
    for (const f of NEW) {
      expect(def.has(f as never), f).toBe(true);
      expect(iec.has(f as never), f).toBe(false);
    }
  });

  it("keeps an INTERFACE PROPERTY refused with no dialect flag", () => {
    const src = `INTERFACE I_A
PROPERTY P : INT
GET END_GET
END_PROPERTY
END_INTERFACE
`;
    expect(compile(src).errors.map((e) => e.message)).toContain(
      "PROPERTY in an INTERFACE needs the feature property",
    );
  });
});

describe("enumeration dot form", () => {
  it("keeps E#M accepted under iec-3", () => {
    const src = `TYPE E_S : (Idle, Running) := E_S#Running; END_TYPE
PROGRAM Main
VAR s : E_S := E_S#Idle; END_VAR
IF s = E_S#Idle THEN s := E_S#Running; END_IF;
END_PROGRAM
`;
    expect(compile(src, { dialect: "iec-3" }).errors).toEqual([]);
  });

  it("reads a member of a variable that is no enumeration as before", () => {
    const src = `TYPE E_S : (Idle, Running); END_TYPE
TYPE ST_A : STRUCT Idle : INT; END_STRUCT END_TYPE
PROGRAM Main
VAR st : ST_A; x : INT; END_VAR
x := st.Idle;
END_PROGRAM
`;
    expect(compile(src, { dialect: "iec-3" }).errors).toEqual([]);
  });
});

describe("STRUCT comparison", () => {
  it("leaves a comparison of two POINTER TO or REF_TO a STRUCT accepted", () => {
    const src = `TYPE ST_A : STRUCT x : INT; END_STRUCT END_TYPE
PROGRAM Main
VAR s : ST_A; ps, ps2 : POINTER TO ST_A; rs1, rs2 : REF_TO ST_A; b : BOOL; END_VAR
ps := ADR(s); ps2 := ADR(s); rs1 := REF(s); rs2 := REF(s);
b := ps = ps2 AND ps <> 0 AND rs1 = rs2 AND rs1 <> NULL;
b := ps^ = s;
END_PROGRAM
`;
    expect(
      located({ dialect: "iec-3", features: ["+pointer_to"] }, src),
    ).toEqual(["6:6: = of two STRUCT values needs the feature struct_compare"]);
  });
});

describe("ADR inside an array index", () => {
  const SRC = `PROGRAM Main
VAR x : INT; a : ARRAY[0..10] OF INT; v : INT := a[ADR(x)]; END_VAR
x := a[ADR(x)];
a[ADR(x)] := 1;
x := a[a[ADR(x)]];
END_PROGRAM
`;

  it("is refused under iec-3 in a statement and an initial value", () => {
    expect(located({ dialect: "iec-3" }, SRC)).toEqual([
      "2:52: ADR needs the feature pointer_to",
      "3:8: ADR needs the feature pointer_to",
      "4:3: ADR needs the feature pointer_to",
      "5:10: ADR needs the feature pointer_to",
    ]);
  });

  it("is not refused with pointer_to on", () => {
    const messages = compile(SRC).errors.map((e) => e.message);
    expect(messages).not.toContain("ADR needs the feature pointer_to");
  });

  it("is not refused where a user FUNCTION is named ADR", () => {
    const src = `FUNCTION ADR : INT
VAR_INPUT v : INT; END_VAR
ADR := 0;
END_FUNCTION
PROGRAM Main
VAR x : INT; a : ARRAY[0..10] OF INT; END_VAR
x := a[ADR(x)];
END_PROGRAM
`;
    expect(compile(src, { dialect: "iec-3" }).errors).toEqual([]);
  });
});

/** Errors of a test file run against `source`, both under `opts`, as `line:column: message`. */
function testFileErrors(
  source: string,
  test: string,
  opts: Partial<CompileOptions>,
): string[] {
  const src = compile(source, opts);
  expect(src.errors).toEqual([]);
  const parsed = parseTestFile(test, "t.st", opts);
  expect(parsed.errors).toEqual([]);
  const dialect = resolveDialect(opts);
  return analyzeTestFile(
    parsed.testFile!,
    src.symbolTables!,
    src.ast,
    dialect,
  ).errors.map((e) => `${e.line}:${e.column}: ${e.message}`);
}

describe("test files follow the dialect", () => {
  const TYPES = `TYPE E_S : (Idle, Running); END_TYPE
TYPE ST_P : STRUCT a : INT; b : INT; END_STRUCT END_TYPE
PROGRAM Main
VAR x : INT; END_VAR
x := 1;
END_PROGRAM
`;
  const TESTS: Array<{ feature: string; test: string; refusals: string[] }> = [
    {
      feature: "enum_dot_qualify",
      test: `TEST 'enum'
VAR s : E_S := E_S.Running; END_VAR
s := E_S.Idle;
ASSERT_TRUE(s = E_S.Idle);
END_TEST
`,
      refusals: [
        "2:16: E_S.RUNNING needs the feature enum_dot_qualify; write E_S#RUNNING",
        "3:6: E_S.IDLE needs the feature enum_dot_qualify; write E_S#IDLE",
        "4:17: E_S.IDLE needs the feature enum_dot_qualify; write E_S#IDLE",
      ],
    },
    {
      feature: "struct_compare",
      test: `TEST 'cmp'
VAR p, q : ST_P; e : BOOL; END_VAR
e := p = q;
ASSERT_FALSE(p <> q);
END_TEST
`,
      refusals: [
        "3:6: = of two STRUCT values needs the feature struct_compare",
        "4:14: <> of two STRUCT values needs the feature struct_compare",
      ],
    },
    {
      feature: "dynamic_memory",
      test: `TEST 'dyn'
VAR p : REF_TO INT; END_VAR
p := __NEW(INT);
__DELETE(p);
END_TEST
`,
      refusals: [
        "3:6: __NEW needs the feature dynamic_memory",
        "4:1: __DELETE needs the feature dynamic_memory",
      ],
    },
    {
      feature: "pointer_to",
      test: `TEST 'adr'
VAR x : INT; a : ARRAY[0..10] OF INT; END_VAR
x := a[ADR(x)];
END_TEST
`,
      refusals: ["3:8: ADR needs the feature pointer_to"],
    },
  ];

  describe.each(TESTS)("$feature", (t) => {
    it("is refused in a test file under iec-3", () => {
      expect(testFileErrors(TYPES, t.test, { dialect: "iec-3" })).toEqual(
        t.refusals,
      );
    });

    it("is accepted in a test file with no dialect flag", () => {
      expect(testFileErrors(TYPES, t.test, {})).toEqual([]);
    });

    it("is accepted in a test file under iec-3 with the feature on", () => {
      expect(
        testFileErrors(TYPES, t.test, {
          dialect: "iec-3",
          features: [`+${t.feature}`],
        }),
      ).toEqual([]);
    });
  });

  // A TEST body declares no POU: these forms reach a --test run through its sources.
  const USES: Array<{ feature: string; source: string; test: string }> = [
    {
      feature: "fb_property",
      source: CASES[0]!.source,
      test: "TEST 'p'\nVAR f : FB_A; END_VAR\nf.P := 3;\nASSERT_EQ(f.P, 3);\nEND_TEST\n",
    },
    {
      feature: "st_actions",
      source: CASES[1]!.source,
      test: "TEST 'a'\nVAR f : FB_A; END_VAR\nf.Bump();\nASSERT_EQ(f.n, 1);\nEND_TEST\n",
    },
    {
      feature: "bare_self_caret",
      source: CASES[3]!.source,
      test: "TEST 'c'\nVAR f : FB_C; END_VAR\nf();\nASSERT_EQ(f.M(), 2);\nEND_TEST\n",
    },
    {
      feature: "var_inst",
      source: CASES[7]!.source,
      test: "TEST 'v'\nVAR f : FB_A; x : INT; END_VAR\nx := f.M();\nASSERT_EQ(x, 1);\nEND_TEST\n",
    },
  ];

  describe.each(USES)("$feature", (u) => {
    it("refuses the sources of a test run under iec-3", () => {
      const messages = compile(u.source, { dialect: "iec-3" }).errors.map(
        (e) => e.message,
      );
      expect(messages.some((m) => m.endsWith(`feature ${u.feature}`))).toBe(
        true,
      );
    });

    it("analyses the test file clean with no flag and with the feature on", () => {
      expect(testFileErrors(u.source, u.test, {})).toEqual([]);
      expect(
        testFileErrors(u.source, u.test, {
          dialect: "iec-3",
          features: [`+${u.feature}`],
        }),
      ).toEqual([]);
    });
  });
});
