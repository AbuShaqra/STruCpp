/**
 * E2E: the initial value of a global may name a global declared later, in
 * the same file or another list file, as a value or as the target of ADR().
 * Globals are emitted in dependency order; only a true cycle is refused.
 * Under --strict an initial value reads only CONSTANT globals, so the strict
 * modes order the same program with its read globals made CONSTANT.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const GVL_IO = `VAR_GLOBAL
  level : INT := GVL_Cfg.K + 1;
  pLevel : POINTER TO INT := ADR(GVL_Cfg.target);
END_VAR
`;

const GVL_CFG = `VAR_GLOBAL CONSTANT
  K : INT := 7;
END_VAR
VAR_GLOBAL
  target : INT := 40;
END_VAR
`;

const MAIN = `FUNCTION_BLOCK FB_X
VAR v : INT := 4; END_VAR
END_FUNCTION_BLOCK
VAR_GLOBAL
  a : INT := b + 1;
  b : INT := c * 2;
  c : INT := 3;
  first : INT := 100;
  pc : POINTER TO INT := ADR(late);
  arr : ARRAY[0..1] OF INT := [late, c];
  late : INT := 9;
  pfb : POINTER TO FB_X := ADR(gfb);
  gfb : FB_X;
  fromList : INT := GVL_Io.level + K;
  self : POINTER TO POINTER TO INT := ADR(pc);
END_VAR
PROGRAM Main
VAR n1, n2, n3, n4, n5, n6 : INT; END_VAR
VAR_EXTERNAL
  a, b, first, fromList : INT; pc : POINTER TO INT;
  arr : ARRAY[0..1] OF INT; pfb : POINTER TO FB_X;
END_VAR
  n1 := a;
  n2 := b + first;
  pc^ := pc^ + 1;
  n3 := pc^ + arr[0] + arr[1];
  n4 := pfb^.v;
  n5 := fromList + GVL_Io.level;
  GVL_Io.pLevel^ := GVL_Io.pLevel^ + 2;
  n6 := GVL_Cfg.target;
END_PROGRAM
`;

const GVL_IO_K = `VAR_GLOBAL CONSTANT
  level : INT := GVL_Cfg.K + 1;
END_VAR
VAR_GLOBAL
  pLevel : POINTER TO INT := ADR(GVL_Cfg.target);
END_VAR
`;

const MAIN_K = `FUNCTION_BLOCK FB_X
VAR v : INT := 4; END_VAR
END_FUNCTION_BLOCK
VAR_GLOBAL
  a : INT := b + 1;
  first : INT := 100;
  pc : POINTER TO INT := ADR(late);
  arr : ARRAY[0..1] OF INT := [lateK, c];
  late : INT := 9;
  pfb : POINTER TO FB_X := ADR(gfb);
  gfb : FB_X;
  fromList : INT := GVL_Io.level + K;
  self : POINTER TO POINTER TO INT := ADR(pc);
END_VAR
VAR_GLOBAL CONSTANT
  b : INT := c * 2;
  c : INT := 3;
  lateK : INT := 9;
END_VAR
PROGRAM Main
VAR n1, n2, n3, n4, n5, n6 : INT; END_VAR
VAR_EXTERNAL
  a, first, fromList : INT; pc : POINTER TO INT;
  arr : ARRAY[0..1] OF INT; pfb : POINTER TO FB_X;
END_VAR
  n1 := a;
  n2 := b + first;
  pc^ := pc^ + 1;
  n3 := pc^ + arr[0] + arr[1];
  n4 := pfb^.v;
  n5 := fromList + GVL_Io.level;
  GVL_Io.pLevel^ := GVL_Io.pLevel^ + 2;
  n6 := GVL_Cfg.target;
END_PROGRAM
`;

const sources = (main: string, gvlIo: string) => ({
  main,
  options: {
    fileName: "main.st",
    additionalSources: [
      { source: gvlIo, fileName: "GVL_Io.st" },
      { source: GVL_CFG, fileName: "GVL_Cfg.st" },
    ],
  },
});
const SOURCES = sources(MAIN, GVL_IO);
const SOURCES_K = sources(MAIN_K, GVL_IO_K);

const STRICT_MODES: Array<[string, Parameters<typeof compile>[1]]> = [
  ["strict", { strict: true, features: ["+named_global_lists"] }],
  [
    "strict vendor profile",
    {
      strict: true,
      dialect: {
        id: "vendor-x",
        name: "Vendor X",
        extends: "iec-3",
        features: ["named_global_lists", "pointer_to"],
        semantics: {},
      },
    },
  ],
];

const MODES: Array<
  [string, Parameters<typeof compile>[1], ReturnType<typeof sources>]
> = [
  ["features", { features: ["+named_global_lists"] }, SOURCES],
  ...STRICT_MODES.map(
    ([name, options]): [
      string,
      Parameters<typeof compile>[1],
      ReturnType<typeof sources>,
    ] => [name, options, SOURCES_K],
  ),
];

const refusal = (global: string, read: string): string =>
  `The initial value of global '${global}' reads global '${read}', which is no CONSTANT: an initial value is a constant expression`;

function errorsFor(globals: string): string[] {
  return compile(
    `VAR_GLOBAL\n${globals}\nEND_VAR\nPROGRAM Main END_PROGRAM\n`,
    {},
  ).errors.map((e) => e.message);
}

describe("globals that name later globals", () => {
  it.each(MODES)("are accepted (%s)", (_name, options, src) => {
    const r = compile(src.main, { ...src.options, ...options });
    expect(r.errors.map((e) => e.message)).toEqual([]);
  });

  it.each(STRICT_MODES)(
    "are refused when they read a non-CONSTANT global (%s)",
    (_name, options) => {
      const r = compile(MAIN, { ...SOURCES.options, ...options });
      expect(
        r.errors.map((e) => `${e.file}:${e.line}:${e.column} ${e.message}`),
      ).toEqual([
        `main.st:6:14 ${refusal("B", "C")}`,
        `main.st:5:14 ${refusal("A", "B")}`,
        `main.st:10:32 ${refusal("ARR", "LATE")}`,
        `main.st:10:38 ${refusal("ARR", "C")}`,
        `main.st:14:21 ${refusal("FROMLIST", "LEVEL")}`,
      ]);
    },
  );

  it.each(STRICT_MODES)(
    "emits a global after the later CONSTANT it names (%s)",
    (_name, options) => {
      const r = compile(MAIN_K, { ...SOURCES_K.options, ...options });
      expect(r.errors).toEqual([]);
      const h = r.headerCode;
      const at = (name: string): number =>
        h.search(new RegExp(`^(?:const )?inline .* ${name} = `, "m"));
      for (const name of ["A", "B", "C", "LATEK", "ARR", "LEVEL", "FROMLIST"]) {
        expect(at(name)).toBeGreaterThanOrEqual(0);
      }
      expect(at("C")).toBeLessThan(at("B"));
      expect(at("B")).toBeLessThan(at("A"));
      expect(at("LATEK")).toBeLessThan(at("ARR"));
      expect(at("LEVEL")).toBeLessThan(at("FROMLIST"));
    },
  );

  it("keeps declaration order when nothing depends on a later global", () => {
    const r = compile(
      `VAR_GLOBAL\n  z : INT := 1;\n  y : INT := z;\n  x : INT := 3;\nEND_VAR\nPROGRAM Main END_PROGRAM\n`,
      {},
    );
    const order = [...r.headerCode.matchAll(/^inline IEC_INT (\w+)/gm)].map(
      (m) => m[1],
    );
    expect(order).toEqual(["Z", "Y", "X"]);
  });

  it("emits a global after the later global it names", () => {
    const r = compile(
      `VAR_GLOBAL\n  x : INT := y + 1;\n  w : INT := 5;\n  y : INT := 2;\nEND_VAR\nPROGRAM Main END_PROGRAM\n`,
      {},
    );
    expect(r.errors).toEqual([]);
    const order = [...r.headerCode.matchAll(/^inline IEC_INT (\w+)/gm)].map(
      (m) => m[1],
    );
    expect(order).toEqual(["Y", "X", "W"]);
  });

  it("refuses a cycle, naming it", () => {
    expect(errorsFor("  d : INT := d2;\n  d2 : INT := d;")).toEqual([
      "The initial values of the globals 'D' and 'D2' depend on each other (D -> D2 -> D)",
    ]);
    expect(
      errorsFor(
        "  p : INT := q + 1;\n  q : INT := r;\n  r : INT := p;\n  ok : INT := 1;",
      ),
    ).toEqual([
      "The initial values of the globals 'P', 'Q' and 'R' depend on each other (P -> Q -> R -> P)",
    ]);
    expect(
      errorsFor(
        "  pa : POINTER TO POINTER TO INT := ADR(pb);\n  pb : POINTER TO POINTER TO INT := ADR(pa);",
      ),
    ).toEqual([
      "The initial values of the globals 'PA' and 'PB' depend on each other (PA -> PB -> PA)",
    ]);
  });

  it("refuses a pointer or reference default in a STRUCT field", () => {
    const errors = (field: string): string[] =>
      compile(
        `TYPE ST_P : STRUCT x : INT; ${field} END_STRUCT END_TYPE
VAR_GLOBAL gz : INT; gp : POINTER TO INT; END_VAR
PROGRAM Main VAR st : ST_P; END_VAR END_PROGRAM`,
        {},
      ).errors.map((e) => e.message);
    expect(errors("p : POINTER TO INT := ADR(gz);")).toEqual([
      "POINTER TO initializers are not supported in a STRUCT; assign 'ST_P.P' in the body instead",
    ]);
    expect(errors("p : POINTER TO INT := ADR(x);")).toEqual([
      "POINTER TO initializers are not supported in a STRUCT; assign 'ST_P.P' in the body instead",
    ]);
    expect(errors("p : POINTER TO INT := gp;")).toEqual([
      "POINTER TO initializers are not supported in a STRUCT; assign 'ST_P.P' in the body instead",
    ]);
    expect(errors("p : POINTER TO INT := 0;")).toEqual([]);
    expect(errors("r : REF_TO INT := NULL;")).toEqual([]);
    expect(errors("p : POINTER TO INT;")).toEqual([]);
  });
});

describe.skipIf(!hasGpp)("globals that name later globals, run", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-gorder-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it.each(MODES)("builds and runs (%s)", (name, options, src) => {
    const r = compile(src.main, {
      ...src.options,
      ...options,
      headerFileName: "generated.hpp",
    });
    expect(r.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: r.headerCode,
      cppCode: r.cppCode,
      testName: `global_order_${name.replace(/ /g, "_")}`,
      mainCode: `#include <iostream>
int main() {
  strucpp::Program_MAIN p;
  p.run();
  std::cout << (int)p.N1 << " " << (int)p.N2 << " " << (int)p.N3 << " "
            << (int)p.N4 << " " << (int)p.N5 << " " << (int)p.N6 << std::endl;
  return 0;
}
`,
    });
    expect(out).toBe("7 106 22 4 23 42");
  });
});

describe.skipIf(!hasGpp)(
  "a method call on an FB global and VAR_EXTERNAL CONSTANT, run",
  () => {
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-gmethod-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    it("creates the global after the FB whose method it calls", () => {
      const r = compile(
        `FUNCTION_BLOCK FB_A
VAR v : INT := 3; END_VAR
METHOD M : INT
M := v * 2;
END_METHOD
END_FUNCTION_BLOCK
VAR_GLOBAL CONSTANT K : INT := 7; END_VAR
VAR_GLOBAL
  x : INT := f.M() + 1;
  f : FB_A;
END_VAR
PROGRAM Main
VAR_EXTERNAL x : INT; END_VAR
VAR_EXTERNAL CONSTANT K : INT; END_VAR
VAR n1, n2 : INT; END_VAR
n1 := x;
n2 := K;
END_PROGRAM
`,
        { headerFileName: "generated.hpp" },
      );
      expect(r.errors).toEqual([]);
      const out = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: r.headerCode,
        cppCode: r.cppCode,
        testName: "global_method_call",
        mainCode: `#include <iostream>
int main() {
  strucpp::Program_MAIN p;
  p.run();
  std::cout << (int)p.N1 << " " << (int)p.N2 << std::endl;
  return 0;
}
`,
      });
      expect(out).toBe("7 7");
    });

    it("creates it after the globals the called code reads, transitively", () => {
      const r = compile(
        `FUNCTION_BLOCK FB_A
VAR inner : FB_C; END_VAR
METHOD M : INT
M := gy;
END_METHOD
METHOD N : INT
inner();
N := inner.q + Fn();
END_METHOD
PROPERTY P : INT
GET
P := gp;
END_GET
END_PROPERTY
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_B
VAR v : INT := 7; END_VAR
METHOD M : INT
M := v;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_C
VAR_OUTPUT q : INT; END_VAR
q := gq;
END_FUNCTION_BLOCK
FUNCTION Fn : INT
VAR_EXTERNAL gf : INT; END_VAR
Fn := gf;
END_FUNCTION
VAR_GLOBAL
  x : INT := f.M();
  n : INT := f.N();
  y : INT := f.P;
  f : FB_A;
  g2 : FB_B;
  gy : INT := g2.M();
  gq : INT := 1;
  gp : INT := 2;
  gf : INT := 3;
END_VAR
PROGRAM Main
VAR_EXTERNAL x, n, y : INT; END_VAR
VAR n1, n2, n3 : INT; END_VAR
n1 := x;
n2 := n;
n3 := y;
END_PROGRAM
`,
        { headerFileName: "generated.hpp" },
      );
      expect(r.errors).toEqual([]);
      const out = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: r.headerCode,
        cppCode: r.cppCode,
        testName: "global_method_reads",
        mainCode: `#include <iostream>
int main() {
  strucpp::Program_MAIN p;
  p.run();
  std::cout << (int)p.N1 << " " << (int)p.N2 << " " << (int)p.N3 << std::endl;
  return 0;
}
`,
      });
      expect(out).toBe("7 4 2");
    });

    const run = (
      name: string,
      src: string,
      outputs: string[],
      features: string[] = [],
    ): string => {
      const r = compile(src, { headerFileName: "generated.hpp", features });
      expect(r.errors).toEqual([]);
      return compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: r.headerCode,
        cppCode: r.cppCode,
        testName: name,
        mainCode: `#include <iostream>
int main() {
  strucpp::Program_MAIN p;
  p.run();
  std::cout${outputs.map((o) => ` << (int)p.${o} << " "`).join("")} << std::endl;
  return 0;
}
`,
      }).trim();
    };

    it("follows a bare property, a property through a member and member initial values", () => {
      expect(
        run(
          "global_reads_members",
          `FUNCTION_BLOCK FB_P
PROPERTY P : INT
GET
P := gp;
END_GET
END_PROPERTY
METHOD M : INT
M := P;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_O
VAR_OUTPUT inner : FB_P; END_VAR
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_C
VAR v : INT := gz; END_VAR
METHOD M : INT
M := v;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_H
VAR c : FB_C; END_VAR
METHOD M : INT
M := c.M() + 1;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_K
VAR_INPUT v : INT; END_VAR
METHOD Get : INT
Get := v;
END_METHOD
END_FUNCTION_BLOCK
VAR_GLOBAL
  y2 : INT := f.M();
  y3 : INT := o.inner.P;
  x : INT := c.M();
  xh : INT := h.M();
  f : FB_P;
  o : FB_O;
  h : FB_H;
  c : FB_C;
  k1 : FB_K := (v := 6);
  k2 : FB_K := (v := 9);
  gp : INT := k1.Get();
  gz : INT := k2.Get();
END_VAR
PROGRAM Main
VAR_EXTERNAL y2, y3, x, xh : INT; END_VAR
VAR o1, o2, o3, o4 : INT; END_VAR
o1 := y2; o2 := y3; o3 := x; o4 := xh;
END_PROGRAM
`,
          ["O1", "O2", "O3", "O4"],
        ),
      ).toBe("6 6 9 10");
    });

    it("a property read runs only its getter", () => {
      expect(
        run(
          "global_reads_fc5",
          `FUNCTION_BLOCK FB_P
VAR inner : INT := 7; END_VAR
PROPERTY P : INT
GET
P := inner;
END_GET
SET
inner := P + gq;
END_SET
END_PROPERTY
END_FUNCTION_BLOCK
VAR_GLOBAL
  f : FB_P;
  x : INT := f.P;
  gq : INT := x + 1;
END_VAR
PROGRAM Main
VAR_EXTERNAL gq : INT; END_VAR
VAR o1 : INT; END_VAR
o1 := gq;
END_PROGRAM
`,
          ["O1"],
          [],
        ),
      ).toBe("8");
    });

    it("a bare method call on an exact instance runs its own method", () => {
      expect(
        run(
          "global_reads_fc4c",
          `FUNCTION_BLOCK FB_A
METHOD M : INT
M := 1;
END_METHOD
PROPERTY Q : INT
GET
Q := M() + 10;
END_GET
END_PROPERTY
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_B EXTENDS FB_A
METHOD M : INT
M := g;
END_METHOD
END_FUNCTION_BLOCK
VAR_GLOBAL
  a : FB_A;
  x : INT := a.Q;
  g : INT := x + 100;
END_VAR
PROGRAM Main
VAR_EXTERNAL g : INT; END_VAR
VAR o1 : INT; END_VAR
o1 := g;
END_PROGRAM
`,
          ["O1"],
          ["+property"],
        ),
      ).toBe("111");
    });

    it("FB_init is not part of creating a global instance", () => {
      expect(
        run(
          "global_reads_fc8",
          `FUNCTION_BLOCK FB_P
VAR v : INT := 4; c : INT; END_VAR
METHOD FB_init : BOOL
VAR_INPUT bInitRetains : BOOL; bInCopyCode : BOOL; END_VAR
c := g;
END_METHOD
PROPERTY P : INT
GET
P := v;
END_GET
END_PROPERTY
END_FUNCTION_BLOCK
VAR_GLOBAL
  f : FB_P;
  x : INT := f.P;
  g : INT := x + 1;
END_VAR
PROGRAM Main
VAR_EXTERNAL g : INT; END_VAR
VAR o1 : INT; END_VAR
o1 := g;
END_PROGRAM
`,
          ["O1"],
          ["+property", "+fb_init"],
        ),
      ).toBe("5");
    });

    it("a property through an interface bound to a global instance", () => {
      expect(
        run(
          "global_reads_i1",
          `INTERFACE I_P
PROPERTY P : INT
GET
END_GET
END_PROPERTY
END_INTERFACE
FUNCTION_BLOCK FB_F IMPLEMENTS I_P
VAR v : INT := 4; END_VAR
PROPERTY P : INT
GET
P := v;
END_GET
END_PROPERTY
END_FUNCTION_BLOCK
VAR_GLOBAL
  f : FB_F;
  itf : I_P := f;
  x : INT := itf.P;
END_VAR
PROGRAM Main
VAR_EXTERNAL x : INT; END_VAR
VAR o1 : INT; END_VAR
o1 := x;
END_PROGRAM
`,
          ["O1"],
          ["+property"],
        ),
      ).toBe("4");
    });

    it("an address taken in a getter closes no cycle", () => {
      expect(
        run(
          "global_reads_fc7",
          `FUNCTION_BLOCK FB_P
VAR v : INT := 4; pp : POINTER TO INT; END_VAR
PROPERTY P : INT
GET
pp := ADR(gbuf);
P := v;
END_GET
END_PROPERTY
END_FUNCTION_BLOCK
VAR_GLOBAL
  f : FB_P;
  x : INT := f.P;
  gbuf : INT := x + 1;
END_VAR
PROGRAM Main
VAR_EXTERNAL gbuf : INT; END_VAR
VAR o1 : INT; END_VAR
o1 := gbuf;
END_PROGRAM
`,
          ["O1"],
          ["+property"],
        ),
      ).toBe("5");
    });

    it("a dereferenced global pointer still orders", () => {
      expect(
        run(
          "global_reads_m2",
          `FUNCTION_BLOCK FB_K
VAR v : INT := 5; END_VAR
METHOD N : INT
N := v;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_F
METHOD M : INT
M := gp^ * 2;
END_METHOD
END_FUNCTION_BLOCK
VAR_GLOBAL
  x : INT := f.M();
  f : FB_F;
  gp : POINTER TO INT := ADR(g);
  g : INT := k.N();
  k : FB_K;
END_VAR
PROGRAM Main
VAR_EXTERNAL x : INT; END_VAR
VAR o1 : INT; END_VAR
o1 := x;
END_PROGRAM
`,
          ["O1"],
          [],
        ),
      ).toBe("10");
    });

    it("a VAR_IN_OUT may be bound to a derived instance", () => {
      expect(
        run(
          "global_reads_n8",
          `FUNCTION_BLOCK FB_K
VAR v : INT := 5; END_VAR
METHOD N : INT
N := v;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_T
METHOD M : INT
M := 1;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_T2 EXTENDS FB_T
METHOD M : INT
M := g * 2;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_F
METHOD M : INT
VAR_IN_OUT io : FB_T; END_VAR
M := io.M();
END_METHOD
END_FUNCTION_BLOCK
VAR_GLOBAL
  x : INT := f.M(io := t2);
  f : FB_F;
  t2 : FB_T2;
  g : INT := k.N();
  k : FB_K;
END_VAR
PROGRAM Main
VAR_EXTERNAL x : INT; END_VAR
VAR o1 : INT; END_VAR
o1 := x;
END_PROGRAM
`,
          ["O1"],
          [],
        ),
      ).toBe("10");
    });

    it("follows a call through a pointer, an FB member and a STRUCT member", () => {
      expect(
        run(
          "global_reads_receivers",
          `INTERFACE I_X
METHOD M : INT
END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB_X IMPLEMENTS I_X
VAR_OUTPUT sub : FB_Y; END_VAR
METHOD M : INT
M := gq;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Y
METHOD M : INT
M := gw;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Q
VAR_INPUT v : INT; END_VAR
METHOD Get : INT
Get := v;
END_METHOD
END_FUNCTION_BLOCK
TYPE ST_S : STRUCT f : FB_Y; END_STRUCT END_TYPE
VAR_GLOBAL
  x1 : INT := px^.M();
  x2 : INT := fx.sub.M();
  x3 : INT := ss.f.M();
  fx : FB_X;
  px : POINTER TO FB_X := ADR(fx);
  ss : ST_S;
  k1 : FB_Q := (v := 3);
  k2 : FB_Q := (v := 4);
  gq : INT := k1.Get();
  gw : INT := k2.Get();
END_VAR
PROGRAM Main
VAR_EXTERNAL x1, x2, x3 : INT; END_VAR
VAR o1, o2, o3 : INT; END_VAR
o1 := x1; o2 := x2; o3 := x3;
END_PROGRAM
`,
          ["O1", "O2", "O3"],
        ),
      ).toBe("3 4 4");
      expect(
        run(
          "global_reads_receivers_const",
          `INTERFACE I_X
METHOD M : INT
END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB_X IMPLEMENTS I_X
VAR_OUTPUT sub : FB_Y; END_VAR
METHOD M : INT
M := 3;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Y
METHOD M : INT
M := 4;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Q
VAR_INPUT v : INT; END_VAR
METHOD Get : INT
Get := v;
END_METHOD
END_FUNCTION_BLOCK
TYPE ST_S : STRUCT f : FB_Y; END_STRUCT END_TYPE
VAR_GLOBAL
  x1 : INT := px^.M();
  x2 : INT := fx.sub.M();
  x3 : INT := ss.f.M();
  fx : FB_X;
  px : POINTER TO FB_X := ADR(fx);
  ss : ST_S;
  k1 : FB_Q := (v := 3);
  k2 : FB_Q := (v := 4);
  gq : INT := k1.Get();
  gw : INT := k2.Get();
END_VAR
PROGRAM Main
VAR_EXTERNAL x1, x2, x3 : INT; END_VAR
VAR o1, o2, o3 : INT; END_VAR
o1 := x1; o2 := x2; o3 := x3;
END_PROGRAM
`,
          ["O1", "O2", "O3"],
        ),
      ).toBe("3 4 4");
    });
  },
);
