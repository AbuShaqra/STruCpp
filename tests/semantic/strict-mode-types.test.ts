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

/** Non-strict errors as "line: message". */
function laxMsgs(source: string): string[] {
  return lax(source).errors.map((e) => `${e.line}: ${e.message}`);
}
function laxWarnings(source: string): string[] {
  return lax(source).warnings.map((e) => `${e.line}: ${e.message}`);
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
    expect(laxMsgs(src)).toEqual([]);
    expect(laxWarnings(src)).toEqual([
      "6: Implicit narrowing conversion from DINT to INT",
      "7: Implicit narrowing conversion from LINT to DINT",
    ]);
  });
  it("rejects signed -> unsigned of any width", () => {
    expect(msgs(prog(DECLS, "ui := i;"))).toEqual([
      `6: ${conv("INT", "UINT")}`,
    ]);
    expect(laxMsgs(prog(DECLS, "ui := i;"))).toEqual([]);
  });
  it("rejects a narrowing function argument", () => {
    const src = `FUNCTION f : INT
  VAR_INPUT p : INT; END_VAR
  f := p;
END_FUNCTION
PROGRAM main
  VAR d : DINT; n : INT; END_VAR
  n := f(p := d);
END_PROGRAM
`;
    expect(msgs(src)).toEqual([`7: ${conv("DINT", "INT")}`]);
    expect(laxMsgs(src)).toEqual([]);
    expect(laxWarnings(src)).toEqual([]);
  });
  it("accepts an integer literal initial value", () => {
    const src = prog("k : INT := 5;", "k := 1;");
    expect(strict(src).errors).toEqual([]);
    expect(laxMsgs(src)).toEqual([]);
  });
  it("rejects a narrowing RETURN value", () => {
    const src = `FUNCTION f : INT
  VAR_INPUT p : DINT; END_VAR
  f := p;
END_FUNCTION
`;
    expect(msgs(src)).toEqual([`3: ${conv("DINT", "INT")}`]);
    expect(laxMsgs(src)).toEqual([]);
    expect(laxWarnings(src)).toEqual([]);
  });
  it("rejects a narrowing initial value", () => {
    const src = `PROGRAM main
  VAR n : INT := DINT#5; END_VAR
END_PROGRAM
`;
    expect(msgs(src)).toEqual([`2: ${conv("DINT", "INT")}`]);
    expect(laxMsgs(src)).toEqual([]);
    expect(laxWarnings(src)).toEqual([
      "2: Implicit narrowing conversion from DINT to INT",
    ]);
  });
});

/** Body statement `stmt` on line 6 of the DECLS program: [non-strict errors, non-strict warnings, strict errors]. */
function pin(
  src: string,
  laxErrors: string[],
  laxWarns: string[],
  strictErrors: string[],
  label = src,
): void {
  expect(laxMsgs(src), `non-strict errors: ${label}`).toEqual(laxErrors);
  expect(laxWarnings(src), `non-strict warnings: ${label}`).toEqual(laxWarns);
  expect(msgs(src), `strict errors: ${label}`).toEqual(strictErrors);
}
const nar = (v: string, t: string) =>
  `6: Implicit narrowing conversion from ${v} to ${t}`;
const TIME_MSG =
  "An integer cannot be used as TIME; write a TIME literal such as T#100ms";

describe("strict mode: row b, integer <-> real", () => {
  it("accepts the exact widenings, unsigned to a wider signed type in every mode", () => {
    const cases: Array<[string, string, string[]]> = [
      ["i", "r", []],
      ["ui", "d", []],
      ["d", "lr", []],
      ["r", "lr", []],
      ["us", "i", []],
      ["ud", "l", []],
    ];
    for (const [v, t, laxErrors] of cases) {
      pin(prog(DECLS, `${t} := ${v};`), laxErrors, [], [], `${v} -> ${t}`);
    }
  });
  it("rejects lossy integer -> REAL/LREAL", () => {
    pin(prog(DECLS, "r := d;"), [], [], [`6: ${conv("DINT", "REAL")}`]);
    pin(prog(DECLS, "lr := l;"), [], [], [`6: ${conv("LINT", "LREAL")}`]);
    pin(prog(DECLS, "r := ud;"), [], [], [`6: ${conv("UDINT", "REAL")}`]);
    pin(
      prog(DECLS, "r := ul;"),
      [],
      [nar("ULINT", "REAL")],
      [`6: ${conv("ULINT", "REAL")}`],
    );
  });
  it("rejects REAL/LREAL -> any integer and LREAL -> REAL", () => {
    pin(
      prog(DECLS, "i := r;"),
      [],
      [nar("REAL", "INT")],
      [`6: ${conv("REAL", "INT")}`],
    );
    pin(
      prog(DECLS, "l := lr;"),
      [],
      [nar("LREAL", "LINT")],
      [`6: ${conv("LREAL", "LINT")}`],
    );
    pin(
      prog(DECLS, "r := lr;"),
      [],
      [nar("LREAL", "REAL")],
      [`6: ${conv("LREAL", "REAL")}`],
    );
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
    pin(src, [], [], [`7: ${conv("DINT", "REAL")}`]);
  });
  it("keeps accepting integer literals where a REAL is expected", () => {
    pin(
      prog(DECLS, "r := 0; lr := 5;\nIF r > 100 THEN i := 1; END_IF;"),
      [],
      [],
      [],
    );
  });
});

describe("strict mode: row c, BOOL <-> numbers", () => {
  it("rejects both directions", () => {
    pin(
      prog(DECLS, "b := i;"),
      [],
      [nar("INT", "BOOL")],
      [`6: ${conv("INT", "BOOL")}`],
    );
    pin(prog(DECLS, "i := b;"), [], [], [`6: ${conv("BOOL", "INT")}`]);
    pin(prog(DECLS, "r := b;"), [], [], [`6: ${conv("BOOL", "REAL")}`]);
    pin(
      prog(DECLS, "b := r;"),
      [],
      [nar("REAL", "BOOL")],
      [`6: ${conv("REAL", "BOOL")}`],
    );
    pin(prog(DECLS, "i := TRUE;"), [], [], [`6: ${conv("BOOL", "INT")}`]);
  });
  it("accepts the literals 0 and 1 for a BOOL, as matiec does", () => {
    pin(prog(DECLS, "b := 1;"), [], [], []);
    pin(prog(DECLS, "b := 0;"), [], [], []);
    pin(prog("b0 : BOOL := 1; b1 : BOOL := 0;", "b0 := TRUE;"), [], [], []);
  });
  it("rejects any other integer literal for a BOOL", () => {
    pin(prog(DECLS, "b := 2;"), [], [], [`6: ${conv("INT", "BOOL")}`]);
    pin(
      prog("b0 : BOOL := 2;", "b0 := TRUE;"),
      [],
      [],
      [`3: ${conv("INT", "BOOL")}`],
    );
  });
  it("rejects a BOOL argument to an INT parameter, and a 2 to a BOOL one", () => {
    const src = `FUNCTION f : INT
  VAR_INPUT p : INT; END_VAR
  f := p;
END_FUNCTION
FUNCTION g : INT
  VAR_INPUT q : BOOL; END_VAR
  g := 0;
END_FUNCTION
PROGRAM main
  VAR b : BOOL; n : INT; END_VAR
  n := f(b);
  n := g(q := 1);
  n := g(q := 2);
END_PROGRAM
`;
    pin(
      src,
      [],
      [],
      [`11: ${conv("BOOL", "INT")}`, `13: ${conv("INT", "BOOL")}`],
    );
  });
});

describe("strict mode: rows d and e, arithmetic", () => {
  it("rejects arithmetic with a BOOL operand", () => {
    for (const op of ["+", "-", "*", "/", "MOD"]) {
      pin(
        prog(DECLS, `i := i ${op} b;`),
        [],
        [],
        ["6: Arithmetic on BOOL is not allowed"],
        op,
      );
    }
  });
  it("rejects arithmetic with a bit-string operand", () => {
    pin(
      prog(DECLS, "w := w + 1;"),
      [],
      [],
      [
        "6: Arithmetic on WORD is not allowed; convert it to an integer type first",
      ],
    );
    pin(
      prog(DECLS, "i := i * bt;"),
      [],
      [],
      [
        "6: Arithmetic on BYTE is not allowed; convert it to an integer type first",
      ],
    );
  });
  it("does not touch comparison, AND/OR or integer arithmetic", () => {
    pin(
      prog(DECLS, "b := b AND (i > 3);\nw := w AND 16#FF;\ni := i + 1;"),
      [],
      [],
      [],
    );
  });
});

describe("strict mode: row f, integer as TIME", () => {
  it("rejects an integer literal assigned to TIME", () => {
    pin(
      prog(DECLS, "t := 100;"),
      ["6: Cannot assign INT to TIME"],
      [],
      [`6: ${TIME_MSG}`],
    );
  });
  it("rejects an integer variable assigned to TIME", () => {
    pin(
      prog(DECLS, "t := d;"),
      ["6: Cannot assign DINT to TIME"],
      [],
      [`6: ${TIME_MSG}`],
    );
  });
  it("rejects an integer initial value for a TIME", () => {
    pin(
      prog("t0 : TIME := 100;", "t0 := T#1s;"),
      ["3: Cannot assign INT to TIME"],
      [],
      [`3: ${TIME_MSG}`],
    );
  });
  it("rejects an integer passed to a TIME input", () => {
    pin(prog(DECLS, "tm(IN := b, PT := 100);"), [], [], [`6: ${TIME_MSG}`]);
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
    expect(laxMsgs(src)).toEqual([]);
    expect(laxWarnings(src)).toEqual([]);
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

describe("strict mode: untyped constant expressions adapt like literals", () => {
  const head = `FUNCTION H : SINT
  VAR_INPUT a : SINT; END_VAR
  H := a;
END_FUNCTION
FUNCTION F : SINT
  VAR_INPUT a : SINT; END_VAR
  F := -1;
END_FUNCTION
FUNCTION_BLOCK MYFB
  VAR_INPUT a : SINT; END_VAR
  a := a;
END_FUNCTION_BLOCK
`;
  /** The body goes on line 18. */
  const p = (body: string, decls = "") =>
    head +
    `PROGRAM main
  VAR
    s : SINT; u : USINT; ui : UINT; b : BOOL; i : INT; fb1 : MYFB;
    arr : ARRAY[0..3] OF SINT; ${decls}
  END_VAR
  ${body}
END_PROGRAM
`;
  it("accepts every constant form matiec accepts (non-strict too)", () => {
    const cases: Array<[string, string?]> = [
      ["s := -1;"],
      ["s := s;", "s2 : SINT := -1;"],
      ["arr[0] := -1;"],
      ["s := F(a := 1);"],
      ["s := H(-1);"],
      ["s := H(a := -1);"],
      ["fb1(a := -5);"],
      ["s := s * -1;"],
      ["s := s - (-1);"],
      ["s := 1 + 2;"],
      ["u := 1 + 1;"],
      ["ui := 10 * 10;"],
      ["s := -(1);"],
      ["s := MAX(-1, s);"],
      ["s := MAX(0, s);"],
      ["u := MAX(1 + 1, u);"],
      ["s := MAX(-1, 0);"],
      ["s := ABS(-1);"],
      ["b := NOT 1;"],
      ["b := NOT (0);"],
      ["b := (1);"],
    ];
    for (const [body, decls] of cases) {
      const src = p(body, decls);
      expect(laxMsgs(src), `non-strict: ${body}`).toEqual([]);
      expect(msgs(src), `strict: ${body}`).toEqual([]);
    }
  });
  it("still rejects an INT variable times a constant into a SINT", () => {
    const src = p("s := i * -1;");
    expect(laxMsgs(src)).toEqual([]);
    expect(msgs(src)).toEqual([`18: ${conv("INT", "SINT")}`]);
  });
  it("still rejects integer constants other than 0 and 1 into a BOOL", () => {
    for (const body of ["b := 2;", "b := NOT 2;", "b := 1 + 0;", "b := -1;"]) {
      const src = p(body);
      expect(laxMsgs(src), `non-strict: ${body}`).toEqual([]);
      expect(msgs(src), `strict: ${body}`).toEqual([
        `18: ${conv("INT", "BOOL")}`,
      ]);
    }
  });
  it("still rejects a mixed INT/REAL constant into a SINT", () => {
    const src = p("s := 1.5 + 1;");
    expect(msgs(src)).toEqual([`18: ${conv("REAL", "SINT")}`]);
  });
});
