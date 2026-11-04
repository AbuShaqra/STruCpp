/**
 * --strict: the compiler rejects the implicit conversions and the arithmetic
 * that matiec used to reject. Each case also pins the non-strict result.
 */
import { describe, it, expect } from "vitest";
import { resolve } from "path";
import { compile } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";

const libraries = discoverStlibs(resolve(__dirname, "../../libs"));

function prog(decls: string, body: string): string {
  return `PROGRAM main
  VAR
    ${decls}
  END_VAR
  ${body}
END_PROGRAM
`;
}

const DECLS = `i : INT; d : DINT; l : LINT; ui : UINT; ud : UDINT; r : REAL; lr : LREAL;
    b : BOOL; bt : BYTE; w : WORD; t : TIME; tm : TON; x : REAL; ul : ULINT; us : USINT;`;

function strict(source: string) {
  return compile(source, { strict: true, libraries });
}
function lax(source: string) {
  return compile(source, { libraries });
}

/** Strict errors as "line: message". */
function msgs(source: string): string[] {
  return strict(source).errors.map((e) => `${e.line}: ${e.message}`);
}

const conv = (v: string, t: string) =>
  `Implicit conversion from ${v} to ${t} is not allowed; use ${v}_TO_${t}`;

describe("strict mode: row a, narrowing", () => {
  it("rejects DINT -> INT and LINT -> DINT, non-strict only warns", () => {
    const src = prog(DECLS, "i := d;\nd := l;");
    expect(msgs(src)).toEqual([
      `6: ${conv("DINT", "INT")}`,
      `7: ${conv("LINT", "DINT")}`,
    ]);
    const n = lax(src);
    expect(n.errors).toEqual([]);
    expect(n.warnings.some((w) => /narrowing/i.test(w.message))).toBe(true);
  });
  it("rejects signed -> unsigned of any width", () => {
    expect(msgs(prog(DECLS, "ui := i;"))).toEqual([
      `6: ${conv("INT", "UINT")}`,
    ]);
    expect(lax(prog(DECLS, "ui := i;")).errors).toEqual([]);
  });
  it("rejects a narrowing function argument and an initial value", () => {
    const src = `FUNCTION f : INT
  VAR_INPUT p : INT; END_VAR
  f := p;
END_FUNCTION
PROGRAM main
  VAR d : DINT; k : INT := 5; n : INT; END_VAR
  n := f(p := d);
END_PROGRAM
`;
    expect(msgs(src)).toEqual([`7: ${conv("DINT", "INT")}`]);
    expect(lax(src).errors).toEqual([]);
  });
  it("rejects a narrowing RETURN value", () => {
    const src = `FUNCTION f : INT
  VAR_INPUT p : DINT; END_VAR
  f := p;
END_FUNCTION
`;
    expect(msgs(src)).toEqual([`3: ${conv("DINT", "INT")}`]);
    expect(lax(src).errors).toEqual([]);
  });
  it("rejects a narrowing initial value", () => {
    const src = `PROGRAM main
  VAR c : DINT := 5; n : INT := c; END_VAR
END_PROGRAM
`;
    const s = strict(src);
    // c is not constant, so the initial value may be rejected for another reason too
    expect(s.errors.some((e) => e.message === conv("DINT", "INT"))).toBe(true);
  });
});

describe("strict mode: row b, integer <-> real", () => {
  it("accepts the exact widenings", () => {
    for (const [v, t] of [
      ["i", "r"],
      ["ui", "d"],
      ["d", "lr"],
      ["r", "lr"],
      ["us", "i"],
      ["ud", "l"],
    ] as const) {
      const src = prog(DECLS, `${t} := ${v};`);
      expect(strict(src).errors, `${v} -> ${t}`).toEqual([]);
    }
  });
  it("rejects lossy integer -> REAL/LREAL", () => {
    expect(msgs(prog(DECLS, "r := d;"))).toEqual([
      `6: ${conv("DINT", "REAL")}`,
    ]);
    expect(msgs(prog(DECLS, "lr := l;"))).toEqual([
      `6: ${conv("LINT", "LREAL")}`,
    ]);
    expect(msgs(prog(DECLS, "r := ud;"))).toEqual([
      `6: ${conv("UDINT", "REAL")}`,
    ]);
    expect(msgs(prog(DECLS, "r := ul;"))).toEqual([
      `6: ${conv("ULINT", "REAL")}`,
    ]);
    expect(lax(prog(DECLS, "r := d;")).errors).toEqual([]);
    expect(lax(prog(DECLS, "lr := l;")).errors).toEqual([]);
  });
  it("rejects REAL/LREAL -> any integer and LREAL -> REAL", () => {
    expect(msgs(prog(DECLS, "i := r;"))).toEqual([`6: ${conv("REAL", "INT")}`]);
    expect(msgs(prog(DECLS, "l := lr;"))).toEqual([
      `6: ${conv("LREAL", "LINT")}`,
    ]);
    expect(msgs(prog(DECLS, "r := lr;"))).toEqual([
      `6: ${conv("LREAL", "REAL")}`,
    ]);
    expect(lax(prog(DECLS, "i := r;")).errors).toEqual([]);
  });
  it("rejects a lossy argument to a REAL parameter", () => {
    const src = `FUNCTION f : REAL
  VAR_INPUT p : REAL; END_VAR
  f := p;
END_FUNCTION
PROGRAM main
  VAR d : DINT; r : REAL; END_VAR
  r := f(p := d);
END_PROGRAM
`;
    expect(msgs(src)).toEqual([`7: ${conv("DINT", "REAL")}`]);
    expect(lax(src).errors).toEqual([]);
  });
  it("keeps accepting integer literals where a REAL is expected", () => {
    expect(
      strict(prog(DECLS, "r := 0; lr := 5;\nIF r > 100 THEN i := 1; END_IF;"))
        .errors,
    ).toEqual([]);
  });
});

describe("strict mode: row c, BOOL <-> numbers", () => {
  it("rejects both directions", () => {
    expect(msgs(prog(DECLS, "b := i;"))).toEqual([`6: ${conv("INT", "BOOL")}`]);
    expect(msgs(prog(DECLS, "i := b;"))).toEqual([`6: ${conv("BOOL", "INT")}`]);
    expect(msgs(prog(DECLS, "r := b;"))).toEqual([
      `6: ${conv("BOOL", "REAL")}`,
    ]);
    expect(msgs(prog(DECLS, "b := r;"))).toEqual([
      `6: ${conv("REAL", "BOOL")}`,
    ]);
    expect(msgs(prog(DECLS, "b := 1;"))).toEqual([`6: ${conv("INT", "BOOL")}`]);
    expect(msgs(prog(DECLS, "i := TRUE;"))).toEqual([
      `6: ${conv("BOOL", "INT")}`,
    ]);
  });
  it("is unchanged without strict", () => {
    expect(lax(prog(DECLS, "b := i;")).errors).toEqual([]);
  });
  it("rejects a BOOL argument to an INT parameter", () => {
    const src = `FUNCTION f : INT
  VAR_INPUT p : INT; END_VAR
  f := p;
END_FUNCTION
PROGRAM main
  VAR b : BOOL; n : INT; END_VAR
  n := f(b);
END_PROGRAM
`;
    expect(msgs(src)).toEqual([`7: ${conv("BOOL", "INT")}`]);
    expect(lax(src).errors).toEqual([]);
  });
});

describe("strict mode: rows d and e, arithmetic", () => {
  it("rejects arithmetic with a BOOL operand", () => {
    for (const op of ["+", "-", "*", "/", "MOD"]) {
      const src = prog(DECLS, `i := i ${op} b;`);
      const m = msgs(src);
      expect(m, op).toContain("6: Arithmetic on BOOL is not allowed");
      expect(
        lax(src).errors.filter((e) => /Arithmetic on/.test(e.message)),
      ).toEqual([]);
    }
  });
  it("rejects arithmetic with a bit-string operand", () => {
    expect(msgs(prog(DECLS, "w := w + 1;"))).toContain(
      "6: Arithmetic on WORD is not allowed; convert it to an integer type first",
    );
    expect(msgs(prog(DECLS, "i := i * bt;"))).toContain(
      "6: Arithmetic on BYTE is not allowed; convert it to an integer type first",
    );
    expect(lax(prog(DECLS, "w := w + 1;")).errors).toEqual([]);
  });
  it("does not touch comparison, AND/OR or integer arithmetic", () => {
    expect(
      strict(prog(DECLS, "b := b AND (i > 3);\nw := w AND 16#FF;\ni := i + 1;"))
        .errors,
    ).toEqual([]);
  });
});

describe("strict mode: row f, integer as TIME", () => {
  it("rejects an integer assigned to TIME/LTIME", () => {
    const m = (t: string) =>
      `6: An integer cannot be used as ${t}; write a TIME literal such as T#100ms`;
    expect(msgs(prog(DECLS, "t := 100;"))).toEqual([m("TIME")]);
    expect(
      lax(prog(DECLS, "t := 100;")).errors.map((e) => e.message),
    ).not.toContain(m("TIME"));
  });
  it("rejects an integer passed to a TIME input", () => {
    const src = prog(DECLS, "tm(IN := b, PT := 100);");
    expect(msgs(src)).toEqual([
      "6: An integer cannot be used as TIME; write a TIME literal such as T#100ms",
    ]);
    expect(lax(src).errors).toEqual([]);
  });
});

describe("strict mode: method and FB call arguments", () => {
  const fb = `FUNCTION_BLOCK Cnt
  VAR_INPUT inc : INT; END_VAR
  METHOD Bump : INT
    VAR_INPUT k : INT; END_VAR
    Bump := k;
  END_METHOD
END_FUNCTION_BLOCK
`;
  it("rejects a narrowing method argument and FB input", () => {
    const src =
      fb +
      `PROGRAM main
  VAR c : Cnt; d : DINT; n : INT; END_VAR
  n := c.Bump(k := d);
  c(inc := d);
END_PROGRAM
`;
    expect(msgs(src)).toEqual([
      `10: ${conv("DINT", "INT")}`,
      `11: ${conv("DINT", "INT")}`,
    ]);
    expect(lax(src).errors).toEqual([]);
  });
});

describe("strict mode: accepts common code", () => {
  it("test_strict_accepts_common_code", () => {
    const src = `TYPE E_State : (Idle, Run); END_TYPE
FUNCTION_BLOCK Cnt
  VAR_INPUT inc : INT; END_VAR
  VAR n : INT; END_VAR
  METHOD Bump : INT
    VAR_INPUT k : INT; END_VAR
    n := n + k;
    Bump := n;
  END_METHOD
  n := n + inc;
END_FUNCTION_BLOCK
PROGRAM main
  VAR
    i : INT; d : DINT; r : REAL; x : REAL; b : BOOL; tm : TON; c : Cnt;
    st : E_State; u : USINT; z : INT;
  END_VAR
  r := 0;
  d := i;
  x := INT_TO_REAL(i);
  IF r > 100 THEN i := 1; END_IF;
  tm(IN := b, PT := T#1s);
  st := E_State.Idle;
  c.Bump(k := 2);
  c(inc := 1);
  u := u + 1;
  i := i + 1;
  r := r * 2 + 1.5;
  z := INT#5;
  x := REAL#1;
END_PROGRAM
`;
    const s = strict(src);
    expect(s.errors).toEqual([]);
    expect(lax(src).errors).toEqual([]);
  });
});
