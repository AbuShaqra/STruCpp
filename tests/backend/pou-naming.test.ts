/**
 * A user FUNCTION_BLOCK, INTERFACE, TYPE or FUNCTION named like a function the
 * runtime declares at namespace scope is emitted as NAME_, at its declaration
 * and every reference; analysis keeps the ST name, and a user FUNCTION wins
 * over the standard function or operator of its name.
 */
import { describe, it, expect } from "vitest";
import { analyze, compile } from "../../src/index.js";

const messages = (r: { errors: { line: number; message: string }[] }) =>
  r.errors.map((e) => `${e.line}: ${e.message}`);

describe("POUs named like runtime functions", () => {
  it("emits a block, interface and types as NAME_", () => {
    const r = compile(`
TYPE Mid : (Lo, Hi); END_TYPE
TYPE Limit : INT(0..10); END_TYPE
INTERFACE Sel
METHOD Get : INT
END_METHOD
END_INTERFACE
FUNCTION_BLOCK Sub IMPLEMENTS Sel
VAR_INPUT e : Mid; END_VAR
METHOD Get : INT
Get := 1;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM Main
VAR s : Sub; arr : ARRAY[0..1] OF Sub; l : Limit; e : Mid := Mid#Hi; END_VAR
s(e := Mid.Lo);
arr[1](e := e);
END_PROGRAM`);
    expect(messages(r)).toEqual([]);
    expect(r.headerCode).toMatch(/class SUB_ : public SEL_\b/);
    expect(r.headerCode).toMatch(/class SEL_ \{/);
    expect(r.headerCode).toMatch(/enum class MID_\b/);
    expect(r.headerCode).toMatch(/using LIMIT_ = /);
    expect(r.headerCode).not.toMatch(/\bSUB S;|\bMID E\b/);
    expect(r.cppCode).toMatch(/MID_::HI/);
    expect(r.cppCode).toMatch(/MID_::LO/);
  });

  it("renames typed truncations too", () => {
    const r = compile(`
FUNCTION_BLOCK Trunc_Int
VAR_OUTPUT q : INT; END_VAR
END_FUNCTION_BLOCK
PROGRAM Main
VAR t : Trunc_Int; x : INT; END_VAR
t(); x := TRUNC_INT(2.7);
END_PROGRAM`);
    expect(messages(r)).toEqual([]);
    expect(r.headerCode).toMatch(/class TRUNC_INT_ \{/);
    expect(r.cppCode).toMatch(/TRUNC_INT\(/);
  });

  it("calls a user FUNCTION named like a standard function", () => {
    const src = `
FUNCTION Max : INT
VAR_INPUT a : INT; END_VAR
Max := a * 10;
END_FUNCTION
FUNCTION Adr : INT
VAR_INPUT a : INT; END_VAR
Adr := a;
END_FUNCTION
FUNCTION SizeOf : INT
VAR_INPUT a : INT; END_VAR
SizeOf := a + 1;
END_FUNCTION
PROGRAM Main
VAR x : INT; END_VAR
x := Max(5) + Adr(2) + SizeOf(3);
END_PROGRAM`;
    expect(messages(analyze(src))).toEqual([]);
    const r = compile(src);
    expect(messages(r)).toEqual([]);
    expect(r.cppCode).toMatch(/MAX_\(5\) \+ ADR_\(2\) \+ SIZEOF\(3\)/);
    expect(r.cppCode).toMatch(/MAX__result = A \* 10/);
  });

  it("keeps the standard function when only a type has its name", () => {
    const r = compile(`
TYPE Max : STRUCT a : INT; END_STRUCT; END_TYPE
PROGRAM Main
VAR m : Max; x : INT; END_VAR
x := MAX(1, 2); m.a := x;
END_PROGRAM`);
    expect(messages(r)).toEqual([]);
    expect(r.cppCode).toMatch(/= MAX\(1, 2\)/);
    expect(r.headerCode).toMatch(/MAX_ M;/);
  });

  it("reports diagnostics with the declared name", () => {
    const r = compile(`
FUNCTION_BLOCK Sub
VAR_INPUT a : INT; END_VAR
END_FUNCTION_BLOCK
PROGRAM Main
VAR s : Sub; x : INT; END_VAR
x := s;
END_PROGRAM`);
    expect(r.errors.map((e) => e.message).join("\n")).toMatch(/\bSUB\b/);
    expect(r.errors.map((e) => e.message).join("\n")).not.toMatch(/SUB_/);
  });
});
