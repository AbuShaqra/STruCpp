/**
 * UNION lowering (feature union): the generated storage and helpers, member
 * reads through `union_read`, writes through the member proxy, VAR_IN_OUT
 * copy-in/copy-out of a member, the debug table, and the uses compile refuses
 * as not supported yet while analysis accepts them.
 */
import { describe, it, expect } from "vitest";
import { analyze, compile } from "../../src/index.js";
import type { VariableExpression } from "../../src/frontend/ast.js";
import { walkAST } from "../../src/ast-utils.js";

type Options = Parameters<typeof compile>[1];
const ON: Options = { features: ["+union"] };

const TYPES = `TYPE
  ST_P : STRUCT x : INT; y : REAL; END_STRUCT;
  ST_X : STRUCT k : INT; END_STRUCT;
  U_A : UNION f : REAL; d : DWORD; arr : ARRAY[0..3] OF BYTE; st : ST_P; END_UNION;
  ST_W : STRUCT u : U_A; k : INT; END_STRUCT;
END_TYPE
`;

/** Compile `body` in a PROGRAM over TYPES; fails the test on errors. */
function compileBody(body: string, vars = "u, v : U_A; w : ST_W;"): {
  header: string;
  cpp: string;
} {
  const result = compile(
    `${TYPES}FUNCTION F_Io : INT
VAR_IN_OUT r : REAL; END_VAR
r := r + 1.0; F_Io := 1;
END_FUNCTION
PROGRAM Main
VAR ${vars} x : DWORD; n : INT; r : REAL; pr : POINTER TO REAL; END_VAR
${body}
END_PROGRAM
`,
    ON,
  );
  expect(result.errors).toEqual([]);
  return { header: result.headerCode, cpp: result.cppCode };
}

/** Error messages of compile and analyze, as `line:col message`. */
function diagnostics(source: string): { compile: string[]; check: string[] } {
  const fmt = (e: { line: number; column: number; message: string }): string =>
    `${e.line}:${e.column} ${e.message}`;
  return {
    compile: compile(source, ON).errors.map(fmt),
    check: analyze(source, ON).errors.map(fmt),
  };
}

describe("UNION storage", () => {
  const { header } = compileBody("u.f := 1.0;");

  it("is one byte buffer sized by a C++ union of the plain members", () => {
    expect(header).toContain(`union U_A_uplain {
    union_plain_t<IEC_REAL> F;
    union_plain_t<IEC_DWORD> D;
    union_plain_t<Array1D<IEC_BYTE, 0, 3>> ARR;
    union_plain_t<ST_P> ST;
};`);
    expect(header).toContain(`struct U_A {
    union {
        alignas(U_A_uplain) unsigned char union_bytes_[sizeof(U_A_uplain)];
        union_view_t<IEC_REAL, 0, sizeof(U_A_uplain)> F;`);
    expect(header).toContain(
      "U_A() noexcept { std::memset(union_bytes_, 0, sizeof(union_bytes_)); }",
    );
    expect(header).toContain("using IEC_U_A = U_A;");
  });

  it("gives helpers to a STRUCT stored in a UNION, not to one that holds a UNION", () => {
    expect(header).toContain("struct ST_P_uplain {");
    expect(header).toContain("template<> struct union_traits<ST_P, void> {");
    expect(header).toContain(
      "template<std::size_t Off, std::size_t Size> struct ST_P_uview {",
    );
    expect(header).toContain("struct ST_P_uref {");
    expect(header).not.toContain("ST_W_u");
    expect(header).not.toContain("ST_X_u");
    expect(header).toContain(`struct ST_W {
    U_A U{};`);
  });

  it("adds nothing to a unit without a UNION", () => {
    const result = compile(
      `TYPE ST_P : STRUCT x : INT; END_STRUCT; END_TYPE
PROGRAM Main VAR p : ST_P; a : INT; END_VAR a := p.x; END_PROGRAM
`,
      ON,
    );
    expect(result.errors).toEqual([]);
    expect(result.headerCode).not.toMatch(/union_/);
    expect(result.cppCode).not.toMatch(/union_/);
  });
});

describe("UNION member access", () => {
  it("reads through union_read and writes through the member", () => {
    const { cpp } = compileBody(
      "u.f := 1.0; x := u.d; u.arr[1] := 16#AB; x := u.arr[2] + 1; w.u.d := x; u.st.x := 3; n := u.st.x;",
    );
    expect(cpp).toContain("    U.F = 1.0;");
    expect(cpp).toContain("    X = union_read(U.D);");
    expect(cpp).toContain("    U.ARR.at(1) = 0xAB;");
    expect(cpp).toContain("    X = union_read(U.ARR.at(2)) + 1;");
    expect(cpp).toContain("    W.U.D = X;");
    expect(cpp).toContain("    U.ST.X = 3;");
    expect(cpp).toContain("    N = union_read(U.ST.X);");
  });

  it("copies a whole UNION as a value, not through union_read", () => {
    const { cpp } = compileBody("v := u; w.u := v;");
    expect(cpp).toContain("    V = U;");
    expect(cpp).toContain("    W.U = V;");
  });

  it("writes a bit and takes an address on the member itself", () => {
    const { cpp } = compileBody("u.d.3 := TRUE; pr := ADR(u.f);");
    expect(cpp).toContain(
      "    U.D = (U.D & ~(1ULL << 3)) | ((true ? 1ULL : 0ULL) << 3);",
    );
    expect(cpp).toContain("    PR = &(U.F);");
  });

  it("binds a member to VAR_IN_OUT by copy-in and copy-out", () => {
    const { cpp } = compileBody("n := F_Io(r := u.f);");
    expect(cpp).toContain(`    {
        auto __gio_0 = union_value(U.F);
        N = F_IO(__gio_0);
        U.F = __gio_0;
    }`);
  });

  it("marks only accesses whose storage lies in a UNION", () => {
    const source = `${TYPES}TYPE U_P : UNION p : POINTER TO INT; d : LWORD; END_UNION; END_TYPE
PROGRAM Main
VAR u : U_A; up : U_P; w : ST_W; t : ST_P; n : INT; END_VAR
n := t.x; n := u.st.x; n := w.u.st.x; n := up.p^; n := w.k;
END_PROGRAM
`;
    const result = analyze(source, ON);
    expect(result.errors).toEqual([]);
    const marked: string[] = [];
    walkAST(result.ast!, (node) => {
      if (node.kind !== "VariableExpression") return;
      const v = node as VariableExpression;
      if (v.fieldAccess.length === 0) return;
      marked.push(
        `${v.name}.${v.fieldAccess.join(".")}${v.unionMember ? " U" : ""}`,
      );
    });
    expect(marked).toEqual([
      "T.X",
      "U.ST.X U",
      "W.U.ST.X U",
      "UP.P",
      "W.K",
    ]);
  });
});

describe("the debug table leaves a UNION out", () => {
  it("lists the other leaves and says why the UNION is missing", () => {
    const result = compile(
      `${TYPES}PROGRAM Main
VAR u : U_A; w : ST_W; plain : INT; END_VAR
u.d := 1; plain := w.k;
END_PROGRAM
CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 1);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION
`,
      ON,
    );
    expect(result.errors).toEqual([]);
    const paths = result.debugMap!.leaves.map((l) => l.path);
    expect(paths).toEqual(["INSTANCE0.W.K", "INSTANCE0.PLAIN"]);
    const warnings = result.warnings.map((w) => w.message);
    expect(warnings).toContain(
      "INSTANCE0.U is not debuggable: UNION U_A: its members share one storage, which the debugger cannot address (not supported yet); they cannot be forced.",
    );
    expect(warnings).toContain(
      "INSTANCE0.W.U is not debuggable: UNION U_A: its members share one storage, which the debugger cannot address (not supported yet); they cannot be forced.",
    );
  });
});

describe("uses compile cannot lower yet", () => {
  it("refuses REF, REF_LINK and REF= of a member; --check accepts them", () => {
    const d = diagnostics(`${TYPES}PROGRAM Main
VAR u : U_A; rf : REF_TO REAL; rr : REFERENCE TO REAL; END_VAR
rf := REF(u.f);
rf := REF_LINK(u.f);
rr REF= u.f;
END_PROGRAM
`);
    expect(d.check).toEqual([]);
    expect(d.compile).toEqual([
      "9:11 REF of a UNION member is not supported yet",
      "10:16 REF of a UNION member is not supported yet",
      "11:9 REF= on a UNION member is not supported yet",
    ]);
  });

  it("refuses a REFERENCE TO stored in a UNION", () => {
    const d = diagnostics(`TYPE
  ST_R : STRUCT r : REFERENCE TO INT; END_STRUCT;
  U_R : UNION a : REFERENCE TO INT; s : ST_R; p : POINTER TO INT; END_UNION;
END_TYPE
PROGRAM Main VAR u : U_R; END_VAR END_PROGRAM
`);
    expect(d.check).toEqual([]);
    expect(d.compile).toEqual([
      "3:19 Member 'A' stored in UNION 'U_R' is a REFERENCE TO: a REFERENCE TO in a UNION is not supported yet",
      "2:21 Member 'R' stored in UNION 'U_R' is a REFERENCE TO: a REFERENCE TO in a UNION is not supported yet",
    ]);
  });

  it("refuses RETAIN and PERSISTENT of a variable that is or holds a UNION", () => {
    const d = diagnostics(`${TYPES}FUNCTION_BLOCK FB_H
VAR inner : ST_W; END_VAR
END_FUNCTION_BLOCK
PROGRAM Main
VAR RETAIN u : U_A; ok : INT; END_VAR
VAR PERSISTENT w : ST_W; END_VAR
VAR RETAIN fb : FB_H; a : ARRAY[0..1] OF U_A; t : ST_P; END_VAR
VAR plain : U_A; END_VAR
END_PROGRAM
`);
    expect(d.check).toEqual([]);
    expect(d.compile).toEqual([
      "11:12 RETAIN of a UNION is not supported yet: 'U' is or holds UNION 'U_A'",
      "12:16 RETAIN of a UNION is not supported yet: 'W' is or holds UNION 'U_A'",
      "13:12 RETAIN of a UNION is not supported yet: 'FB' is or holds UNION 'U_A'",
      "13:23 RETAIN of a UNION is not supported yet: 'A' is or holds UNION 'U_A'",
    ]);
  });
});
