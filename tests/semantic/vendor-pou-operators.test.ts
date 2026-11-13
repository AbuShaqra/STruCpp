/**
 * __POUNAME, __POSITION and BITADR (feature vendor_operators), and INDEXOF
 * (refused in every dialect).
 */
import { describe, it, expect } from "vitest";
import { compile, compileStlib, type CompileOptions } from "../../src/index.js";
import {
  DEFAULT_FEATURES,
  KNOWN_FEATURES,
  resolveDialect,
  type DialectProfile,
} from "../../src/dialect.js";
import { bitAddressOf } from "../../src/semantic/vendor-pou-operators.js";

const PROFILE: DialectProfile = {
  id: "twincat3",
  name: "twincat3",
  extends: "iec-3",
  features: ["vendor_operators"],
  semantics: {},
};
const ON = { features: ["+vendor_operators"] };

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

const NAMES = `TYPE ST_Info : STRUCT
  who : STRING := __POUNAME();
  where : STRING := __POSITION();
END_STRUCT; END_TYPE
FUNCTION Fn_Name : STRING
Fn_Name := __POUNAME();
END_FUNCTION
FUNCTION_BLOCK Fb_Motor
VAR_OUTPUT a, b : STRING; END_VAR
METHOD DoIt : STRING
DoIt := __POUNAME();
END_METHOD
PROPERTY Speed : STRING
GET
Speed := __POUNAME();
END_GET
END_PROPERTY
b := __POUNAME();
ACTION Act1:
a := __POUNAME();
END_ACTION
END_FUNCTION_BLOCK
PROGRAM Main
VAR
  s1 : STRING := __POUNAME();
  s2 : STRING := __POSITION();
  s3 : STRING;
END_VAR
  s3 := __POSITION();
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

describe("__POUNAME and __POSITION", () => {
  it("are string literals naming the POU and the place", () => {
    for (const opts of [ON, { ...ON, strict: true }, { dialect: PROFILE }]) {
      const r = diag(NAMES, opts);
      expect(r.errors).toEqual([]);
      const out = r.cpp + r.hpp;
      for (const text of [
        '"ST_Info"',
        '"Line 3 (Decl)"',
        'FN_NAME_result = "Fn_Name"',
        'DOIT_result = "Fb_Motor.DoIt"',
        'SPEED_result = "Fb_Motor.Speed"',
        'B = "Fb_Motor"',
        'A = "Fb_Motor.Act1"',
        'S1("Main")',
        'S2("Line 26 (Decl)")',
        'S3 = "Line 29, Column 9 (Impl)"',
      ]) {
        expect(out).toContain(text);
      }
    }
  });

  it("name a top-level action by its owner, and a global list by its name", () => {
    const src = `VAR_GLOBAL g : STRING := __POUNAME(); END_VAR
PROGRAM Main
VAR s : STRING; END_VAR
END_PROGRAM
ACTION Main.Step:
s := __POUNAME();
END_ACTION
`;
    const r = compile(src, { ...ON, fileName: "GVL_Main.st" });
    expect(r.errors).toEqual([]);
    expect(r.cppCode + r.headerCode).toContain('"GVL_Main"');
    expect(r.cppCode).toContain('S = "Main.Step"');
  });

  it("take no argument", () => {
    const src = `PROGRAM Main
VAR s : STRING; END_VAR
s := __POUNAME(1);
s := __POSITION(s);
END_PROGRAM
`;
    expect(diag(src, ON).errors).toEqual([
      "3:6: __POUNAME takes no argument",
      "4:6: __POSITION takes no argument",
    ]);
  });

  it("are refused when the feature is off", () => {
    for (const opts of [{}, { strict: true }, { dialect: "iec-3" }]) {
      expect(diag(NAMES, opts).errors).toEqual(
        [
          "11:9: __POUNAME needs the feature vendor_operators",
          "15:10: __POUNAME needs the feature vendor_operators",
          "18:6: __POUNAME needs the feature vendor_operators",
          "20:6: __POUNAME needs the feature vendor_operators",
          "25:18: __POUNAME needs the feature vendor_operators",
          "26:18: __POSITION needs the feature vendor_operators",
          "29:9: __POSITION needs the feature vendor_operators",
          "2:19: __POUNAME needs the feature vendor_operators",
          "3:21: __POSITION needs the feature vendor_operators",
          "6:12: __POUNAME needs the feature vendor_operators",
        ].sort(),
      );
    }
  });
});

describe("BITADR", () => {
  it("encodes the area and the bit address of a % address", () => {
    expect(bitAddressOf("%IX2.3")).toBe(0x80000013);
    expect(bitAddressOf("%I2.3")).toBe(0x80000013);
    expect(bitAddressOf("%QW4")).toBe(0xc0000020);
    expect(bitAddressOf("%MB7")).toBe(0x40000038);
    expect(bitAddressOf("%MD0")).toBe(0x40000000);
    expect(bitAddressOf("%QX0.7")).toBe(0xc0000007);
    expect(bitAddressOf("%IX0.8")).toBe(
      "BITADR: bit 8 of %IX0.8 is not in 0..7",
    );
    expect(bitAddressOf("%IW1.2")).toMatch(/needs a complete address/);
    expect(bitAddressOf("%IX33554432.0")).toMatch(/beyond/);
  });

  it("is a DWORD constant of a located variable, global or external", () => {
    const src = `VAR_GLOBAL gq AT %QX1.1 : BOOL; END_VAR
PROGRAM Main
VAR x AT %IX2.3 : BOOL; d1, d2 : DWORD; END_VAR
VAR_EXTERNAL gq : BOOL; END_VAR
d1 := BITADR(x);
d2 := BITADR(gq);
END_PROGRAM
`;
    for (const opts of [ON, { ...ON, strict: true }, { dialect: PROFILE }]) {
      const r = diag(src, opts);
      expect(r.errors).toEqual([]);
      expect(r.cpp).toContain("D1 = static_cast<IEC_DWORD>(0x80000013);");
      expect(r.cpp).toContain("D2 = static_cast<IEC_DWORD>(0xC0000009);");
    }
  });

  it("needs one located variable written by name", () => {
    const src = `PROGRAM Main
VAR plain : INT; arr : ARRAY[0..1] OF BOOL; d : DWORD; END_VAR
d := BITADR(plain);
d := BITADR(arr[0]);
d := BITADR();
END_PROGRAM
`;
    expect(diag(src, ON).errors).toEqual([
      "3:13: BITADR needs a located variable (declared AT %I, %Q or %M); 'PLAIN' is not one",
      "4:13: BITADR needs a located variable (declared AT %I, %Q or %M); write it by name",
      "5:6: BITADR takes one argument, got 0",
    ]);
  });

  it("is refused when the feature is off", () => {
    const src = `PROGRAM Main
VAR x AT %IX2.3 : BOOL; d : DWORD; END_VAR
d := BITADR(x);
END_PROGRAM
`;
    expect(diag(src, { dialect: "iec-3" }).errors).toEqual([
      "3:6: BITADR needs the feature vendor_operators",
    ]);
  });
});

describe("INDEXOF", () => {
  it("is refused in every dialect, pointing to ADR", () => {
    const src = `PROGRAM Main
VAR x : INT; p : DWORD; END_VAR
p := INDEXOF(x);
END_PROGRAM
`;
    for (const opts of [{}, ON, { dialect: "iec-3" }]) {
      expect(diag(src, opts).errors).toContain(
        "3:6: INDEXOF is not supported: use ADR(x) for the address of a variable or instance",
      );
    }
  });
});

describe("a declaration of the operator's name wins", () => {
  it("leaves the call to the user's FUNCTION, with the same C++", () => {
    const src = `FUNCTION __POUNAME : STRING
__POUNAME := 'mine';
END_FUNCTION
FUNCTION BITADR : DWORD
VAR_INPUT v : INT; END_VAR
BITADR := 5;
END_FUNCTION
FUNCTION INDEXOF : INT
INDEXOF := 1;
END_FUNCTION
PROGRAM Main
VAR s : STRING; d : DWORD; i : INT; END_VAR
s := __POUNAME();
d := BITADR(i);
i := INDEXOF();
END_PROGRAM
`;
    const off = diag(src, { dialect: "iec-3" });
    const on = diag(src, { dialect: PROFILE });
    expect(off.errors).toEqual([]);
    expect(on.errors).toEqual([]);
    expect(on.cpp).toBe(off.cpp);
    expect(diag(src).cpp).toBe(off.cpp);
  });
});

describe("review regressions", () => {
  it("a local, method or STRUCT member of the name shadows only in its scope", () => {
    const src = `FUNCTION_BLOCK Fb_Other
VAR bitadr : DWORD; END_VAR
bitadr := 1;
END_FUNCTION_BLOCK
FUNCTION_BLOCK Fb_M
METHOD __POUNAME : STRING
__POUNAME := 'm';
END_METHOD
VAR_OUTPUT s : STRING; END_VAR
s := __POUNAME();
END_FUNCTION_BLOCK
TYPE St_X : STRUCT __pouname : INT; END_STRUCT END_TYPE
PROGRAM Main
VAR x AT %IX0.1 : BOOL; d : DWORD; s : STRING; END_VAR
d := BITADR(x);
s := __POUNAME();
END_PROGRAM
`;
    const r = diag(src, ON);
    expect(r.errors).toEqual([]);
    expect(r.cpp).toContain("D = static_cast<IEC_DWORD>(0x80000001);");
    expect(r.cpp).toContain("S = __POUNAME();");
    expect(r.cpp).toContain('S = "Main"');
    expect(r.cpp).not.toContain('S = "Fb_M"');
  });

  it("names a named BITADR argument as the problem", () => {
    expect(
      diag(
        `PROGRAM Main
VAR x AT %IX0.1 : BOOL; d : DWORD; END_VAR
d := BITADR(v := x);
END_PROGRAM
`,
        ON,
      ).errors,
    ).toEqual(["3:6: BITADR takes its argument without a name"]);
  });

  it("skips comments when spelling the POU name", () => {
    const r = diag(
      `PROGRAM (* runs MAIN loop *) Main
VAR s : STRING; END_VAR
s := __POUNAME();
END_PROGRAM
`,
      ON,
    );
    expect(r.errors).toEqual([]);
    expect(r.cpp).toContain('S = "Main"');
  });

  it("refuses an operator written as a statement instead of crashing", () => {
    const r = diag(
      `PROGRAM Main
VAR x AT %IX0.1 : BOOL; END_VAR
__POSITION();
__POUNAME();
BITADR(x);
END_PROGRAM
`,
      ON,
    );
    expect(r.errors).toEqual([
      "3:1: __POSITION gives a value: use it in an expression, not as a statement",
      "4:1: __POUNAME gives a value: use it in an expression, not as a statement",
      "5:1: BITADR gives a value: use it in an expression, not as a statement",
    ]);
  });

  it("lets a library global of the operator's name win", () => {
    const lib = compileStlib(
      [
        {
          source: `FUNCTION_BLOCK FB_Pos
VAR_OUTPUT o : STRING; END_VAR
o := 'lib';
END_FUNCTION_BLOCK
VAR_GLOBAL __POSITION : FB_Pos; END_VAR
`,
          fileName: "lib.st",
        },
      ],
      { name: "pos-lib", version: "1.0.0", namespace: "strucpp" },
    );
    expect(lib.success).toBe(true);
    const r = compile(
      `PROGRAM Main
VAR s : STRING; END_VAR
__POSITION();
s := __POSITION.o;
END_PROGRAM
`,
      { ...ON, libraries: [lib.archive!] },
    );
    expect(r.errors.map((e) => e.message)).toEqual([]);
    expect(r.cppCode).not.toContain("Line 3");
  });
});
