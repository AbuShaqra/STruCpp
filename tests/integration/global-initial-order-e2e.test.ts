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
