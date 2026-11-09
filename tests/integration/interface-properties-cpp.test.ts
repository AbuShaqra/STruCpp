/**
 * Interface properties (feature property) end to end through g++: a GET-only
 * property on a base interface and a GET+SET property on an extending one,
 * implemented by an FB hierarchy and reached through interface variables, a
 * reassigned variable, a base-interface variable and a member chain, and a
 * property of a shared base interface (diamond).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import type { DialectProfile } from "../../src/dialect.js";
import { hasGpp, createPCH, compileAndRunStandalone } from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

const SOURCE = `INTERFACE IReading
PROPERTY Value : INT
GET END_GET
END_PROPERTY
END_INTERFACE

INTERFACE ISetpoint EXTENDS IReading
PROPERTY Target : INT
GET END_GET
SET END_SET
END_PROPERTY
END_INTERFACE

FUNCTION_BLOCK FB_Sensor IMPLEMENTS ISetpoint
VAR t : INT; END_VAR
PROPERTY Value : INT
GET
  Value := t * 2;
END_GET
END_PROPERTY
PROPERTY Target : INT
GET
  Target := t;
END_GET
SET
  t := Target;
END_SET
END_PROPERTY
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_Fast EXTENDS FB_Sensor
PROPERTY Value : INT
GET
  Value := t * 10;
END_GET
END_PROPERTY
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_Fixed IMPLEMENTS IReading
VAR k : INT := 99; END_VAR
PROPERTY Value : INT
GET
  Value := k;
END_GET
SET
  k := Value;
END_SET
END_PROPERTY
END_FUNCTION_BLOCK

FUNCTION_BLOCK FB_Holder
VAR sp : ISetpoint; END_VAR
END_FUNCTION_BLOCK

FUNCTION ReadOf : INT
VAR_INPUT r : IReading; END_VAR
  ReadOf := r.Value;
END_FUNCTION

PROGRAM MAIN
VAR
  s : FB_Sensor; fast : FB_Fast; fx : FB_Fixed; holder : FB_Holder;
  r : IReading; sp : ISetpoint;
  A : INT; B : INT; C : INT; D : INT; E : INT; F : INT; G : INT; H : INT;
END_VAR
  sp := s;
  sp.Target := 3;
  A := sp.Target;
  B := sp.Value;
  r := sp;
  C := r.Value;
  sp := fast;
  sp.Target := 4;
  D := sp.Value;
  r := fx;
  E := r.Value;
  holder.sp := fast;
  holder.sp.Target := 5;
  F := holder.sp.Value;
  G := ReadOf(s) + ReadOf(fast);
  H := fx.Value;
END_PROGRAM
`;

const PROFILE: DialectProfile = {
  id: "props",
  name: "props",
  extends: "iec-3",
  features: ["property"],
  semantics: {},
};

describeIfGpp("interface properties end to end", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-itfprops-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function run(
    name: string,
    options: Parameters<typeof compile>[1],
    source = SOURCE,
    fields = ["A", "B", "C", "D", "E", "F", "G", "H"],
  ): string {
    const result = compile(source, {
      headerFileName: "generated.hpp",
      ...options,
    });
    expect(result.errors.map((e) => `${e.line}: ${e.message}`)).toEqual([]);
    return compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: name,
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p;\n p.run();\n std::cout << ${fields.map((v) => `p.${v}.get()`).join(' << " " << ')} << std::endl;\n return 0;\n}\n`,
    });
  }

  // A/B: FB_Sensor through ISetpoint (t=3); C: the same instance through the
  // base interface; D: FB_Fast's own GET after reassigning (t=4); E: another
  // implementation of IReading; F: a member chain (FB_Fast, t=5); G: an
  // IReading input bound to each FB (6 + 50); H: FB_Fixed read directly.
  const EXPECTED = "3 6 6 40 99 50 56 99";

  it("runs with +property", () => {
    expect(run("itfprops_flag", { features: ["+property"] })).toBe(EXPECTED);
  });

  it("runs under a profile that enables property", () => {
    expect(run("itfprops_profile", { dialect: PROFILE })).toBe(EXPECTED);
  });

  it("a property of a shared base interface (diamond) dispatches", () => {
    const source = `INTERFACE IBase
PROPERTY Id : INT
GET END_GET
SET END_SET
END_PROPERTY
END_INTERFACE
INTERFACE ILeft EXTENDS IBase
END_INTERFACE
INTERFACE IRight EXTENDS IBase
END_INTERFACE
FUNCTION_BLOCK FB_Two IMPLEMENTS ILeft, IRight
VAR n : INT; END_VAR
PROPERTY Id : INT
GET
  Id := n;
END_GET
SET
  n := Id;
END_SET
END_PROPERTY
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR two : FB_Two; l : ILeft; r : IRight; b : IBase; X : INT; END_VAR
  l := two;
  r := two;
  b := l;
  l.Id := 7;
  X := r.Id * 100 + b.Id;
END_PROGRAM
`;
    expect(
      run("itfprops_diamond", { features: ["+property"] }, source, ["X"]),
    ).toBe("707");
  });
});
