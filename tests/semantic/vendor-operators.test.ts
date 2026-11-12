/**
 * __ISVALIDREF (feature reference_to) and XSIZEOF (feature vendor_operators):
 * analysis, refusal with the feature off, and name shadowing.
 */
import { describe, it, expect } from "vitest";
import { compile, type CompileOptions } from "../../src/index.js";
import {
  DEFAULT_FEATURES,
  KNOWN_FEATURES,
  resolveDialect,
  type DialectProfile,
} from "../../src/dialect.js";

const TWINCAT3: DialectProfile = {
  id: "twincat3",
  name: "twincat3",
  extends: "iec-3",
  features: [
    "pointer_to",
    "reference_to",
    "ref_assign",
    "conditional_pragmas",
    "vendor_operators",
  ],
  semantics: {},
};
const CODESYS3: DialectProfile = { ...TWINCAT3, id: "codesys3" };

function diag(
  source: string,
  opts: Partial<CompileOptions> = {},
): { errors: string[]; cpp: string } {
  const r = compile(source, { headerFileName: "generated.hpp", ...opts });
  return {
    errors: r.errors.map((e) => `${e.line}:${e.column}: ${e.message}`),
    cpp: r.cppCode,
  };
}

const ISVALIDREF = `PROGRAM MAIN
VAR
  x : INT;
  r : REFERENCE TO INT;
  b : BOOL;
END_VAR
b := __ISVALIDREF(r);
r REF= x;
END_PROGRAM
`;

const XSIZEOF = `PROGRAM MAIN
VAR
  arr : ARRAY[0..4] OF INT;
  n : ULINT := XSIZEOF(arr);
END_VAR
n := XSIZEOF(arr);
END_PROGRAM
`;

describe("vendor_operators — the feature", () => {
  it("is known but in neither the default set nor iec-3", () => {
    expect(KNOWN_FEATURES).toContain("vendor_operators");
    expect(DEFAULT_FEATURES.has("vendor_operators")).toBe(false);
    expect(resolveDialect({ dialect: "iec-3" }).features).not.toContain(
      "vendor_operators",
    );
  });
});

describe("__ISVALIDREF", () => {
  it("is BOOL wherever reference_to is on", () => {
    for (const opts of [
      {},
      { strict: true },
      { dialect: TWINCAT3 },
      { dialect: CODESYS3 },
      { dialect: "iec-3", features: ["+reference_to", "+ref_assign"] },
    ] as Partial<CompileOptions>[]) {
      const r = diag(ISVALIDREF, opts);
      expect(r.errors).toEqual([]);
      expect(r.cpp).toContain("B = (!(R).is_null());");
    }
  });

  it("is refused without reference_to", () => {
    const r = diag(ISVALIDREF, {
      dialect: "iec-3",
      features: ["+ref_assign"],
    });
    expect(r.errors).toContain(
      "7:6: __ISVALIDREF needs the feature reference_to",
    );
  });

  it("names the loaded profiles that have the feature", () => {
    const r = diag(ISVALIDREF.replace("r : REFERENCE TO INT;", ""), {
      dialect: "iec-3",
      dialectFiles: ["t.json"],
      dialectIO: {
        readFile: () => JSON.stringify(TWINCAT3),
        listDir: () => [],
      },
    });
    expect(r.errors).toContain(
      "7:6: __ISVALIDREF needs the feature reference_to (profiles: twincat3)",
    );
  });

  it("needs one REFERENCE TO variable", () => {
    const src = `TYPE ST_H : STRUCT r : REFERENCE TO INT; END_STRUCT; END_TYPE
PROGRAM MAIN
VAR x : INT; p : REF_TO INT; h : ST_H; b : BOOL; END_VAR
b := __ISVALIDREF(x);
b := __ISVALIDREF(p);
b := __ISVALIDREF(h.r);
b := __ISVALIDREF();
b := __ISVALIDREF(h.r, h.r);
b := __ISVALIDREF(r := h.r);
END_PROGRAM
`;
    expect(diag(src).errors).toEqual([
      "4:6: __ISVALIDREF needs a REFERENCE TO variable; 'X' is declared INT",
      "5:6: __ISVALIDREF needs a REFERENCE TO variable; 'P' is declared REF_TO INT",
      "7:6: __ISVALIDREF takes one argument, got 0",
      "8:6: __ISVALIDREF takes one argument, got 2",
      "9:6: __ISVALIDREF takes its argument without a name",
    ]);
  });
});

describe("in a global's initial value", () => {
  it("resolves a CONFIGURATION REFERENCE TO and checks a narrowing", () => {
    const src = `PROGRAM MAIN
VAR_EXTERNAL cb : BOOL; END_VAR
END_PROGRAM
CONFIGURATION Cfg
VAR_GLOBAL cr : REFERENCE TO INT; cb : BOOL := __ISVALIDREF(cr); g : LREAL; n : UDINT := XSIZEOF(g); END_VAR
RESOURCE R1 ON PLC
TASK t(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM p WITH t : MAIN;
END_RESOURCE
END_CONFIGURATION
VAR_GLOBAL gg : LREAL; gn : UINT := XSIZEOF(gg); END_VAR
`;
    const loose = compile(src, { features: ["+vendor_operators"] });
    expect(loose.errors).toEqual([]);
    expect(
      loose.warnings
        .map((w) => `${w.line}: ${w.message}`)
        .filter((w) => w.includes("narrowing"))
        .sort(),
    ).toEqual([
      "11: Implicit narrowing conversion from ULINT to UINT",
      "5: Implicit narrowing conversion from ULINT to UDINT",
    ]);
    expect(
      diag(src, { features: ["+vendor_operators"], strict: true })
        .errors.map((e) => e.replace(/^\d+:\d+: /, ""))
        .filter((e) => e.startsWith("Implicit")),
    ).toEqual([
      "Implicit conversion from ULINT to UDINT is not allowed; use ULINT_TO_UDINT",
      "Implicit conversion from ULINT to UINT is not allowed; use ULINT_TO_UINT",
    ]);
  });
});

describe("XSIZEOF", () => {
  it("is ULINT with vendor_operators, in a body and an initial value", () => {
    for (const opts of [
      { features: ["+vendor_operators"] },
      { features: ["+vendor_operators"], strict: true },
      { dialect: TWINCAT3 },
      { dialect: CODESYS3 },
    ] as Partial<CompileOptions>[]) {
      const r = diag(XSIZEOF, opts);
      expect(r.errors).toEqual([]);
      expect(r.cpp).toContain("static_cast<IEC_ULINT>(IEC_SIZEOF(ARR))");
    }
  });

  it("is refused without the feature, by default and under iec-3", () => {
    for (const opts of [
      {},
      { strict: true },
      { dialect: "iec-3" },
    ] as Partial<CompileOptions>[]) {
      expect(diag(XSIZEOF, opts).errors.sort()).toEqual([
        "4:16: XSIZEOF needs the feature vendor_operators",
        "6:6: XSIZEOF needs the feature vendor_operators",
      ]);
    }
  });

  it("is a narrowing to UDINT under --strict", () => {
    const src = XSIZEOF.replace("n : ULINT := XSIZEOF(arr);", "n : UDINT;");
    expect(
      diag(src, { features: ["+vendor_operators"], strict: true }).errors,
    ).toEqual([
      "6:6: Implicit conversion from ULINT to UDINT is not allowed; use ULINT_TO_UDINT",
    ]);
  });

  it("takes one argument", () => {
    const src = `PROGRAM MAIN
VAR x : INT; n : ULINT; END_VAR
n := XSIZEOF(x, x);
END_PROGRAM
`;
    expect(diag(src, { features: ["+vendor_operators"] }).errors).toEqual([
      "3:6: XSIZEOF takes one argument, got 2",
    ]);
  });
});

describe("a declaration of the operator's name wins", () => {
  const SHADOW = `FUNCTION XSIZEOF : INT
VAR_INPUT a : INT; END_VAR
XSIZEOF := a + 1;
END_FUNCTION
FUNCTION_BLOCK FB_A
VAR_OUTPUT o : INT; END_VAR
METHOD __ISVALIDREF : INT
__ISVALIDREF := 7;
END_METHOD
o := __ISVALIDREF();
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR i : INT; END_VAR
i := XSIZEOF(3);
END_PROGRAM
`;

  it("generates the same C++ with the features on and off", () => {
    const off = diag(SHADOW, { dialect: "iec-3" });
    const on = diag(SHADOW, { dialect: TWINCAT3 });
    const dflt = diag(SHADOW);
    expect(off.errors).toEqual([]);
    expect(on.errors).toEqual([]);
    expect(on.cpp).toBe(off.cpp);
    expect(dflt.cpp).toBe(off.cpp);
    expect(on.cpp).not.toContain("is_null");
    expect(on.cpp).not.toContain("IEC_SIZEOF");
  });
});
