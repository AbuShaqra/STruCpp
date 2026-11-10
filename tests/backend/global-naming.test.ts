/**
 * A global named like a runtime function or type (`EQ_TIME`, `DIVTIME`) is
 * emitted as `NAME_` at every site that declares or addresses it; a local of
 * that name and other globals keep their names.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { compileLibrary } from "../../src/library/library-compiler.js";
import { globalCppName } from "../../src/backend/global-naming.js";

describe("globalCppName", () => {
  it("renames only names the runtime declares", () => {
    expect(globalCppName("EQ_TIME")).toBe("EQ_TIME_");
    expect(globalCppName("Iec_Int")).toBe("Iec_Int_");
    expect(globalCppName("COUNTER")).toBe("COUNTER");
  });
});

describe("global named like a runtime name", () => {
  it("renames a file-level global and its references, not a local", () => {
    const r = compile(`
      VAR_GLOBAL EQ_TIME : INT := 3; KEEP : INT; END_VAR
      FUNCTION_BLOCK FB
      VAR_EXTERNAL EQ_TIME : INT; END_VAR
        EQ_TIME := EQ_TIME + 1;
      END_FUNCTION_BLOCK
      FUNCTION F : INT
      VAR TIME_TO_US : INT := 2; END_VAR
        F := TIME_TO_US;
      END_FUNCTION
      PROGRAM Main
      VAR r : INT; END_VAR
        r := EQ_TIME + KEEP + F();
      END_PROGRAM`);
    expect(r.errors).toEqual([]);
    expect(r.headerCode).toContain("inline IEC_INT EQ_TIME_ = 3;");
    expect(r.headerCode).toContain("inline IEC_INT KEEP{};");
    expect(r.cppCode).toContain("EQ_TIME_ = EQ_TIME_ + 1;");
    expect(r.cppCode).toContain("R = EQ_TIME_ + KEEP + F();");
    expect(r.cppCode).toContain("IEC_INT TIME_TO_US = 2;");
  });

  it("renames a CONFIGURATION global at its storage, bindings and debug entry", () => {
    const r = compile(`
      FUNCTION_BLOCK FBX
      VAR_EXTERNAL DIVTIME : INT; END_VAR
      END_FUNCTION_BLOCK
      PROGRAM Main
      VAR_EXTERNAL DIVTIME : INT; END_VAR
      VAR f : FBX; END_VAR
        DIVTIME := DIVTIME + 1;
        f();
      END_PROGRAM
      CONFIGURATION Cfg
      VAR_GLOBAL DIVTIME AT %MW4 : INT := 3; END_VAR
      RESOURCE Res ON PLC
      TASK T(INTERVAL := T#10ms, PRIORITY := 1);
      PROGRAM P WITH T : Main;
      END_RESOURCE
      END_CONFIGURATION`);
    expect(r.errors).toEqual([]);
    expect(r.headerCode).toContain("inline GlobalVar<IEC_INT> DIVTIME_{3};");
    expect(r.cppCode).toContain(": P(&DIVTIME_)");
    expect(r.cppCode).toContain("DIVTIME(&strucpp::DIVTIME_)");
    expect(r.cppCode).toContain(
      "locatedGlobals[0] = DIVTIME_.value.raw_ptr();",
    );
    expect(r.cppCode).toContain("DIVTIME->write(DIVTIME->read() + 1);");
    expect(r.debugTableCpp).toContain("(void*)&DIVTIME_.value");
  });

  it("renames a library global in the library and its user", () => {
    const built = compileLibrary(
      [
        {
          source: `VAR_GLOBAL EQ_TIME : INT := 5; END_VAR
          FUNCTION BumpIt : INT
            EQ_TIME := EQ_TIME + 1;
            BumpIt := EQ_TIME;
          END_FUNCTION`,
          fileName: "g.st",
        },
      ],
      { name: "glib", version: "1.0.0", namespace: "glib" },
    );
    expect(built.errors).toEqual([]);
    const r = compile(
      `PROGRAM Main
      VAR r : INT; END_VAR
        r := EQ_TIME;
      END_PROGRAM`,
      { libraries: [{ manifest: built.manifest, chunks: built.chunks }] },
    );
    expect(r.errors).toEqual([]);
    expect(r.headerCode).toContain("inline IEC_INT EQ_TIME_ = 5;");
    expect(r.cppCode).toContain("R = EQ_TIME_;");
  });
});
