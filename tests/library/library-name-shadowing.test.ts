/**
 * A user declaration shadows a same-named symbol of a bundled library: the
 * library's chunk is not emitted, and a reachable library chunk that still
 * needs the shadowed name is refused before C++ is generated.
 */
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { compile } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";

const LIBS_DIR = path.resolve(__dirname, "../../libs");
const libsAvailable =
  fs.existsSync(path.join(LIBS_DIR, "oscat-basic.stlib")) &&
  fs.existsSync(path.join(LIBS_DIR, "iec-standard-fb.stlib"));

describe.skipIf(!libsAvailable)("user names shadowing library symbols", () => {
  const libraries = libsAvailable ? discoverStlibs(LIBS_DIR) : [];
  const build = (src: string, isTestBuild = false) =>
    compile(src, { libraries, isTestBuild });
  const messages = (r: ReturnType<typeof compile>) =>
    r.errors.map((e) => `${e.line}: ${e.message}`);

  it("accepts a top-level global named like a library FB or global", () => {
    const r = build(`
VAR_GLOBAL speed : INT; MATH : INT; END_VAR
PROGRAM P
VAR x : INT; END_VAR
speed := 3; MATH := 4; x := speed + MATH;
END_PROGRAM`);
    expect(messages(r)).toEqual([]);
    expect(r.headerCode).not.toMatch(/class SPEED\b/);
    expect(r.headerCode).not.toMatch(/CONSTANTS_MATH MATH/);
  });

  it("emits a user alias, FB or struct instead of the library one", () => {
    const r = build(`
TYPE SR : INT(0..10); END_TYPE
TYPE SPEED : STRUCT a : INT; END_STRUCT; END_TYPE
FUNCTION_BLOCK RS
VAR_INPUT a : INT; END_VAR
END_FUNCTION_BLOCK
PROGRAM P
VAR x : SR; s : SPEED; f : RS; END_VAR
x := 3; s.a := x; f(a := s.a);
END_PROGRAM`);
    expect(messages(r)).toEqual([]);
    expect(r.headerCode).not.toMatch(/class SR\b/);
    expect(r.headerCode.match(/class RS\s*[{:]/g)?.length).toBe(1);
    expect(
      r.headerCode.match(/(struct|class)( STRUCPP_MAY_ALIAS)? SPEED\s*[{:]/g)
        ?.length,
    ).toBe(1);
  });

  it("refuses a shadowed name a used library block depends on", () => {
    const r = build(`
FUNCTION_BLOCK R_TRIG
VAR_INPUT CLK : BOOL; END_VAR
VAR_OUTPUT Q : BOOL; END_VAR
Q := CLK;
END_FUNCTION_BLOCK
PROGRAM P
VAR c : CTU; END_VAR
c(CU := TRUE, PV := 3);
END_PROGRAM`);
    expect(messages(r)).toEqual([
      "2: 'R_TRIG' is declared here and also by library 'iec-standard-fb', " +
        "where 'CTU', which this program uses, depends on it. Rename the declaration.",
    ]);
  });

  it("refuses a shadowed global a used library function depends on", () => {
    const r = build(`
VAR_GLOBAL MATH : INT; END_VAR
PROGRAM P
VAR x : REAL; END_VAR
x := DEG(1.0);
END_PROGRAM`);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.message).toMatch(
      /^'MATH' is declared here and also by library 'oscat-basic'/,
    );
    expect(r.errors[0]!.line).toBe(2);
  });

  it("a test build leaves out the shadowed chunk and its dependents", () => {
    const r = build(
      `
FUNCTION_BLOCK R_TRIG
VAR_INPUT CLK : BOOL; END_VAR
VAR_OUTPUT Q : BOOL; END_VAR
Q := CLK;
END_FUNCTION_BLOCK
PROGRAM P
VAR t : R_TRIG; END_VAR
t(CLK := TRUE);
END_PROGRAM`,
      true,
    );
    expect(messages(r)).toEqual([]);
    expect(r.headerCode.match(/class R_TRIG\s*[{:]/g)?.length).toBe(1);
    expect(r.headerCode).not.toMatch(/class CTU\b/);
    expect(r.headerCode).toMatch(/class TON\b/);
  });

  it("a local named like a library function does not pull that function in", () => {
    const r = build(`
FUNCTION MODR : REAL
VAR_INPUT IN : REAL; DIVI : REAL; END_VAR
MODR := IN - DIVI * TRUNC(IN / DIVI);
END_FUNCTION
FUNCTION DEG : REAL
VAR_INPUT RAD : REAL; END_VAR
DEG := MODR(57.29577951308232 * RAD, 360.0);
END_FUNCTION
PROGRAM P
VAR x : REAL; END_VAR
x := DEG(1.0);
END_PROGRAM`);
    expect(messages(r)).toEqual([]);
    expect(r.cppCode.match(/IEC_REAL MODR\(/g)?.length).toBe(1);
    expect(r.cppCode).not.toMatch(/IEC_REAL RAD\(/);
  });

  it("still reports two user declarations of one name", () => {
    const r = build(`
FUNCTION_BLOCK speed
END_FUNCTION_BLOCK
VAR_GLOBAL speed : INT; END_VAR
PROGRAM P
END_PROGRAM`);
    expect(messages(r).some((m) => /SPEED/i.test(m))).toBe(true);
  });
});
