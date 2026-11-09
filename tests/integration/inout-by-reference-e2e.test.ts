/**
 * Function-block VAR_IN_OUT bound by reference (IEC 61131-3 Ed. 3 6.6.1.4,
 * 6.6.3.4.2): each call binds the in-out to the caller's variable, the body
 * reads and writes that variable itself, and nothing is copied back. Ends in
 * g++ so the printed results are the proof.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile, compileStlib } from "../../src/index.js";
import type { StlibArchive } from "../../src/library/library-manifest.js";
import {
  hasGpp,
  createPCH,
  compileAndRunStandalone,
  CXX_STD,
  RUNTIME_INCLUDE_PATH,
  cxxEnv,
} from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

type Options = Parameters<typeof compile>[1];

function compileOk(source: string, options: Options = {}) {
  const result = compile(source, {
    headerFileName: "generated.hpp",
    ...options,
  });
  expect(result.errors.map((e) => `${e.line}: ${e.message}`)).toEqual([]);
  return result;
}

describeIfGpp("FB VAR_IN_OUT by reference (g++)", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-inout-ref-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function run(
    source: string,
    mainBody: string,
    name: string,
    options: Options = {},
  ): string {
    const result = compileOk(source, options);
    return compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: name,
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n${mainBody}\n return 0;\n}\n`,
    });
  }

  it("the callee sees its own writes through VAR_EXTERNAL (aliasing)", () => {
    const out = run(
      `VAR_GLOBAL g : INT := 1; END_VAR
FUNCTION_BLOCK FB_IO
VAR_EXTERNAL g : INT; END_VAR
VAR_IN_OUT x : INT; END_VAR
VAR_OUTPUT seen : INT; END_VAR
  x := x + 10;
  seen := g;
  g := g + 100;
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR_EXTERNAL g : INT; END_VAR
VAR f : FB_IO; s : INT; END_VAR
  f(x := g);
  s := f.seen;
END_PROGRAM`,
      ` Program_MAIN p; p.run();\n std::cout << "g=" << G.get() << " seen=" << p.S.get() << std::endl;`,
      "repro",
    );
    // A copy-in / copy-out call gave g=11 seen=1.
    expect(out).toBe("g=111 seen=11");
  });

  it("STRUCT, ARRAY, ARRAY[*], STRING, WSTRING, enum, alias, pointer and FB-instance in-outs", () => {
    const out = run(
      `TYPE
  ST_P : STRUCT a : INT; b : REAL; END_STRUCT;
  E_C : (RED, GREEN, BLUE);
  T_AL : INT;
  T_ARR : ARRAY[1..3] OF INT;
END_TYPE
FUNCTION_BLOCK FB_Leaf
VAR_OUTPUT q : INT; END_VAR
  q := q + 1;
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_T
VAR_IN_OUT
  st : ST_P; arr : ARRAY[1..3] OF INT; vla : ARRAY[*] OF INT; s : STRING; ws : WSTRING;
  ec : E_C; al : T_AL; ta : T_ARR; p : POINTER TO INT; fb : FB_Leaf;
END_VAR
VAR_OUTPUT seenQ : INT; END_VAR
  st.a := st.a + 1;
  arr[2] := arr[2] + 1;
  vla[LOWER_BOUND(vla, 1)] := vla[LOWER_BOUND(vla, 1)] + 1;
  s := CONCAT(s, 'x');
  ws := "y";
  ec := BLUE;
  al := al + 1;
  ta[3] := ta[3] + 1;
  p^ := p^ + 1;
  fb();
  seenQ := fb.q;
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR
  f : FB_T; st : ST_P; arr : ARRAY[1..3] OF INT; v : ARRAY[0..4] OF INT; s : STRING; ws : WSTRING;
  ec : E_C; al : T_AL := 0; ta : T_ARR; x : INT; px : POINTER TO INT; leaf : FB_Leaf;
END_VAR
  px := ADR(x);
  f(st := st, arr := arr, vla := v, s := s, ws := ws, ec := ec, al := al, ta := ta, p := px, fb := leaf);
  f(st := st, arr := arr, vla := v, s := s, ws := ws, ec := ec, al := al, ta := ta, p := px, fb := leaf);
END_PROGRAM`,
      ` Program_MAIN m; m.run();\n std::cout << m.ST.A.get() << ' ' << m.ARR[2].get() << ' ' << m.V[0].get() << ' ' << m.S.c_str() << ' ' << m.WS.length() << ' ' << (m.EC.get() == E_C::BLUE) << ' ' << m.AL << ' ' << m.TA[3].get() << ' ' << m.X.get() << ' ' << m.LEAF.Q.get() << ' ' << m.F.SEENQ.get() << std::endl;`,
      "types",
    );
    // The leaf instance itself runs (q 2 after two calls), not a copy of it.
    expect(out).toBe("2 2 2 xx 1 1 2 2 2 2 2");
  });

  it("an inherited in-out and positional in-out arguments", () => {
    const out = run(
      `FUNCTION_BLOCK FB_B
VAR_INPUT k : INT; END_VAR
VAR_IN_OUT x : INT; END_VAR
  x := x + k;
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_D EXTENDS FB_B
VAR_IN_OUT y : INT; END_VAR
  x := x + k;
  y := y + x;
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR d : FB_D; a : INT := 1; b : INT := 100; END_VAR
  d(k := 2, x := a, y := b);
  d(3, a, b);
END_PROGRAM`,
      ` Program_MAIN m; m.run();\n std::cout << m.A.get() << ' ' << m.B.get() << std::endl;`,
      "inherit_positional",
    );
    // a: 1+2=3, then 3+3=6; b: 100+3=103, then 103+6=109.
    expect(out).toBe("6 109");
  });

  it("an in-out passed on to a nested block, from a method and from a function", () => {
    const out = run(
      `TYPE ST_P : STRUCT a : INT; END_STRUCT; END_TYPE
FUNCTION_BLOCK FB_In
VAR_IN_OUT x : INT; s : ST_P; END_VAR
  x := x + 1;
  s.a := s.a + 1;
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Out
VAR_IN_OUT o : ST_P; END_VAR
VAR inner : FB_In; n : INT; END_VAR
METHOD Run : INT
VAR t : INT := 5; END_VAR
  inner(x := t, s := o);
  Run := t;
END_METHOD
  inner(x := n, s := o);
END_FUNCTION_BLOCK
FUNCTION FN : INT
VAR_IN_OUT w : ST_P; END_VAR
VAR d : FB_In; z : INT; END_VAR
  d(x := z, s := w);
  FN := z;
END_FUNCTION
PROGRAM MAIN
VAR ou : FB_Out; st : ST_P; r1 : INT; r2 : INT; END_VAR
  ou(o := st);
  r1 := ou.Run();
  r2 := FN(w := st);
END_PROGRAM`,
      ` Program_MAIN m; m.run();\n std::cout << m.ST.A.get() << ' ' << m.OU.N.get() << ' ' << m.R1.get() << ' ' << m.R2.get() << std::endl;`,
      "nested",
    );
    expect(out).toBe("3 1 6 1");
  });

  it("an in-out reached before any call binds it, or after a method's call ended, raises the null-reference fault", () => {
    const source = `FUNCTION_BLOCK FB_I
VAR_IN_OUT x : INT; END_VAR
METHOD Value : INT
  Value := x;
END_METHOD
  x := x + 1;
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_H
VAR inner : FB_I; END_VAR
METHOD Bump : INT
VAR t : INT; END_VAR
  inner(x := t);
  Bump := t;
END_METHOD
METHOD Peek : INT
  Peek := inner.x;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR f : FB_I; h : FB_H; r : INT; END_VAR
END_PROGRAM`;
    const out = run(
      source,
      ` Program_MAIN m;
 try { m.F.VALUE(); std::cout << "no fault"; } catch (const NullReferenceException& e) { std::cout << "fault1"; }
 std::cout << ' ' << m.H.BUMP() << ' ';
 try { m.H.PEEK(); std::cout << "no fault"; } catch (const NullReferenceException& e) { std::cout << "fault2"; }
 std::cout << std::endl;`,
      "unbound",
    );
    expect(out).toBe("fault1 1 fault2");
  });

  it("the warned forms build: another type by copy, an omitted in-out keeps its binding, an outside write", () => {
    const result = compile(
      `TYPE T_AL : INT; END_TYPE
FUNCTION_BLOCK FB_I
VAR_IN_OUT x : INT; END_VAR
  x := x + 1;
END_FUNCTION_BLOCK
FUNCTION FN : INT
VAR_IN_OUT x : INT; END_VAR
  x := x + 10;
  FN := 0;
END_FUNCTION
PROGRAM MAIN
VAR f : FB_I; a : INT; b : SINT; al : T_AL := 0; r : INT; out : INT; END_VAR
  f(x := a);
  f();
  f(x := b);
  f(x := al);
  f(x := a);
  f.x := f.x + 100;
  out := f.x;
  r := FN(x := b);
  r := FN();
END_PROGRAM`,
      { headerFileName: "generated.hpp" },
    );
    expect(result.errors).toEqual([]);
    expect(
      result.warnings.filter((w) => w.message.includes("VAR_IN_OUT")),
    ).toHaveLength(6);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "warned",
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN m; m.run();\n std::cout << m.A.get() << ' ' << (int)m.B.get() << ' ' << m.AL << ' ' << m.OUT.get() << std::endl;\n return 0;\n}\n`,
    });
    // a: +1, +1 (omitted, still bound to a), +1, then +100 written through
    // the binding; b: +1 by copy, +10 through FN by copy; al: +1 by copy.
    expect(out).toBe("103 11 1 103");
  });

  it("a UNION member is passed by copy", () => {
    const out = run(
      `TYPE U_W : UNION w : WORD; b : ARRAY[0..1] OF BYTE; END_UNION; END_TYPE
FUNCTION_BLOCK FB_W
VAR_IN_OUT x : WORD; END_VAR
  x := x + 1;
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR f : FB_W; u : U_W; END_VAR
  f(x := u.w);
  f(x := u.w);
END_PROGRAM`,
      ` Program_MAIN m; m.run();\n std::cout << (int)union_read(m.U.W).get() << std::endl;`,
      "union",
      { features: ["+union"] },
    );
    expect(out).toBe("2");
  });

  describe("CONFIGURATION globals", () => {
    const SOURCE = `TYPE ST_Ax : STRUCT pos : INT; END_STRUCT; END_TYPE
FUNCTION_BLOCK FB_Drive
VAR_EXTERNAL gAx : ST_Ax; END_VAR
VAR_IN_OUT ax : ST_Ax; n : INT; END_VAR
VAR_OUTPUT seen : INT; END_VAR
  ax.pos := ax.pos + 1;
  n := n + 1;
  seen := gAx.pos;
END_FUNCTION_BLOCK
FUNCTION F_Inc : INT
VAR_IN_OUT v : INT; END_VAR
  v := v + 10;
  F_Inc := v;
END_FUNCTION
PROGRAM MAIN
VAR_EXTERNAL gAx : ST_Ax; gN : INT; END_VAR
VAR d : FB_Drive; s : INT; r : INT; END_VAR
  d(ax := gAx, n := gN);
  s := d.seen;
  r := F_Inc(gN);
END_PROGRAM
CONFIGURATION C
  VAR_GLOBAL gAx : ST_Ax; gN : INT; END_VAR
  RESOURCE R ON PLC
    TASK T(INTERVAL := T#100ms, PRIORITY := 1);
    PROGRAM Inst WITH T : MAIN;
  END_RESOURCE
END_CONFIGURATION
`;
    const MAIN = ` Configuration_C c; c.INST.run();\n std::cout << GAX.value.POS.get() << ' ' << GN.value.get() << ' ' << c.INST.S.get() << ' ' << c.INST.R.get() << std::endl;`;

    it("bind to the global's storage, with a warning for the threaded build", () => {
      const result = compileOk(SOURCE);
      expect(result.cppCode).toContain("D.AX.bind(GAX->value);");
      expect(result.cppCode).toContain("D.N.bind(GN->value);");
      expect(result.cppCode).toContain("F_INC(GN->value)");
      expect(
        result.warnings
          .map((w) => w.message)
          .filter((m) => m.includes("STRUCPP_THREADED")),
      ).toHaveLength(3);
      expect(run(SOURCE, MAIN, "config")).toBe("1 11 1 11");
    });

    it("build and run with -DSTRUCPP_THREADED", () => {
      const result = compileOk(SOURCE);
      const dir = path.join(tempDir, "threaded");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "generated.hpp"), result.headerCode);
      const cpp = path.join(dir, "threaded.cpp");
      fs.writeFileSync(
        cpp,
        `${result.cppCode}\n\n#include <iostream>\nint main() {\n using namespace strucpp;\n${MAIN}\n return 0;\n}\n`,
      );
      const bin = path.join(dir, "threaded");
      execSync(
        `g++ -std=${CXX_STD} -DSTRUCPP_THREADED -pthread -I"${RUNTIME_INCLUDE_PATH}" -I"${dir}" "${cpp}" -o "${bin}" 2>&1`,
        { encoding: "utf-8", env: cxxEnv },
      );
      expect(
        execSync(`"${bin}"`, { encoding: "utf-8", timeout: 10000 }).trim(),
      ).toBe("1 11 1 11");
    });
  });

  describe("library archives", () => {
    const LIB = `FUNCTION_BLOCK FB_Acc
VAR_INPUT k : INT; END_VAR
VAR_IN_OUT acc : INT; END_VAR
  acc := acc + k;
END_FUNCTION_BLOCK
`;
    const PROGRAM = `PROGRAM MAIN
VAR f : FB_Acc; a : INT; END_VAR
  f(k := 5, acc := a);
  f(k := 7, acc := a);
END_PROGRAM`;
    const MAIN = ` Program_MAIN m; m.run();\n std::cout << m.A.get() << std::endl;`;

    function library(): StlibArchive {
      const lib = compileStlib([{ source: LIB, fileName: "acc.st" }], {
        name: "acc-lib",
        version: "1.0.0",
        namespace: "strucpp",
      });
      expect(lib.success).toBe(true);
      return lib.archive!;
    }

    it("a current archive marks its FB and is bound by reference", () => {
      const archive = library();
      const fb = archive.manifest.functionBlocks.find(
        (b) => b.name === "FB_ACC",
      );
      expect(fb?.inoutByReference).toBe(true);
      expect(run(PROGRAM, MAIN, "lib_ref", { libraries: [archive] })).toBe(
        "12",
      );
    });

    it("an archive without the marker gets the copy call site and a rebuild warning", () => {
      // An archive built before by-reference in-outs: by-value member, no marker.
      const archive = library();
      const fb = archive.manifest.functionBlocks.find(
        (b) => b.name === "FB_ACC",
      )!;
      delete fb.inoutByReference;
      for (const chunk of Object.values(archive.chunks)) {
        chunk.header = chunk.header.replace(
          "IEC_INOUT<IEC_INT> ACC;",
          "IEC_INT ACC;",
        );
        chunk.cpp = chunk.cpp.replace(/\(\*ACC\)/g, "ACC");
      }
      const result = compileOk(PROGRAM, { libraries: [archive] });
      expect(result.cppCode).toContain("F.ACC = A;");
      expect(result.cppCode).toContain("A = F.ACC;");
      expect(
        result.warnings.filter((w) =>
          w.message.includes("Rebuild the library"),
        ),
      ).toHaveLength(1);
      expect(run(PROGRAM, MAIN, "lib_legacy", { libraries: [archive] })).toBe(
        "12",
      );
    });
  });
});
