// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * Generated C++ for operands the type checker now types: narrow arithmetic on
 * a THIS^/SUPER^ member, an inherited member, a property or a method result
 * is computed in DINT like any other; a signed/unsigned AND/OR/XOR in a
 * global, CONFIGURATION or STRUCT initial value is computed widened; a DWORD
 * with an untyped constant is not cut to DINT.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";

function generate(source: string): string {
  const r = compile(source, {
    headerFileName: "generated.hpp",
    features: ["+self_caret"],
  });
  expect(r.errors).toEqual([]);
  return `${r.headerCode}\n${r.cppCode}`;
}

describe("operand typing codegen", () => {
  it("computes narrow arithmetic on THIS^, SUPER^, inherited, property and method operands in DINT", () => {
    const cpp = generate(`FUNCTION_BLOCK Base
VAR x : INT := 300; END_VAR
METHOD MA : INT
MA := x;
END_METHOD
PROPERTY PA : INT
GET
PA := x;
END_GET
END_PROPERTY
END_FUNCTION_BLOCK
FUNCTION_BLOCK Derived EXTENDS Base
VAR b : INT := 200; r1, r2, r3, r4, r5, r6 : INT; fb : Base; END_VAR
r1 := SUPER^.x * b;
r2 := THIS^.x * b;
r3 := x * b;
r4 := fb.MA() * b;
r5 := THIS^.PA * b;
r6 := fb.PA * b;
END_FUNCTION_BLOCK
`);
    expect(cpp).toContain("R1 = strucpp::iec_mul<DINT_t>({BASE::X, B});");
    expect(cpp).toContain("R2 = strucpp::iec_mul<DINT_t>({this->X, B});");
    expect(cpp).toContain("R3 = strucpp::iec_mul<DINT_t>({X, B});");
    expect(cpp).toContain("R4 = strucpp::iec_mul<DINT_t>({FB.MA(), B});");
    expect(cpp).toContain(
      "R5 = strucpp::iec_mul<DINT_t>({this->get_PA(), B});",
    );
    expect(cpp).toContain("R6 = strucpp::iec_mul<DINT_t>({FB.get_PA(), B});");
  });

  it("computes signed/unsigned AND/OR/XOR in global, CONFIGURATION and STRUCT initial values widened", () => {
    const cpp =
      generate(`TYPE St : STRUCT f : LINT; g : LINT := DINT#-7 OR UDINT#4000000000; END_STRUCT; END_TYPE
VAR_GLOBAL g1 : LINT := DINT#-7 OR UDINT#4000000000; END_VAR
PROGRAM Main
VAR s : St := (f := DINT#-7 XOR UDINT#4000000000); END_VAR
END_PROGRAM
CONFIGURATION C
VAR_GLOBAL cg : LINT := DINT#-7 AND UDINT#4000000000; END_VAR
RESOURCE R ON PLC
TASK t(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM inst WITH t : Main;
END_RESOURCE
END_CONFIGURATION
`);
    expect(cpp).toContain(
      "G = static_cast<LINT_t>(-7) | static_cast<LINT_t>(4000000000);",
    );
    expect(cpp).toContain(
      "G1 = static_cast<LINT_t>(static_cast<IEC_DINT>(-7)) | static_cast<LINT_t>(static_cast<IEC_UDINT>(4000000000));",
    );
    expect(cpp).toContain(
      "CG{static_cast<LINT_t>(static_cast<IEC_DINT>(-7)) & static_cast<LINT_t>(static_cast<IEC_UDINT>(4000000000))}",
    );
    expect(cpp).toContain(
      "v0.F = static_cast<LINT_t>(static_cast<IEC_DINT>(-7)) ^ static_cast<LINT_t>(static_cast<IEC_UDINT>(4000000000));",
    );
  });

  it("keeps DWORD arithmetic with an untyped constant out of DINT", () => {
    const cpp = generate(`PROGRAM Main
VAR dw : DWORD := 4000000000; u : UDINT; END_VAR
u := SHR(dw, 1) * 2 + 3;
END_PROGRAM
`);
    expect(cpp).toContain("U = SHR(DW, 1) * 2 + 3;");
  });
});
