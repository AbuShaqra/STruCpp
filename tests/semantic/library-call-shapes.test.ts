// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Call forms that passed the check and then failed in g++: an ARRAY output or
 * in/out bound to a variable of another shape is refused; a POINTER TO output
 * bound by position or of a library METHOD is captured like a named one; an
 * unbound output's temporary, a METHOD ARRAY[*] in/out and a POINTER TO alias
 * have the C++ type their use needs; an older archive's parameter shapes and
 * STRING lengths are read back from its C++ prototypes, all or nothing.
 */
import { describe, it, expect } from "vitest";
import { compile, compileStlib } from "../../src/index.js";
import { loadStlibArchive } from "../../src/library/library-loader.js";
import type { StlibArchive } from "../../src/library/library-manifest.js";

const LIB = `TYPE MyI : INT; END_TYPE
TYPE AT2 : ARRAY[0..1] OF INT; END_TYPE
FUNCTION F_A : INT
VAR_INPUT x : INT; END_VAR
VAR_OUTPUT a : ARRAY[0..1] OF INT; ap : ARRAY[0..1] OF POINTER TO INT; END_VAR
F_A := x;
END_FUNCTION
FUNCTION F_IO : INT
VAR_IN_OUT a : ARRAY[0..1] OF INT; END_VAR
F_IO := a[0];
END_FUNCTION
FUNCTION F_V : INT
VAR_IN_OUT a : ARRAY[*] OF INT; END_VAR
F_V := 0;
END_FUNCTION
FUNCTION F_S : INT
VAR_IN_OUT a : ARRAY[0..1] OF STRING(10); END_VAR
F_S := 0;
END_FUNCTION
FUNCTION F_P : INT
VAR_INPUT x : INT; END_VAR
VAR_OUTPUT o : POINTER TO INT; END_VAR
F_P := x;
END_FUNCTION
FUNCTION_BLOCK FB_A
VAR_IN_OUT a : ARRAY[0..1] OF INT; END_VAR
VAR_OUTPUT o : ARRAY[0..1] OF INT; END_VAR
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_M
METHOD MP : INT
VAR_INPUT x : INT; END_VAR
VAR_OUTPUT o : POINTER TO INT; END_VAR
MP := x;
END_METHOD
METHOD MV : INT
VAR_IN_OUT arr : ARRAY[*] OF STRING; END_VAR
MV := 0;
END_METHOD
END_FUNCTION_BLOCK
`;

const program = (vars: string, body: string): string =>
  `PROGRAM Main\nVAR x : INT; n : INT; fb : FB_A; fm : FB_M; ${vars} END_VAR\n${body}\nEND_PROGRAM\n`;

const library = (): StlibArchive => {
  const lib = compileStlib([{ source: LIB, fileName: "lib.st" }], {
    name: "shapes",
    version: "1.0.0",
    namespace: "shapes",
  });
  expect(lib.errors).toEqual([]);
  return JSON.parse(JSON.stringify(lib.archive)) as StlibArchive;
};

/** `message` with the parameter it names as the source declares it (lower case): a library keeps its manifest's spelling. */
const declared = (message: string): string =>
  message.replace(
    /'([A-Z][A-Z0-9_]*)'/,
    (_m, n: string) => `'${n.toLowerCase()}'`,
  );

/** The errors of `vars`/`body` declared in the program and against the library. */
const errors = (vars: string, body: string): string[][] => [
  compile(`${LIB}\n${program(vars, body)}`).errors.map((e) => e.message),
  compile(program(vars, body), {
    libraries: [loadStlibArchive(library())],
  }).errors.map((e) => e.message),
];

describe("an ARRAY output or in/out bound to a variable of another shape", () => {
  it("is refused for a scalar, other bounds and another element type", () => {
    const cases: Array<[string, string, string]> = [
      [
        "lw : LWORD;",
        "n := F_A(x := x, ap => lw);",
        "VAR_OUTPUT 'AP' of type ARRAY[0..1] OF POINTER TO INT cannot be bound to a variable of type LWORD",
      ],
      [
        "lw : LWORD;",
        "n := F_A(x, lw);",
        "VAR_OUTPUT 'A' of type ARRAY[0..1] OF INT cannot be bound to a variable of type LWORD",
      ],
      [
        "b : ARRAY[0..2] OF INT;",
        "n := F_A(x := x, a => b);",
        "VAR_OUTPUT 'A' of type ARRAY[0..1] OF INT cannot be bound to a variable of type ARRAY[0..2] OF INT",
      ],
      [
        "b : ARRAY[0..1] OF LWORD;",
        "n := F_A(x := x, ap => b);",
        "VAR_OUTPUT 'AP' of type ARRAY[0..1] OF POINTER TO INT cannot be bound to a variable of type ARRAY[0..1] OF LWORD",
      ],
      [
        "b : ARRAY[1..2] OF INT;",
        "n := F_IO(b);",
        "VAR_IN_OUT 'A' of type ARRAY[0..1] OF INT cannot be bound to a variable of type ARRAY[1..2] OF INT",
      ],
      [
        "b : ARRAY[0..1] OF DINT;",
        "n := F_IO(a := b);",
        "VAR_IN_OUT 'A' of type ARRAY[0..1] OF INT cannot be bound to a variable of type ARRAY[0..1] OF DINT",
      ],
      [
        "lw : LWORD;",
        "n := F_V(lw);",
        "VAR_IN_OUT 'A' of type ARRAY[*] OF INT cannot be bound to a variable of type LWORD",
      ],
      [
        "b : ARRAY[0..1, 0..1] OF INT;",
        "n := F_V(b);",
        "VAR_IN_OUT 'A' of type ARRAY[*] OF INT cannot be bound to a variable of type ARRAY[0..1, 0..1] OF INT",
      ],
      [
        "lw : LWORD;",
        "fb(a := lw);",
        "VAR_IN_OUT 'A' of type ARRAY[0..1] OF INT cannot be bound to a variable of type LWORD",
      ],
      [
        "lw : LWORD; b : ARRAY[0..1] OF INT;",
        "fb(a := b, o => lw);",
        "VAR_OUTPUT 'O' of type ARRAY[0..1] OF INT cannot be bound to a variable of type LWORD",
      ],
    ];
    for (const [vars, body, message] of cases) {
      const [local, lib] = errors(vars, body);
      expect(local, body).toContain(declared(message));
      expect(lib, body).toContain(message);
    }
  });

  it("accepts the same shape, an alias element, a named array type and STRING elements of another length", () => {
    for (const [vars, body] of [
      ["b : ARRAY[0..1] OF INT;", "n := F_A(x := x, a => b) + F_IO(b);"],
      [
        "b : ARRAY[0..1] OF POINTER TO INT; c : ARRAY[0..1] OF INT;",
        "n := F_A(x, c, b);",
      ],
      ["b : ARRAY[0..1] OF MyI;", "n := F_IO(b);"],
      ["b : AT2;", "n := F_IO(b);"],
      ["b : ARRAY[3..9] OF INT;", "n := F_V(b);"],
      ["b : ARRAY[0..1] OF STRING(20);", "n := F_S(b);"],
      ["b : ARRAY[0..1] OF INT;", "fb(a := b, o => b);"],
    ]) {
      expect(errors(vars!, body!), body).toEqual([[], []]);
    }
  });
});

describe("a POINTER TO output bound by position or of a library METHOD", () => {
  it("is refused into a narrow integer by position, as by name", () => {
    const message =
      "The output 'O' gives a 64-bit address, which INT cannot hold; use a POINTER TO or PVOID, or __XWORD, LWORD or ULINT";
    expect(errors("i : INT;", "n := F_P(x, i);")).toEqual([
      [declared(message)],
      [message],
    ]);
    const viaMethod = compile(program("i : INT;", "n := fm.MP(x, i);"), {
      libraries: [loadStlibArchive(library())],
    });
    expect(viaMethod.errors.map((e) => e.message)).toEqual([message]);
  });

  it("is captured into an LWORD as its address", () => {
    for (const body of [
      "n := F_P(x, lw);",
      "n := fm.MP(x, lw) + fm.MP(x := x, o => lw);",
    ]) {
      const result = compile(program("lw : LWORD;", body), {
        libraries: [loadStlibArchive(library())],
      });
      expect(result.errors).toEqual([]);
      expect(result.cppCode).toContain("strucpp::address_bits(");
    }
  });
});

describe("C++ types of call temporaries and declarations", () => {
  it("declares an unbound inline array or pointer output with its own type", () => {
    const result = compile(program("", "n := F_A(x := x);"), {
      libraries: [loadStlibArchive(library())],
    });
    expect(result.errors).toEqual([]);
    expect(result.cppCode).toMatch(/Array1D<IEC_INT, 0, 1> __output_tmp_\d+;/);
    expect(result.cppCode).toMatch(
      /Array1D<IEC_Ptr<INT_t>, 0, 1> __output_tmp_\d+;/,
    );
    expect(result.cppCode).not.toContain("IEC___INLINE_ARRAY");
  });

  it("passes a METHOD's ARRAY[*] in/out as a view, as a FUNCTION's", () => {
    const result = compile(`${LIB}\n${program("", "")}`);
    expect(result.headerCode).toContain(
      "IEC_INT MV(ArrayView1D<IEC_STRING> ARR);",
    );
  });

  it("declares a POINTER TO alias as a variable declared POINTER TO is declared", () => {
    const result = compile(`TYPE PINT : POINTER TO INT; END_TYPE
PROGRAM Main
VAR x : INT; p : PINT; q : POINTER TO INT; END_VAR
p := ADR(x);
q := p + 2;
END_PROGRAM
`);
    expect(result.errors).toEqual([]);
    expect(result.headerCode).toContain("using PINT = IEC_Ptr<INT_t>;");
    expect(result.headerCode).toContain("IEC_Ptr<INT_t> Q;");
  });
});

describe("an older archive's parameters read back from its C++ prototypes", () => {
  const SHAPED = `FUNCTION F_R : INT
VAR_INPUT s : STRING(20); ps : POINTER TO STRING(30); END_VAR
VAR_OUTPUT a : ARRAY[0..1] OF POINTER TO INT; sa : ARRAY[1..2] OF STRING(5); END_VAR
VAR_IN_OUT v : ARRAY[*] OF STRING(7); io : STRING(40); END_VAR
F_R := 0;
END_FUNCTION
FUNCTION_BLOCK FB_R
METHOD M : INT
VAR_INPUT s : STRING(20); END_VAR
VAR_OUTPUT ps : POINTER TO STRING(30); END_VAR
M := 0;
END_METHOD
END_FUNCTION_BLOCK
`;
  const PARAM_FIELDS = [
    "referenceKind",
    "referenceChain",
    "arrayDimensions",
    "elementTypeName",
    "elementReferenceChain",
    "maxLength",
    "elementMaxLength",
  ] as const;
  const shapeOf = (p: object): string =>
    JSON.stringify(
      Object.fromEntries(
        PARAM_FIELDS.map((k) => [k, (p as Record<string, unknown>)[k]]),
      ),
    );
  const current = (): StlibArchive => {
    const lib = compileStlib([{ source: SHAPED, fileName: "r.st" }], {
      name: "r",
      version: "1.0.0",
      namespace: "r",
    });
    expect(lib.errors).toEqual([]);
    return JSON.parse(JSON.stringify(lib.archive)) as StlibArchive;
  };
  const older = (archive: StlibArchive): StlibArchive => {
    const old = JSON.parse(JSON.stringify(archive)) as StlibArchive;
    delete old.manifest.parameterShapes;
    delete old.manifest.stringLengthsRecorded;
    for (const fn of old.manifest.functions) {
      for (const p of fn.parameters) {
        for (const k of PARAM_FIELDS) delete p[k];
      }
    }
    for (const m of old.manifest.functionBlocks[0]!.methods ?? []) {
      for (const p of m.parameters) delete p.maxLength;
    }
    return old;
  };

  it("recovers every shape and length the current archive records", () => {
    const cur = loadStlibArchive(current()).manifest;
    const old = loadStlibArchive(older(current())).manifest;
    const fn = old.functions[0]!;
    expect(fn.prototypeShapes).toBe(true);
    expect(fn.parameters.map(shapeOf)).toEqual(
      cur.functions[0]!.parameters.map(shapeOf),
    );
    const method = old.functionBlocks[0]!.methods![0]!;
    expect(method.prototypeShapes).toBe(true);
    expect(method.parameters.map(shapeOf)).toEqual(
      cur.functionBlocks[0]!.methods![0]!.parameters.map(shapeOf),
    );
  });

  it("reads only the reference levels, as before, when one length cannot be read", () => {
    const old = older(current());
    for (const chunk of old.chunks) {
      if (chunk.name === "F_R") {
        chunk.header = chunk.header.replace(
          "IECStringVar<40>&",
          "SomeString<40>&",
        );
      }
    }
    const fn = loadStlibArchive(old).manifest.functions[0]!;
    expect(fn.prototypeShapes).toBeUndefined();
    expect(fn.parameters.map((p) => [p.name, p.referenceKind])).toEqual([
      ["S", undefined],
      ["PS", "pointer_to"],
      ["A", undefined],
      ["SA", undefined],
      ["V", undefined],
      ["IO", undefined],
    ]);
    expect(fn.parameters.some((p) => p.maxLength !== undefined)).toBe(false);
    expect(fn.parameters.some((p) => p.arrayDimensions !== undefined)).toBe(
      false,
    );
  });

  it("reads a length named by a constant", () => {
    const lib = compileStlib(
      [
        {
          source: `VAR_GLOBAL CONSTANT L : INT := 12; END_VAR
FUNCTION F_C : INT
VAR_INPUT s : STRING(L); END_VAR
F_C := 0;
END_FUNCTION
`,
          fileName: "c.st",
        },
      ],
      { name: "c", version: "1.0.0", namespace: "c" },
    );
    expect(lib.errors).toEqual([]);
    const old = JSON.parse(JSON.stringify(lib.archive)) as StlibArchive;
    delete old.manifest.parameterShapes;
    delete old.manifest.stringLengthsRecorded;
    const recorded = old.manifest.functions[0]!.parameters[0]!.maxLength;
    delete old.manifest.functions[0]!.parameters[0]!.maxLength;
    const fn = loadStlibArchive(old).manifest.functions[0]!;
    expect(fn.parameters[0]!.maxLength).toBe(recorded);
    expect(fn.prototypeShapes).toBe(true);
  });
  it("reads a block's STRING in/out lengths from its class, so its calls warn as a marked archive's", () => {
    const source = `FUNCTION_BLOCK FB_IO
VAR_IN_OUT s : STRING(30); t : STRING; END_VAR
END_FUNCTION_BLOCK
`;
    const lib = compileStlib([{ source, fileName: "io.st" }], {
      name: "io",
      version: "1.0.0",
      namespace: "io",
    });
    expect(lib.errors).toEqual([]);
    const marked = JSON.parse(JSON.stringify(lib.archive)) as StlibArchive;
    const old = JSON.parse(JSON.stringify(lib.archive)) as StlibArchive;
    delete old.manifest.parameterShapes;
    delete old.manifest.stringLengthsRecorded;
    for (const p of old.manifest.functionBlocks[0]!.inouts) delete p.maxLength;
    const loaded = loadStlibArchive(old).manifest.functionBlocks[0]!;
    expect(loaded.prototypeInOuts).toBe(true);
    expect(loaded.inouts.map((p) => p.maxLength)).toEqual([30, undefined]);
    const warnings = (archive: StlibArchive): string[] =>
      compile(
        `PROGRAM Main
VAR f : FB_IO; a : STRING(30); b : STRING(20); c : STRING; END_VAR
f(s := a, t := c);
f(s := b, t := b);
END_PROGRAM
`,
        { libraries: [loadStlibArchive(archive)] },
      ).warnings.map((w) => w.message);
    expect(warnings(old)).toEqual(warnings(marked));
    expect(warnings(old)).toHaveLength(2);
  });
});

describe("review: element types, pointer aliases and METHOD calls", () => {
  const LIB2 = `TYPE PINT : POINTER TO INT; END_TYPE
TYPE TA : ARRAY[0..2] OF INT; END_TYPE
FUNCTION FX : DINT
VAR_IN_OUT a : ARRAY[0..1] OF UINT; END_VAR
FX := 1;
END_FUNCTION
FUNCTION FV : DINT
VAR_IN_OUT a : ARRAY[*] OF BYTE; END_VAR
FV := 2;
END_FUNCTION
FUNCTION FO : DINT
VAR_OUTPUT o : ARRAY[0..1] OF DWORD; END_VAR
FO := 3;
END_FUNCTION
FUNCTION FT : DINT
VAR_IN_OUT a : TA; END_VAR
FT := 4;
END_FUNCTION
FUNCTION FP : DINT
VAR_IN_OUT a : ARRAY[0..1] OF PINT; END_VAR
FP := 5;
END_FUNCTION
FUNCTION FQ : DINT
VAR_IN_OUT a : ARRAY[0..1] OF POINTER TO INT; END_VAR
FQ := 6;
END_FUNCTION
FUNCTION_BLOCK FBO
VAR_OUTPUT o : ARRAY[0..1] OF ULINT; END_VAR
END_FUNCTION_BLOCK
FUNCTION_BLOCK FM
METHOD M : DINT
VAR_IN_OUT a : ARRAY[0..2] OF INT; END_VAR
M := 1;
END_METHOD
METHOD MO : DINT
VAR_OUTPUT a : ARRAY[0..2] OF INT; END_VAR
MO := 1;
END_METHOD
METHOD MP : INT
VAR_INPUT x : INT; END_VAR
VAR_OUTPUT o : POINTER TO INT; i : INT; END_VAR
MP := x;
END_METHOD
END_FUNCTION_BLOCK
`;
  const lib2 = (): StlibArchive => {
    const lib = compileStlib([{ source: LIB2, fileName: "l2.st" }], {
      name: "l2",
      version: "1.0.0",
      namespace: "l2",
    });
    expect(lib.errors).toEqual([]);
    return JSON.parse(JSON.stringify(lib.archive)) as StlibArchive;
  };
  const prog = (vars: string, body: string): string =>
    `PROGRAM Main\nVAR n : DINT; ${vars} END_VAR\n${body}\nEND_PROGRAM\n`;
  const both = (
    vars: string,
    body: string,
    options: Parameters<typeof compile>[1] = {},
  ): string[][] => [
    compile(`${LIB2}\n${prog(vars, body)}`, options).errors.map(
      (e) => e.message,
    ),
    compile(prog(vars, body), {
      ...options,
      libraries: [loadStlibArchive(lib2())],
    }).errors.map((e) => e.message),
  ];

  it("binds arrays of two names of one integer storage as the scalar rule allows", () => {
    for (const [vars, body] of [
      ["arr : ARRAY[0..1] OF WORD;", "n := FX(arr);"],
      ["arr : ARRAY[0..3] OF USINT;", "n := FV(arr);"],
      ["arr : ARRAY[0..1] OF UDINT;", "n := FO(o => arr);"],
      ["fb : FBO; arr : ARRAY[0..1] OF LWORD;", "fb(o => arr);"],
    ]) {
      expect(both(vars!, body!), body).toEqual([[], []]);
    }
    // --strict refuses the scalar pair, and so the array's.
    const [local, lib] = both("arr : ARRAY[0..1] OF WORD;", "n := FX(arr);", {
      strict: true,
    });
    const message =
      "VAR_IN_OUT 'A' of type ARRAY[0..1] OF UINT cannot be bound to a variable of type ARRAY[0..1] OF WORD";
    expect(local).toContain(declared(message));
    expect(lib).toContain(message);
    expect(
      both("arr : ARRAY[0..1] OF UDINT;", "n := FO(o => arr);", {
        strict: true,
      })[1],
    ).toContain(
      "VAR_OUTPUT 'O' of type ARRAY[0..1] OF DWORD cannot be bound to a variable of type ARRAY[0..1] OF UDINT",
    );
    // Another storage is refused in every mode.
    expect(both("arr : ARRAY[0..1] OF INT;", "n := FX(arr);")).toEqual([
      [
        "VAR_IN_OUT 'a' of type ARRAY[0..1] OF UINT cannot be bound to a variable of type ARRAY[0..1] OF INT",
      ],
      [
        "VAR_IN_OUT 'A' of type ARRAY[0..1] OF UINT cannot be bound to a variable of type ARRAY[0..1] OF INT",
      ],
    ]);
  });

  it("binds ARRAY OF PINT and ARRAY OF POINTER TO INT both ways", () => {
    expect(
      both("arr : ARRAY[0..1] OF POINTER TO INT;", "n := FP(arr);"),
    ).toEqual([[], []]);
    expect(both("arr : ARRAY[0..1] OF PINT;", "n := FQ(arr);")).toEqual([
      [],
      [],
    ]);
  });

  it("checks an in/out declared with an ARRAY type against an inline array", () => {
    const [local] = both("arr : ARRAY[0..1] OF INT;", "n := FT(arr);");
    expect(local).toEqual([
      "VAR_IN_OUT 'a' of type ARRAY[0..2] OF INT cannot be bound to a variable of type ARRAY[0..1] OF INT",
    ]);
    expect(
      both("arr : TA; b : ARRAY[0..2] OF INT;", "n := FT(arr) + FT(b);"),
    ).toEqual([[], []]);
  });

  it("checks a library METHOD's ARRAY in/out and output", () => {
    const [, lib] = both(
      "f : FM; arr4 : ARRAY[0..3] OF INT;",
      "n := f.M(arr4) + f.MO(a => arr4);",
    );
    expect(lib).toEqual([
      "VAR_IN_OUT 'A' of type ARRAY[0..2] OF INT cannot be bound to a variable of type ARRAY[0..3] OF INT",
      "VAR_OUTPUT 'A' of type ARRAY[0..2] OF INT cannot be bound to a variable of type ARRAY[0..3] OF INT",
    ]);
  });

  it("captures a POINTER TO output of a METHOD of an indexed instance", () => {
    for (const libraries of [[], [loadStlibArchive(lib2())]]) {
      const source = `${libraries.length === 0 ? LIB2 : ""}\n${prog(
        "fa : ARRAY[0..1] OF FM; lw : LWORD; i : INT;",
        "n := fa[1].MP(3, lw, i) + fa[0].MP(x := 3, o => lw);",
      )}`;
      const r = compile(source, { libraries });
      expect(r.errors).toEqual([]);
      expect(r.cppCode).toContain("strucpp::address_bits(");
    }
  });

  it("lowers only the literal 0 into a POINTER TO alias to NULL; another integer assigned is kept as before", () => {
    const r = compile(
      `${LIB2}\nFUNCTION FA : INT\nVAR_INPUT p : PINT; END_VAR\nFA := 1;\nEND_FUNCTION\n${prog(
        "p : PINT; q : POINTER TO INT;",
        "p := 0; q := 0; n := FA(0) + FA(p := 0); p := 5; q := 5;",
      )}`,
    );
    expect(r.errors).toEqual([]);
    expect(r.cppCode).toContain("P = IEC_NULL;");
    expect(r.cppCode).toContain("Q = IEC_NULL;");
    expect(r.cppCode).toContain("FA(IEC_NULL)");
    expect(r.cppCode).toContain("P = 5;");
    expect(r.cppCode).toContain("Q = 5;");
  });

  it("lowers 0 into a POINTER TO alias and declares its IEC_ wrapper as the alias", () => {
    const r = compile(
      `${LIB2}\n${prog("p : PINT; pz : PINT := 0;", "p := 0;")}`,
    );
    expect(r.errors).toEqual([]);
    expect(r.headerCode).toContain("using IEC_PINT = PINT;");
  });
});

describe("recheck: integers into POINTER TO inputs, library pointer aliases", () => {
  const LIB3 = `TYPE PINT : POINTER TO INT; END_TYPE
FUNCTION FZ : PINT
VAR_INPUT p : PINT; END_VAR
FZ := p;
END_FUNCTION
FUNCTION FP : INT
VAR_INPUT p : POINTER TO INT; END_VAR
FP := 1;
END_FUNCTION
FUNCTION FA : DINT
VAR_IN_OUT a : ARRAY[0..1] OF PINT; END_VAR
FA := 1;
END_FUNCTION
FUNCTION_BLOCK FB
VAR_INPUT p : PINT; END_VAR
METHOD M : INT
VAR_INPUT q : PINT; END_VAR
M := 1;
END_METHOD
END_FUNCTION_BLOCK
`;
  const archive = (): StlibArchive => {
    const lib = compileStlib([{ source: LIB3, fileName: "l3.st" }], {
      name: "l3",
      version: "1.0.0",
      namespace: "l3",
    });
    expect(lib.errors).toEqual([]);
    return JSON.parse(JSON.stringify(lib.archive)) as StlibArchive;
  };
  const prog = (vars: string, body: string): string =>
    `PROGRAM Main\nVAR n : DINT; p : PINT; x : INT; lw : LWORD; fb : FB; fa : ARRAY[0..1] OF FB; ${vars} END_VAR\n${body}\nEND_PROGRAM\n`;
  const both = (vars: string, body: string, old = false): string[][] => {
    const raw = archive();
    if (old) for (const t of raw.manifest.types) delete t.pointerTarget;
    return [
      compile(`${LIB3}\n${prog(vars, body)}`).errors.map((e) => e.message),
      compile(prog(vars, body), {
        libraries: [loadStlibArchive(raw)],
      }).errors.map((e) => e.message),
    ];
  };
  const refusal = (name: string): string =>
    `An integer cannot be passed to the POINTER TO input '${name}'; pass an address (ADR) or 0`;

  it("refuses an integer bound to a POINTER TO input, positional or named, alias or not", () => {
    for (const [body, name] of [
      ["p := FZ(5);", "P"],
      ["p := FZ(p := 5);", "P"],
      ["p := FZ(lw);", "P"],
      ["p := FZ(lw + 8);", "P"],
      ["n := FP(5);", "P"],
      ["n := FP(p := lw);", "P"],
      ["fb(p := 5);", "P"],
      ["n := fb.M(5);", "Q"],
      ["n := fa[1].M(lw);", "Q"],
    ]) {
      // The program declares a variable p: the library's input P is spelled so too
      const shown = name === "P" ? "p" : name!;
      expect(both("", body!), body).toEqual([
        [refusal(name!.toLowerCase())],
        [refusal(shown)],
      ]);
    }
  });

  it("refuses an integer initial value of a POINTER TO alias", () => {
    const message =
      "An integer cannot initialise the POINTER TO 'pz'; use 0 or ADR(...), or assign it in the body";
    expect(both("pz : PINT := 5;", "n := 1;")).toEqual([[message], [message]]);
  });

  it("keeps 0 and addresses: NULL into the alias, by value, name, initial value and member", () => {
    const body =
      "p := FZ(0); p := FZ(p := 0); n := FP(0) + fb.M(0); fb(p := 0); q := ADR(x); p := FZ(q); n := FP(q);";
    expect(both("pz : PINT := 0; q : POINTER TO INT;", body)).toEqual([[], []]);
    const r = compile(prog("pz : PINT := 0;", "p := FZ(0);"), {
      libraries: [loadStlibArchive(archive())],
    });
    expect(r.cppCode).toContain("FZ(IEC_NULL)");
    expect(r.cppCode).not.toMatch(/IEC_PINT>\(0\)/);
  });

  it("records a library POINTER TO alias's target, so its arrays compare as the target's", () => {
    expect(
      archive().manifest.types.find((t) => t.name === "PINT"),
    ).toMatchObject({ kind: "alias", pointerTarget: "INT" });
    expect(
      both("arr : ARRAY[0..1] OF POINTER TO INT;", "n := FA(arr);"),
    ).toEqual([[], []]);
    const message =
      "VAR_IN_OUT 'A' of type ARRAY[0..1] OF POINTER TO INT cannot be bound to a variable of type ARRAY[0..1] OF POINTER TO DINT";
    expect(
      both("arr : ARRAY[0..1] OF POINTER TO DINT;", "n := FA(arr);"),
    ).toEqual([[declared(message)], [message]]);
    // An older archive without the target: refused rather than left to g++.
    expect(
      both("arr : ARRAY[0..1] OF POINTER TO DINT;", "n := FA(arr);", true)[1],
    ).toHaveLength(1);
  });
});
