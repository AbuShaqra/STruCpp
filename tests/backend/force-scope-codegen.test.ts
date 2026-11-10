// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Codegen for the force table: every PROGRAM cycle holds a force::Scope, an
 * enumeration without a declared base is stored as INT (DINT when its values
 * need it), and the debug table states which of its arrays hold globals.
 */

import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

const CFG = `
CONFIGURATION Config0
  VAR_GLOBAL g : INT; END_VAR
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
    PROGRAM instance1 WITH task0 : Other;
  END_RESOURCE
END_CONFIGURATION`;

const SCOPE_LINE = "    force::Scope __force_scope(this, sizeof(*this));";

function ok(source: string) {
  const result = compile(source, { headerFileName: "generated.hpp" });
  expect(result.errors.map((e) => e.message)).toEqual([]);
  expect(result.success).toBe(true);
  return result;
}

describe("force::Scope around a PROGRAM cycle", () => {
  it("opens the run() of a standalone PROGRAM", () => {
    const result = ok(`
      PROGRAM Main
        VAR x : INT; END_VAR
        x := x + 1;
      END_PROGRAM
    `);
    expect(result.cppCode).toContain(
      `void Program_MAIN::run() {\n${SCOPE_LINE}\n`,
    );
    expect(result.headerCode).toContain('#include "iec_force.hpp"');
  });

  it("opens the run() of every PROGRAM of a configuration, empty bodies included", () => {
    const result = ok(`
      PROGRAM Main
        VAR x : INT; END_VAR
        VAR_EXTERNAL g : INT; END_VAR
        x := g;
      END_PROGRAM
      PROGRAM Other
      END_PROGRAM
      ${CFG}
    `);
    expect(result.cppCode).toContain(
      `void Program_MAIN::run() {\n${SCOPE_LINE}\n`,
    );
    expect(result.cppCode).toContain(
      `void Program_OTHER::run() {\n${SCOPE_LINE}\n`,
    );
  });

  it("is not added to function blocks or functions", () => {
    const result = ok(`
      FUNCTION_BLOCK Fb
        VAR_INPUT i : INT; END_VAR
        i := i + 1;
      END_FUNCTION_BLOCK
      FUNCTION F : INT
        VAR_INPUT a : INT; END_VAR
        F := a;
      END_FUNCTION
      PROGRAM Main
        VAR b : Fb; r : INT; END_VAR
        b(i := 1);
        r := F(2);
      END_PROGRAM
    `);
    expect(result.cppCode.split("force::Scope").length - 1).toBe(1);
  });
});

describe("enumeration storage without a declared base", () => {
  it("is INT", () => {
    const result = ok(`
      TYPE Color : (RED, GREEN, BLUE); END_TYPE
      PROGRAM Main VAR c : Color; END_VAR END_PROGRAM
    `);
    expect(result.headerCode).toContain(
      "enum class COLOR : INT_t { RED, GREEN, BLUE };",
    );
  });

  it("is DINT when a value is outside the INT range", () => {
    const result = ok(`
      TYPE Big : (SMALL := 1, LARGE := 40000); END_TYPE
      TYPE Low : (NEG := -40000, ZERO := 0); END_TYPE
      TYPE Climb : (FIRST := 32767, SECOND); END_TYPE
      PROGRAM Main VAR b : Big; l : Low; c : Climb; END_VAR END_PROGRAM
    `);
    expect(result.headerCode).toContain("enum class BIG : DINT_t {");
    expect(result.headerCode).toContain("enum class LOW : DINT_t {");
    expect(result.headerCode).toContain("enum class CLIMB : DINT_t {");
  });

  it("stays INT at the INT bounds", () => {
    const result = ok(`
      TYPE Edge : (LO := -32768, HI := 32767); END_TYPE
      PROGRAM Main VAR e : Edge; END_VAR END_PROGRAM
    `);
    expect(result.headerCode).toContain("enum class EDGE : INT_t {");
  });

  it("keeps a declared base", () => {
    const result = ok(`
      TYPE Small : USINT (A := 1, B := 2); END_TYPE
      PROGRAM Main VAR s : Small; END_VAR END_PROGRAM
    `);
    expect(result.headerCode).toContain("enum class SMALL : USINT_t {");
  });

  it("is INT for an inline enumeration", () => {
    const result = ok(`
      PROGRAM Main VAR a : (IDLE, BUSY); END_VAR END_PROGRAM
    `);
    expect(result.headerCode).toMatch(
      /enum class __INLINE_ENUM_MAIN_A : INT_t \{/,
    );
  });

  it("is tagged in the debug table as the base it is stored as", () => {
    const result = ok(`
      TYPE Color : (RED, GREEN); END_TYPE
      TYPE Big : (SMALL := 1, LARGE := 40000); END_TYPE
      PROGRAM Main VAR c : Color; b : Big; END_VAR END_PROGRAM
      CONFIGURATION Config0
        RESOURCE Res0 ON PLC
          TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
          PROGRAM instance0 WITH task0 : Main;
        END_RESOURCE
      END_CONFIGURATION
    `);
    expect(result.debugTableCpp).toContain("TAG_INT, 0 },  // INSTANCE0.C");
    expect(result.debugTableCpp).toContain("TAG_DINT, 0 },  // INSTANCE0.B");
  });
});

describe("debug_array_kind", () => {
  it("marks the global arrays 1 and the program-instance arrays 0", () => {
    const result = ok(`
      PROGRAM Main VAR x : INT; END_VAR END_PROGRAM
      PROGRAM Other VAR y : INT; END_VAR END_PROGRAM
      ${CFG}
    `);
    expect(result.debugTableCpp).toContain(
      "const uint8_t debug_array_kind[3] STRUCPP_DEBUG_FLASH = {\n    DEBUG_ARRAY_GLOBAL,\n    DEBUG_ARRAY_PROGRAM,\n    DEBUG_ARRAY_PROGRAM,\n};",
    );
  });

  it("has no global array when the configuration declares no globals", () => {
    const result = ok(`
      PROGRAM Main VAR x : INT; END_VAR END_PROGRAM
      CONFIGURATION Config0
        RESOURCE Res0 ON PLC
          TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
          PROGRAM instance0 WITH task0 : Main;
        END_RESOURCE
      END_CONFIGURATION
    `);
    expect(result.debugTableCpp).toContain(
      "const uint8_t debug_array_kind[1] STRUCPP_DEBUG_FLASH = {\n    DEBUG_ARRAY_PROGRAM,\n};",
    );
  });
});
