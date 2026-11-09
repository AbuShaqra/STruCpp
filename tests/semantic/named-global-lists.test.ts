/**
 * Named global variable lists: `GVL_A.x` reaches the global `x` declared in
 * the top-level VAR_GLOBAL blocks of the file whose list name is `GVL_A` (the
 * file stem, or the caller's `globalListName`). It needs the feature
 * named_global_lists, which no default set or `iec-3` enables.
 */
import { describe, it, expect } from "vitest";
import { analyze, compile, parse } from "../../src/index.js";
import type { DialectProfile } from "../../src/dialect.js";
import type { CompileOptions } from "../../src/types.js";
import type { Statement } from "../../src/frontend/ast.js";
import {
  defaultGlobalListName,
  listQualifiedName,
} from "../../src/semantic/global-lists.js";

const ON: Partial<CompileOptions> = { features: ["+named_global_lists"] };

const GVL_A = `VAR_GLOBAL
  x : INT := 1;
  arr : ARRAY[1..3] OF INT;
  s : ST_Pair;
  fb : FB_Add;
  ptr : POINTER TO INT;
END_VAR
VAR_GLOBAL CONSTANT
  k : INT := 7;
END_VAR
`;

const TYPES = `TYPE ST_Pair : STRUCT a : INT; b : ARRAY[0..1] OF INT; END_STRUCT; END_TYPE
FUNCTION_BLOCK FB_Add
VAR_INPUT a : INT; END_VAR
VAR_OUTPUT out : INT; END_VAR
out := a + 1;
END_FUNCTION_BLOCK
`;

type Source = { source: string; fileName: string; globalListName?: string };

/** Options compiling `main` (main.st) together with `extra` files. */
function withFiles(
  extra: Source[],
  options: Partial<CompileOptions> = {},
): Partial<CompileOptions> {
  return { fileName: "main.st", additionalSources: extra, ...options };
}

function run(
  main: string,
  extra: Source[] = [{ source: GVL_A, fileName: "GVL_A.st" }],
  options: Partial<CompileOptions> = {},
) {
  return compile(TYPES + main, withFiles(extra, options));
}

function messages(
  main: string,
  extra: Source[] = [{ source: GVL_A, fileName: "GVL_A.st" }],
  options: Partial<CompileOptions> = {},
): string[] {
  return run(main, extra, options).errors.map(
    (e) => `${e.line}:${e.column} ${e.message}`,
  );
}

/** A PROGRAM `P` with `vars` declared and `body` as its statements. */
function prog(body: string, vars = ""): string {
  return `PROGRAM P
VAR ${vars} END_VAR
${body}
END_PROGRAM
`;
}

/** The statements of program P with spans removed, after analysis. */
function analyzedBody(
  main: string,
  extra: Source[],
  options: Partial<CompileOptions>,
): unknown {
  const result = analyze(TYPES + main, withFiles(extra, options));
  expect(result.errors).toEqual([]);
  const body: Statement[] =
    result.ast?.programs.find((p) => p.name === "P")?.body ?? [];
  return JSON.parse(
    JSON.stringify(body, (key: string, value: unknown) =>
      key === "sourceSpan" ||
      key === "methodNameSpan" ||
      key === "globalList" ||
      key === "resolvedType"
        ? undefined
        : value,
    ),
  );
}

describe("list names", () => {
  it("default to the file stem", () => {
    expect(defaultGlobalListName("GVL_A.st")).toBe("GVL_A");
    expect(defaultGlobalListName("dir/sub/GVL_B.ST")).toBe("GVL_B");
    expect(defaultGlobalListName("C:\\proj\\Gvl.Motors.st")).toBe("Gvl.Motors");
    expect(defaultGlobalListName("NoExt")).toBe("NoExt");
  });

  it("the internal list-qualified name holds a double underscore", () => {
    expect(listQualifiedName("Gvl_a", "x")).toBe("GVL_A__X");
  });

  it("an invalid globalListName is refused by the API", () => {
    expect(() =>
      compile(prog(""), { globalListName: "not-an-identifier" }),
    ).toThrow(/globalListName "not-an-identifier" is not an identifier/);
    expect(() =>
      compile(prog(""), {
        additionalSources: [
          { source: GVL_A, fileName: "a.st", globalListName: "1x" },
        ],
      }),
    ).toThrow(/globalListName "1x" is not an identifier/);
  });
});

describe("feature off", () => {
  const MODES: { name: string; options: Partial<CompileOptions> }[] = [
    { name: "no dialect", options: {} },
    { name: "iec-3", options: { dialect: "iec-3", features: ["+pointer_to"] } },
  ];

  for (const { name, options } of MODES) {
    it(`${name}: a qualified access names the feature, at the access`, () => {
      expect(
        messages(prog("v := GVL_A.x;", "v : INT;"), undefined, options),
      ).toEqual([
        "9:6 Global variable list access 'GVL_A.X' needs the feature named_global_lists",
      ]);
    });

    it(`${name}: a genuinely undeclared name still says undeclared`, () => {
      expect(
        messages(prog("v := GVL_Z.x;", "v : INT;"), undefined, options),
      ).toEqual(["9:6 Undeclared variable 'GVL_Z'"]);
    });

    it(`${name}: unqualified access is unchanged`, () => {
      expect(
        messages(prog("v := x; arr[1] := k;", "v : INT;"), undefined, options),
      ).toEqual([]);
    });

    it(`${name}: two lists declaring one name keep today's error`, () => {
      expect(
        messages(
          prog(""),
          [
            {
              source: "VAR_GLOBAL x : INT := 1; END_VAR",
              fileName: "GVL_A.st",
            },
            {
              source: "VAR_GLOBAL x : INT := 2; END_VAR",
              fileName: "GVL_B.st",
            },
          ],
          options,
        ),
      ).toEqual(["1:12 Symbol 'X' already defined in scope 'global'"]);
    });
  }

  it("names a profile that has the feature", () => {
    const profile: DialectProfile = {
      id: "lists",
      name: "lists",
      features: ["named_global_lists"],
      semantics: {},
    };
    const result = run(prog("v := GVL_A.x;", "v : INT;"), undefined, {
      dialect: "iec-3",
      features: ["+pointer_to"],
      dialectFiles: ["lists.json"],
      dialectIO: { readFile: () => JSON.stringify(profile), listDir: () => [] },
    });
    expect(result.errors.map((e) => e.message)).toEqual([
      "Global variable list access 'GVL_A.X' needs the feature named_global_lists (profiles: lists)",
    ]);
  });
});

describe("qualified access", () => {
  it("reads, writes and chains compile with no error", () => {
    const body = `GVL_A.x := GVL_A.x + 1;
gvl_a.arr[2] := GVL_A.k;
GVL_A.s.a := GVL_A.s.b[1];
GVL_A.fb(a := GVL_A.x);
v := GVL_A.fb.out;
GVL_A.ptr := ADR(GVL_A.x);
GVL_A.ptr^ := 3;
v := GVL_A.ptr^;`;
    expect(messages(prog(body, "v : INT;"), undefined, ON)).toEqual([]);
  });

  it("rewrites to exactly the AST of the unqualified access", () => {
    const qualified = `GVL_A.x := GVL_A.x + 1;
GVL_A.arr[2] := GVL_A.k;
GVL_A.s.b[1] := GVL_A.s.a;
GVL_A.fb(a := GVL_A.x);
v := GVL_A.fb.out;
GVL_A.ptr^ := 3;`;
    const plain = qualified.replace(/GVL_A\./g, "");
    const extra = [{ source: GVL_A, fileName: "GVL_A.st" }];
    expect(analyzedBody(prog(qualified, "v : INT;"), extra, ON)).toEqual(
      analyzedBody(prog(plain, "v : INT;"), extra, ON),
    );
  });

  it("generates the same C++ as the unqualified access", () => {
    const qualified = `GVL_A.x := GVL_A.x + 1; GVL_A.arr[2] := GVL_A.k;
GVL_A.fb(a := GVL_A.x); v := GVL_A.fb.out; GVL_A.s.b[0] := GVL_A.s.a;`;
    const a = run(prog(qualified, "v : INT;"), undefined, ON);
    const b = run(prog(qualified.replace(/GVL_A\./g, ""), "v : INT;"));
    expect(a.errors).toEqual([]);
    expect(a.cppCode).toBe(b.cppCode);
    expect(a.headerCode).toBe(b.headerCode);
  });

  it("works in functions, FB bodies, methods and properties", () => {
    const main = `FUNCTION F : INT
F := GVL_A.x;
END_FUNCTION
FUNCTION_BLOCK FB_U
VAR_OUTPUT o : INT; END_VAR
METHOD M : INT
M := GVL_A.k;
END_METHOD
PROPERTY Pr : INT
GET
Pr := GVL_A.arr[1];
END_GET
END_PROPERTY
o := GVL_A.x;
END_FUNCTION_BLOCK
${prog("GVL_A.x := F();")}`;
    expect(messages(main, undefined, ON)).toEqual([]);
  });

  it("a variable the list does not declare is an error", () => {
    expect(
      messages(prog("v := GVL_A.nope;", "v : INT;"), undefined, ON),
    ).toEqual(["9:6 'NOPE' is not a variable of global variable list 'GVL_A'"]);
  });

  it("a write to a constant of the list is refused", () => {
    const errs = messages(prog("GVL_A.k := 1;"), undefined, ON);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join("\n")).toMatch(/constant/i);
  });

  it("the type of a qualified access is the global's", () => {
    const errs = messages(prog("t := GVL_A.x;", "t : TIME;"), undefined, ON);
    expect(errs.join("\n")).toMatch(/INT/);
  });

  it("a caller-given list name replaces the stem", () => {
    const extra = [
      { source: GVL_A, fileName: "GVL_A.st", globalListName: "Plant" },
    ];
    expect(messages(prog("v := Plant.x;", "v : INT;"), extra, ON)).toEqual([]);
    expect(messages(prog("v := GVL_A.x;", "v : INT;"), extra, ON)).toEqual([
      "9:6 Undeclared variable 'GVL_A'",
    ]);
  });

  it("the primary file's globals form a list too", () => {
    const result = compile(
      `VAR_GLOBAL g : INT; END_VAR
PROGRAM P VAR v : INT; END_VAR v := Cell_1.g; END_PROGRAM`,
      {
        fileName: "lib/Cell_1.st",
        ...ON,
      },
    );
    expect(result.errors).toEqual([]);
    const named = compile(
      `VAR_GLOBAL g : INT; END_VAR
PROGRAM P VAR v : INT; END_VAR v := Main_Cell.g; END_PROGRAM`,
      {
        fileName: "x.st",
        globalListName: "Main_Cell",
        ...ON,
      },
    );
    expect(named.errors).toEqual([]);
  });

  it("two files with the same list name are an error", () => {
    expect(
      messages(
        prog(""),
        [
          { source: "VAR_GLOBAL a : INT; END_VAR", fileName: "one/GVL_A.st" },
          { source: "VAR_GLOBAL b : INT; END_VAR", fileName: "two/gvl_a.st" },
        ],
        ON,
      ),
    ).toEqual([
      "1:1 Global variable list 'gvl_a' is declared in both 'one/GVL_A.st' and 'two/gvl_a.st'; give one of them another list name",
    ]);
  });
});

describe("shadowing of the list name", () => {
  it("a local variable named like the list wins", () => {
    // The local is a struct; `.a` is its field, not the list's.
    expect(
      messages(prog("GVL_A.a := 1;", "GVL_A : ST_Pair;"), undefined, ON),
    ).toEqual([]);
    expect(
      messages(prog("GVL_A.x := 1;", "GVL_A : ST_Pair;"), undefined, ON).join(),
    ).not.toMatch(/global variable list/i);
  });

  it("a POU or type named like the list wins", () => {
    const extra = [{ source: GVL_A, fileName: "ST_Pair.st" }];
    expect(messages(prog("v := ST_Pair.x;", "v : INT;"), extra, ON)).toEqual([
      "9:6 Cannot access members of type 'ST_PAIR' directly — declare a variable of type 'ST_PAIR' first.",
    ]);
  });

  it("a global variable named like the list wins", () => {
    const extra = [
      { source: GVL_A, fileName: "GVL_A.st" },
      { source: "VAR_GLOBAL gvl_b : ST_Pair; END_VAR", fileName: "GVL_B.st" },
    ];
    expect(messages(prog("GVL_B.a := 1;"), extra, ON)).toEqual([]);
  });
});

describe("a local hiding a global of the list", () => {
  it("LIST.x reaches the global while x reaches the local", () => {
    const main = prog(
      "x := 2.5; GVL_A.x := GVL_A.x + 1; t := GVL_A.x; r := x;",
      "x : REAL; t : INT; r : REAL;",
    );
    expect(messages(main, undefined, ON)).toEqual([]);
    // The global is INT, the local REAL: each assignment is checked against its own.
    expect(
      messages(
        prog("s := GVL_A.x;", "x : STRING; s : STRING;"),
        undefined,
        ON,
      ).join("\n"),
    ).toMatch(/INT/);
    expect(
      messages(prog("s := x;", "x : STRING; s : STRING;"), undefined, ON),
    ).toEqual([]);
  });

  it("also inside an FB method, where the hiding name is a member", () => {
    const main = `FUNCTION_BLOCK FB_U
VAR x : REAL; k : INT := 3; END_VAR
METHOD M : INT
GVL_A.x := GVL_A.x + k + GVL_A.k;
x := 1.5;
M := GVL_A.x;
END_METHOD
END_FUNCTION_BLOCK
${prog("")}`;
    const result = run(main, undefined, ON);
    expect(result.errors).toEqual([]);
    expect(result.headerCode).toContain("inline IEC_INT& GVL_A__X = X;");
    expect(result.headerCode).toContain("const inline IEC_INT& GVL_A__K = K;");
  });

  it("a write to a hidden constant is still refused", () => {
    const errs = messages(prog("GVL_A.k := 1;", "k : INT;"), undefined, ON);
    expect(errs.join("\n")).toMatch(/constant/i);
    expect(errs.join("\n")).not.toMatch(/__/);
  });

  it("no alias is emitted when nothing hides the global", () => {
    const result = run(prog("GVL_A.x := 1;"), undefined, ON);
    expect(result.headerCode).not.toContain("GVL_A__");
  });

  it("messages show LIST.NAME, never the internal name", () => {
    const errs = messages(
      prog("t := GVL_A.x;", "x : REAL; t : TIME;"),
      undefined,
      ON,
    );
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join("\n")).not.toMatch(/__/);
  });
});

describe("two lists declaring the same name", () => {
  const TWO: Source[] = [
    { source: "VAR_GLOBAL x : INT := 1; END_VAR", fileName: "GVL_A.st" },
    {
      source: "VAR_GLOBAL x : INT := 2; y : INT; END_VAR",
      fileName: "GVL_B.st",
    },
  ];

  it("are distinct variables reached qualified", () => {
    const result = run(
      prog("GVL_A.x := GVL_B.x + 1; GVL_B.x := 3; y := 4;"),
      TWO,
      ON,
    );
    expect(result.errors).toEqual([]);
    expect(result.headerCode).toContain("inline IEC_INT GVL_A__X = 1;");
    expect(result.headerCode).toContain("inline IEC_INT GVL_B__X = 2;");
    // A global no other list declares keeps its name.
    expect(result.headerCode).toContain("inline IEC_INT Y{};");
  });

  it("a plain use is an error at the use, asking for qualification", () => {
    expect(messages(prog("v := x;", "v : INT;"), TWO, ON)).toEqual([
      "9:6 'X' is declared in lists GVL_A and GVL_B; qualify it as GVL_A.X or GVL_B.X",
    ]);
  });

  it("a local of that name still wins over both", () => {
    expect(
      messages(prog("x := GVL_A.x + GVL_B.x;", "x : INT;"), TWO, ON),
    ).toEqual([]);
  });

  it("VAR_EXTERNAL of that name asks for qualification", () => {
    const main = `PROGRAM P
VAR_EXTERNAL x : INT; END_VAR
END_PROGRAM
`;
    expect(messages(main, TWO, ON)).toEqual([
      "8:14 VAR_EXTERNAL 'X' is ambiguous: it is declared in lists GVL_A and GVL_B; access it as GVL_A.X or GVL_B.X instead",
    ]);
  });

  it("messages name LIST.NAME, never the internal name", () => {
    const consts: Source[] = [
      {
        source: "VAR_GLOBAL CONSTANT c : INT := 1; END_VAR",
        fileName: "GVL_A.st",
      },
      {
        source: "VAR_GLOBAL CONSTANT c : INT := 2; END_VAR",
        fileName: "GVL_B.st",
      },
    ];
    expect(messages(prog("GVL_A.c := 2;"), consts, ON)).toEqual([
      "9:1 Cannot assign to CONSTANT variable 'GVL_A.C'",
    ]);
    // Hidden by a local: the alias is shown the same way.
    expect(messages(prog("GVL_A.c := 2;", "c : INT;"), consts, ON)).toEqual([
      "9:1 Cannot assign to CONSTANT variable 'GVL_A.C'",
    ]);
  });

  it("the symbol is shown as LIST.NAME", () => {
    const result = analyze(TYPES + prog(""), withFiles(TWO, ON));
    const sym = result.symbolTables?.globalScope.lookup("GVL_A__X");
    expect(sym?.name).toBe("GVL_A.X");
  });
});

describe("internal names and user identifiers", () => {
  it("the lexer accepts a double underscore in an identifier", () => {
    expect(parse(prog("a__b := 1;", "a__b : INT;")).errors).toEqual([]);
  });

  it("a user name equal to an internal name is reported, not merged", () => {
    const TWO: Source[] = [
      { source: "VAR_GLOBAL x : INT; END_VAR", fileName: "GVL_A.st" },
      {
        source: "VAR_GLOBAL x : INT; GVL_A__X : INT; END_VAR",
        fileName: "GVL_B.st",
      },
    ];
    expect(messages(prog(""), TWO, ON).join("\n")).toMatch(
      /'GVL_A\.X' is reached through the name 'GVL_A__X', which this program also declares/,
    );
    const hidden = messages(
      prog("GVL_A.x := 1;", "x : INT; GVL_A__X : INT;"),
      undefined,
      ON,
    );
    expect(hidden).toEqual([
      "9:1 'GVL_A.X' is reached through the name 'GVL_A__X', which this program also declares; rename that declaration",
    ]);
  });
});
