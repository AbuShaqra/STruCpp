/**
 * CONFIGURATION globals reached through VAR_EXTERNAL (g++): REF= rebinds the
 * global REFERENCE TO itself, a REFERENCE TO global bound by its initial
 * value, and a program's local initial values reading such globals
 * (__ISVALIDREF, SIZEOF, XSIZEOF, a plain read).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile, type CompileOptions } from "../../src/index.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const CFG = `CONFIGURATION Cfg
VAR_GLOBAL x : INT := 4; y : INT := 9; cr : REFERENCE TO INT; bound : REFERENCE TO INT := REF(y); END_VAR
RESOURCE Res ON PLC
TASK T(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM Inst WITH T : MAIN;
END_RESOURCE
END_CONFIGURATION
`;

const SOURCE = `${CFG}PROGRAM MAIN
VAR_EXTERNAL x : INT; y : INT; cr : REFERENCE TO INT; bound : REFERENCE TO INT; END_VAR
VAR
  before : BOOL := __ISVALIDREF(cr);
  boundAtStart : BOOL := __ISVALIDREF(bound);
  sz : UDINT := SIZEOF(x);
  xsz : ULINT := XSIZEOF(x);
  copy : INT := y;
  after : BOOL;
  v, w : INT;
END_VAR
cr REF= x;
after := __ISVALIDREF(cr);
v := cr;
w := bound;
END_PROGRAM
`;

describe.skipIf(!hasGpp)("CONFIGURATION references", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-cfg-refs-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("binds, reads and sizes globals reached through VAR_EXTERNAL", () => {
    for (const [opts, name] of [
      [{ features: ["+vendor_operators"] }, "cfg_refs_default"],
      [{ features: ["+vendor_operators"], strict: true }, "cfg_refs_strict"],
    ] as [Partial<CompileOptions>, string][]) {
      const result = compile(SOURCE, {
        headerFileName: "generated.hpp",
        ...opts,
      });
      expect(result.errors).toEqual([]);
      const f = (v: string): string =>
        `std::cout << (long long)c.INST.${v}.get() << " ";`;
      const out = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: name,
        mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Configuration_CFG c; c.INST.run();\n ${["BEFORE", "BOUNDATSTART", "SZ", "XSZ", "COPY", "AFTER", "V", "W"].map(f).join(" ")}\n return 0;\n}\n`,
      });
      expect(out.trim().split(/\s+/)).toEqual([
        "0",
        "1",
        "2",
        "2",
        "9",
        "1",
        "4",
        "9",
      ]);
    }
  });
});

describe("CONFIGURATION globals", () => {
  it("refuses a CONFIGURATION global named like a top-level one", () => {
    const r = compile(`VAR_GLOBAL x : INT := 1; END_VAR
${CFG}PROGRAM MAIN
VAR_EXTERNAL x : INT; END_VAR
END_PROGRAM
`);
    expect(r.errors.map((e) => `${e.line}:${e.column}: ${e.message}`)).toEqual([
      "3:12: Global 'X' of CONFIGURATION CFG is also declared in a top-level VAR_GLOBAL; rename one of them",
    ]);
  });

  it("checks a narrowing of any initial value holding XSIZEOF", () => {
    const src = `VAR_GLOBAL g : LREAL; a : UDINT := (XSIZEOF(g)); b : UINT := XSIZEOF(g) + 1; c : ULINT := XSIZEOF(g) * 2; END_VAR
PROGRAM MAIN
END_PROGRAM
`;
    const loose = compile(src, { features: ["+vendor_operators"] });
    expect(loose.errors).toEqual([]);
    expect(
      loose.warnings
        .map((w) => `${w.line}:${w.column}: ${w.message}`)
        .filter((w) => w.includes("narrowing")),
    ).toEqual([
      "1:36: Implicit narrowing conversion from ULINT to UDINT",
      "1:62: Implicit narrowing conversion from ULINT to UINT",
    ]);
    const strict = compile(src, {
      features: ["+vendor_operators"],
      strict: true,
    });
    expect(strict.errors.map((e) => e.message).sort()).toEqual([
      "Implicit conversion from ULINT to UDINT is not allowed; use ULINT_TO_UDINT",
      "Implicit conversion from ULINT to UINT is not allowed; use ULINT_TO_UINT",
    ]);
  });
});
