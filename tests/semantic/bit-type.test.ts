/**
 * The feature bit_type: BIT as a STRUCT member type, packed into shared
 * bytes. Refusals, layout of the generated C++ and the debug map.
 */
import { describe, it, expect } from "vitest";
import { compile, type CompileOptions } from "../../src/index.js";
import {
  DEFAULT_FEATURES,
  KNOWN_FEATURES,
  resolveDialect,
  type DialectProfile,
} from "../../src/dialect.js";
import { bitPlaceOf, bitRuns } from "../../src/backend/bit-runs.js";
import { compileStlib } from "../../src/library/library-compiler.js";

const PROFILE: DialectProfile = {
  id: "codesys3",
  name: "codesys3",
  extends: "iec-3",
  features: ["pointer_to", "reference_to", "ref_assign", "bit_type", "union"],
  semantics: {},
};
const ON = { features: ["+bit_type"] };

function diag(
  source: string,
  opts: Partial<CompileOptions> = {},
): { errors: string[]; cpp: string; hpp: string } {
  const r = compile(source, { headerFileName: "generated.hpp", ...opts });
  return {
    errors: r.errors.map((e) => `${e.line}:${e.column}: ${e.message}`).sort(),
    cpp: r.cppCode,
    hpp: r.headerCode,
  };
}

const STRUCT = `TYPE ST_B : STRUCT
  a : BIT;
  b : BIT := TRUE;
  c : BIT;
  n : INT := 7;
  d : BIT;
END_STRUCT; END_TYPE
`;
const PROGRAM = `${STRUCT}PROGRAM MAIN
VAR s : ST_B; x : BOOL; END_VAR
s.a := TRUE;
x := s.b AND NOT s.c;
END_PROGRAM
`;

describe("bit_type — the feature", () => {
  it("is known but in neither the default set nor iec-3", () => {
    expect(KNOWN_FEATURES).toContain("bit_type");
    expect(DEFAULT_FEATURES.has("bit_type")).toBe(false);
    expect(resolveDialect({ dialect: "iec-3" }).features).not.toContain(
      "bit_type",
    );
  });

  it("is refused at each BIT member when off", () => {
    for (const opts of [{}, { strict: true }, { dialect: "iec-3" }]) {
      expect(diag(PROGRAM, opts).errors).toEqual([
        "2:7: BIT as a STRUCT member needs the feature bit_type",
        "3:7: BIT as a STRUCT member needs the feature bit_type",
        "4:7: BIT as a STRUCT member needs the feature bit_type",
        "6:7: BIT as a STRUCT member needs the feature bit_type",
      ]);
    }
  });

  it("is accepted only as a STRUCT member", () => {
    const src = `TYPE ST_B : STRUCT a : BIT; arr : ARRAY[0..1] OF BIT; p : POINTER TO BIT; END_STRUCT; END_TYPE
TYPE U_X : UNION b : BIT; w : WORD; END_UNION; END_TYPE
FUNCTION_BLOCK FB_A
VAR m : BIT; END_VAR
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR v : BIT; END_VAR
END_PROGRAM
`;
    expect(diag(src, { dialect: PROFILE }).errors).toEqual([
      "1:35: BIT is allowed only as the type of a STRUCT member",
      "1:59: BIT is allowed only as the type of a STRUCT member",
      "2:22: BIT is allowed only as the type of a STRUCT member",
      "4:9: BIT is allowed only as the type of a STRUCT member",
      "7:9: BIT is allowed only as the type of a STRUCT member",
    ]);
  });

  it("leaves BIT to a TYPE of that name", () => {
    const src = `TYPE BIT : BOOL; END_TYPE
TYPE ST_B : STRUCT a : BIT; END_STRUCT; END_TYPE
PROGRAM MAIN
VAR s : ST_B; v : BIT; END_VAR
s.a := v;
END_PROGRAM
`;
    const on = diag(src, ON);
    const off = diag(src);
    expect(on.errors).toEqual([]);
    expect(on.cpp).toBe(off.cpp);
    expect(on.hpp).toBe(off.hpp);
  });
});

describe("bit_type — layout", () => {
  it("packs consecutive BIT members, 8 per byte, a non-BIT member ending a run", () => {
    const r = diag(
      `TYPE ST_9 : STRUCT b0, b1, b2, b3, b4, b5, b6, b7, b8 : BIT; w : WORD; z : BIT; END_STRUCT; END_TYPE
PROGRAM MAIN VAR s : ST_9; END_VAR END_PROGRAM
`,
      ON,
    );
    expect(r.errors).toEqual([]);
    expect(r.hpp).toContain(
      "struct STRUCPP_MAY_ALIAS ST_9 {\n    ST_9_bits0 bits_0_{};\n    ST_9_bits1 bits_1_{};\n    IEC_WORD W{};\n    ST_9_bits2 bits_2_{};\n};",
    );
    expect(r.hpp).toContain("    bool B7 : 1;\n    ST_9_bits0() noexcept");
  });

  it("places each member in its byte and bit", () => {
    const r = compile(
      `TYPE ST_9 : STRUCT b0, b1, b2, b3, b4, b5, b6, b7, b8 : BIT; w : WORD; z : BIT; END_STRUCT; END_TYPE
PROGRAM MAIN VAR s : ST_9; END_VAR END_PROGRAM
`,
      ON,
    );
    const def = r.ast!.types[0]!.definition as {
      fields: Parameters<typeof bitRuns>[0];
    };
    expect(bitRuns(def.fields).map((run) => run.members.length)).toEqual([
      8, 1, 1,
    ]);
    expect(bitPlaceOf(def.fields, "B8")).toEqual({ run: 1, bit: 0 });
    expect(bitPlaceOf(def.fields, "Z")).toEqual({ run: 2, bit: 0 });
    expect(bitPlaceOf(def.fields, "W")).toBeUndefined();
  });

  it("reads and writes a member through its byte, in every place a STRUCT is reached", () => {
    const r = diag(
      `${STRUCT}VAR_GLOBAL g : ST_B; END_VAR
PROGRAM MAIN
VAR s : ST_B; arr : ARRAY[0..2] OF ST_B; x : BOOL; END_VAR
s.a := TRUE;
arr[1].d := s.c;
g.b := x;
END_PROGRAM
`,
      ON,
    );
    expect(r.errors).toEqual([]);
    expect(r.cpp).toContain("S.bits_0_.A = true;");
    expect(r.cpp).toContain(".bits_1_.D = S.bits_0_.C;");
    expect(r.cpp).toContain("G.bits_0_.B = X;");
  });
});

describe("bit_type — a BIT has no address", () => {
  it("refuses ADR, REF, REF=, REFERENCE TO, VAR_IN_OUT and output bindings", () => {
    const src = `TYPE ST_B : STRUCT a : BIT; b : BIT; END_STRUCT; END_TYPE
FUNCTION_BLOCK FB_A
VAR_INPUT i : BOOL; END_VAR
VAR_OUTPUT q : BOOL; END_VAR
VAR_IN_OUT io : BOOL; END_VAR
q := i;
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_R
VAR_INPUT r : REFERENCE TO BOOL; END_VAR
END_FUNCTION_BLOCK
FUNCTION F : BOOL
VAR_INPUT v : BOOL; END_VAR
VAR_OUTPUT o : BOOL; END_VAR
F := v;
END_FUNCTION
PROGRAM MAIN
VAR s : ST_B; x : BOOL; fb : FB_A; fr : FB_R; pb : POINTER TO BOOL; rb : REF_TO BOOL; rr : REFERENCE TO BOOL; END_VAR
fb(i := s.a, q => s.b, io := s.a);
x := F(v := s.a, o => s.b);
pb := ADR(s.a);
rb := REF(s.a);
rr REF= s.a;
fr(r := s.b);
END_PROGRAM
`;
    const tail =
      "a BIT has no address of its own; copy it to a BOOL variable first";
    expect(diag(src, { dialect: PROFILE }).errors).toEqual([
      `18:30: VAR_IN_OUT 'IO' cannot be bound to the BIT member S.A: ${tail}`,
      `19:23: VAR_OUTPUT 'O' cannot be bound to the BIT member S.B: ${tail}`,
      `20:11: ADR() cannot take the BIT member S.A: ${tail}`,
      `21:11: REF() cannot take the BIT member S.A: ${tail}`,
      `22:9: REF= cannot bind to the BIT member S.A: ${tail}`,
      `23:9: REFERENCE TO input 'R' cannot be bound to the BIT member S.B: ${tail}`,
    ]);
  });
});

describe("bit_type — debug map", () => {
  it("lists a BIT member as a BIT leaf with its bit, and BIT in typeTags", () => {
    const r = compile(
      `${STRUCT}PROGRAM MAIN VAR s : ST_B; END_VAR END_PROGRAM
CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION
`,
      ON,
    );
    expect(r.errors).toEqual([]);
    const leaves = r.debugMap!.leaves.filter((l) =>
      l.path.startsWith("INSTANCE0.S."),
    );
    expect(leaves.map((l) => [l.path, l.type, l.size, l.bit ?? null])).toEqual([
      ["INSTANCE0.S.A", "BIT", 1, 0],
      ["INSTANCE0.S.B", "BIT", 1, 1],
      ["INSTANCE0.S.C", "BIT", 1, 2],
      ["INSTANCE0.S.N", "INT", 2, null],
      ["INSTANCE0.S.D", "BIT", 1, 0],
    ]);
    expect(r.debugMap!.typeTags["BIT"]).toBe(21);
    expect(r.debugTableCpp).toContain(
      "{ (void*)&g_config.INSTANCE0.S.bits_0_, TAG_BIT, (2 << LEAF_BIT_SHIFT) }",
    );
  });

  it("keeps typeTags unchanged for a program without BIT", () => {
    const r = compile(
      `PROGRAM MAIN VAR x : INT; END_VAR END_PROGRAM
CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION
`,
      ON,
    );
    expect(r.debugMap!.typeTags["BIT"]).toBeUndefined();
  });
});

describe("bit_type — libraries", () => {
  it("refuses a library that would export BIT members", () => {
    const r = compileStlib([{ source: STRUCT, fileName: "lib.st" }], {
      name: "bits",
      version: "1.0.0",
      namespace: "bits",
      features: ["+bit_type"],
    });
    expect(r.success).toBe(false);
    expect(r.errors.map((e) => e.message)).toContain(
      "STRUCT 'ST_B' has BIT members: a library cannot export BIT members yet",
    );
  });
});

describe("bit_type — review regressions", () => {
  const tail =
    "a BIT has no address of its own; copy it to a BOOL variable first";
  const HEAD = `TYPE ST_B : STRUCT a : BIT; b : BIT := TRUE; n : INT; END_STRUCT; END_TYPE
TYPE ST_A : ST_B; END_TYPE
TYPE PST : POINTER TO ST_B; END_TYPE
TYPE ST_O : STRUCT inner : ST_A; arr : ARRAY[0..2] OF ST_B; END_STRUCT; END_TYPE
FUNCTION G : BOOL
VAR_IN_OUT x : BOOL; END_VAR
G := x;
END_FUNCTION
`;

  it("refuses the address of a BIT member reached through a TYPE alias", () => {
    const src = `${HEAD}PROGRAM MAIN
VAR s : ST_A; p : PST; o : ST_O; q : POINTER TO BOOL; r : REFERENCE TO BOOL; rt : REF_TO BOOL; y : BOOL; END_VAR
q := ADR(s.a);
y := G(s.a);
r REF= s.b;
rt := REF(s.a);
q := ADR(p^.a);
q := ADR(o.inner.a);
END_PROGRAM
`;
    expect(diag(src, { dialect: PROFILE }).errors).toEqual([
      `11:10: ADR() cannot take the BIT member S.A: ${tail}`,
      `12:8: VAR_IN_OUT 'X' cannot be bound to the BIT member S.A: ${tail}`,
      `13:8: REF= cannot bind to the BIT member S.B: ${tail}`,
      `14:11: REF() cannot take the BIT member S.A: ${tail}`,
      `15:10: ADR() cannot take the BIT member P^.A: ${tail}`,
      `16:10: ADR() cannot take the BIT member O.INNER.A: ${tail}`,
    ]);
  });

  it("names the member as written: indices, dereference and list", () => {
    const src = `${HEAD}PROGRAM MAIN
VAR s : ARRAY[0..1] OF ST_B; o : ST_O; i : INT; q : POINTER TO BOOL; END_VAR
q := ADR(s[1].a);
q := ADR(o.arr[i].b);
END_PROGRAM
`;
    expect(diag(src, { dialect: PROFILE }).errors).toEqual([
      `11:10: ADR() cannot take the BIT member S[1].A: ${tail}`,
      `12:10: ADR() cannot take the BIT member O.ARR[I].B: ${tail}`,
    ]);
    const listed = compile(
      [
        {
          source: `PROGRAM MAIN
VAR q : POINTER TO BOOL; END_VAR
q := ADR(GVL_A.gv.a);
END_PROGRAM
`,
          fileName: "main.st",
        },
      ].map((f) => f.source)[0]!,
      {
        dialect: PROFILE,
        features: ["+named_global_lists"],
        additionalSources: [
          { source: `${HEAD}`, fileName: "types.st" },
          { source: "VAR_GLOBAL gv : ST_B; END_VAR\n", fileName: "GVL_A.st" },
        ],
      },
    );
    expect(listed.errors.map((e) => e.message)).toEqual([
      `ADR() cannot take the BIT member GVL_A.GV.A: ${tail}`,
    ]);
  });

  it("refuses REF_LINK and a METHOD VAR_OUTPUT binding", () => {
    const src = `${HEAD}FUNCTION_BLOCK FB_M
METHOD M : BOOL
VAR_OUTPUT o : BOOL; END_VAR
o := TRUE;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR s : ST_B; fb : FB_M; x : BOOL; r : REFERENCE TO BOOL; END_VAR
r := REF_LINK(s.a);
x := fb.M(o => s.b);
END_PROGRAM
`;
    expect(diag(src, { dialect: PROFILE }).errors).toEqual([
      `17:15: REF_LINK() cannot take the BIT member S.A: ${tail}`,
      `18:16: VAR_OUTPUT 'O' cannot be bound to the BIT member S.B: ${tail}`,
    ]);
  });

  it("names the profiles that have the feature when it is off", () => {
    const profile: DialectProfile = {
      id: "vendor-b",
      name: "vendor-b",
      extends: "iec-3",
      features: ["bit_type"],
      semantics: {},
    };
    const r = compile(
      "TYPE ST_B : STRUCT a : BIT; END_STRUCT; END_TYPE\nPROGRAM MAIN\nVAR s : ST_B; END_VAR\nEND_PROGRAM\n",
      {
        dialect: "iec-3",
        dialectFiles: ["vendor-b.json"],
        dialectIO: {
          readFile: () => JSON.stringify(profile),
          listDir: () => [],
        },
      },
    );
    expect(r.errors.map((e) => e.message)).toEqual([
      "BIT as a STRUCT member needs the feature bit_type (profiles: vendor-b)",
    ]);
  });

  it("refuses a BIT member of a STRUCT OVERLAP", () => {
    expect(
      diag(
        "TYPE ST_O : STRUCT OVERLAP a : BIT; w : WORD; END_STRUCT; END_TYPE\nPROGRAM MAIN\nVAR s : ST_O; END_VAR\nEND_PROGRAM\n",
        { features: ["+bit_type", "+union"] },
      ).errors,
    ).toEqual(["1:32: BIT is allowed only as the type of a STRUCT member"]);
  });

  it("reaches a BIT member named like a type by its mangled name", () => {
    const r = diag(
      `TYPE ST_I : STRUCT x : BIT; END_STRUCT END_TYPE
TYPE ST_M : STRUCT ST_I : BIT; inner : ST_I; END_STRUCT END_TYPE
PROGRAM MAIN
VAR s : ST_M; r : BOOL; END_VAR
s.ST_I := TRUE; r := s.ST_I;
END_PROGRAM
`,
      ON,
    );
    expect(r.errors).toEqual([]);
    expect(r.hpp).toContain("bool ST_I_ : 1;");
    expect(r.cpp).toContain("S.bits_0_.ST_I_ = true;");
    expect(r.cpp).toContain("R = S.bits_0_.ST_I_;");
  });
});

describe("bit_type — recheck regressions", () => {
  it("refuses the address of a BIT member of a result or property value", () => {
    const tail =
      "a BIT has no address of its own; copy it to a BOOL variable first";
    const src = `TYPE ST_B : STRUCT a : BIT; b : BIT := TRUE; n : INT; END_STRUCT; END_TYPE
TYPE ST_A : ST_B; END_TYPE
FUNCTION G : BOOL
VAR_IN_OUT x : BOOL; END_VAR
G := x;
END_FUNCTION
FUNCTION MkI : ST_A
VAR q : POINTER TO BOOL; END_VAR
q := ADR(MkI.a);
G(MkI.b);
END_FUNCTION
FUNCTION_BLOCK FB
METHOD M : ST_B
VAR q : POINTER TO BOOL; END_VAR
q := ADR(M.a);
END_METHOD
PROPERTY P : ST_B
GET
VAR q : POINTER TO BOOL; END_VAR
q := ADR(P.a);
END_GET
END_PROPERTY
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR s : ST_A; END_VAR
s := MkI();
END_PROGRAM
`;
    expect(
      diag(src, { features: ["+bit_type", "+pointer_to", "+property"] }).errors,
    ).toEqual([
      `10:3: VAR_IN_OUT 'X' cannot be bound to the BIT member MKI.B: ${tail}`,
      `15:10: ADR() cannot take the BIT member M.A: ${tail}`,
      `20:10: ADR() cannot take the BIT member P.A: ${tail}`,
      `9:10: ADR() cannot take the BIT member MKI.A: ${tail}`,
    ]);
  });
});
