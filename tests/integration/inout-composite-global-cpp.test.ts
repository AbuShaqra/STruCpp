/**
 * A composite configuration global (STRUCT, ARRAY, an element or a field of
 * one) passed to a VAR_IN_OUT or VAR_OUTPUT of a method or a FUNCTION.
 *
 * A VAR_IN_OUT refers to the global's canonical storage for the call
 * (`X->value`, IEC 61131-3 6.6.1.4): the callee sees and writes the global
 * itself, so a callee that also reaches it through VAR_EXTERNAL sees its own
 * writes. No lock is held during the call (GlobalVar's mutex is not
 * recursive), and the compiler warns that under STRUCPP_THREADED the accesses
 * through the in-out are not serialized. A VAR_OUTPUT (`=>`) is still copied
 * out under the lock. Ends in g++ so the results are the proof.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { compile } from "../../src/index.js";
import {
  hasGpp,
  createPCH,
  compileAndRunStandalone,
  CXX_STD,
  RUNTIME_INCLUDE_PATH,
  cxxEnv,
} from "./test-helpers.js";

const describeIfGpp = hasGpp ? describe : describe.skip;

/** The AXIS_REF stand-in and the blocks every case shares. */
const COMMON = `TYPE ST_Ax : STRUCT pos : INT; cnt : INT; END_STRUCT END_TYPE

FUNCTION_BLOCK FB_M
VAR_EXTERNAL gAx : ST_Ax; END_VAR
METHOD PUBLIC Drive : INT
VAR_IN_OUT Ax : ST_Ax; END_VAR
Ax.pos := Ax.pos + 1;
Drive := Ax.pos;
END_METHOD
METHOD PUBLIC DriveAndPeek : INT
VAR_IN_OUT Ax : ST_Ax; END_VAR
Ax.pos := Ax.pos + 1;
DriveAndPeek := gAx.pos;
END_METHOD
METHOD PUBLIC IncInt
VAR_IN_OUT v : INT; END_VAR
v := v + 1;
END_METHOD
METHOD PUBLIC Swap
VAR_IN_OUT a : ST_Ax; b : ST_Ax; END_VAR
VAR t : INT; END_VAR
t := a.pos;
a.pos := b.pos;
b.pos := t;
END_METHOD
METHOD PUBLIC Fill
VAR_INPUT p : INT; END_VAR
VAR_OUTPUT o : ST_Ax; END_VAR
o.pos := p;
o.cnt := p;
END_METHOD
METHOD PUBLIC Twice : INT
VAR_IN_OUT Ax : ST_Ax; END_VAR
Drive(Ax := Ax);
Twice := Drive(Ax := gAx);
END_METHOD
END_FUNCTION_BLOCK

FUNCTION F_Bump : INT
VAR_IN_OUT Ax : ST_Ax; END_VAR
Ax.pos := Ax.pos + 10;
F_Bump := Ax.pos;
END_FUNCTION

FUNCTION F_Inc : INT
VAR_IN_OUT v : INT; END_VAR
v := v + 100;
F_Inc := v;
END_FUNCTION

FUNCTION F_All : INT
VAR_IN_OUT arr : ARRAY[0..1] OF ST_Ax; END_VAR
arr[0].pos := arr[0].pos + 1000;
arr[1].pos := arr[1].pos + 1000;
F_All := 0;
END_FUNCTION
`;

function withConfig(programs: string): string {
  return `${COMMON}
${programs}
CONFIGURATION C
  VAR_GLOBAL gAx : ST_Ax; gAx2 : ST_Ax; gArr : ARRAY[0..1] OF ST_Ax; END_VAR
  RESOURCE R ON PLC
    TASK T(INTERVAL := T#100ms, PRIORITY := 1);
    PROGRAM Inst WITH T : MAIN;
  END_RESOURCE
END_CONFIGURATION
`;
}

function compileOk(source: string) {
  const result = compile(source, {
    headerFileName: "generated.hpp",
    features: ["+program_methods"],
  });
  expect(result.errors.map((e) => `${e.line}: ${e.message}`)).toEqual([]);
  return result;
}

/** Every `with_lock` lambda body in `code`, found by brace matching. */
function withLockBodies(code: string): string[] {
  const opener = "with_lock([&](auto* __glk){";
  const bodies: string[] = [];
  let at = code.indexOf(opener);
  while (at >= 0) {
    let i = at + opener.length;
    let depth = 1;
    const start = i;
    while (i < code.length && depth > 0) {
      if (code[i] === "{") depth++;
      else if (code[i] === "}") depth--;
      i++;
    }
    bodies.push(code.slice(start, i - 1));
    at = code.indexOf(opener, at + opener.length);
  }
  return bodies;
}

describeIfGpp(
  "composite globals to VAR_IN_OUT / VAR_OUTPUT of methods and functions",
  () => {
    let tempDir: string;
    let pchPath: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-inout-global-"));
      pchPath = createPCH(tempDir);
    });
    afterAll(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function run(programs: string, mainBody: string, name: string): string {
      const result = compileOk(withConfig(programs));
      return compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: name,
        mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Configuration_C c;\n${mainBody}\n return 0;\n}\n`,
      });
    }

    it("a method's VAR_IN_OUT mutates the global (called from a program body)", () => {
      const out = run(
        `PROGRAM MAIN
VAR_EXTERNAL gAx : ST_Ax; END_VAR
VAR m : FB_M; END_VAR
m.Drive(Ax := gAx);
m.Drive(gAx);
END_PROGRAM`,
        " c.INST.run();\n std::cout << GAX.value.POS.get() << std::endl;",
        "io_prog_body",
      );
      expect(out).toBe("2");
    });

    it("a method's VAR_IN_OUT mutates the global (called from an FB body)", () => {
      const out = run(
        `FUNCTION_BLOCK FB_User
VAR_EXTERNAL gAx : ST_Ax; END_VAR
VAR m : FB_M; END_VAR
m.Drive(Ax := gAx);
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR u : FB_User; END_VAR
u();
END_PROGRAM`,
        " c.INST.run(); c.INST.run();\n std::cout << GAX.value.POS.get() << std::endl;",
        "io_fb_body",
      );
      expect(out).toBe("2");
    });

    it("a method's VAR_IN_OUT mutates the global (called from method bodies)", () => {
      // FB_M.Twice calls its sibling with its own VAR_IN_OUT and then with the
      // global through the owner's VAR_EXTERNAL (bare call, FB method body);
      // MAIN.Step is a program method calling an instance's method.
      const out = run(
        `PROGRAM MAIN
VAR_EXTERNAL gAx : ST_Ax; gAx2 : ST_Ax; END_VAR
VAR m : FB_M; r : INT; END_VAR
METHOD Step : INT
  Step := m.Drive(Ax := gAx2);
END_METHOD
r := m.Twice(Ax := gAx);
Step();
END_PROGRAM`,
        " c.INST.run();\n std::cout << GAX.value.POS.get() << ' ' << c.INST.R.get() << ' ' << GAX2.value.POS.get() << std::endl;",
        "io_method_body",
      );
      // Twice: Drive(its Ax, which is gAx) -> 1; Drive(gAx) -> 2, returns 2.
      expect(out).toBe("2 2 1");
    });

    it("a FUNCTION's VAR_IN_OUT mutates the global", () => {
      const out = run(
        `PROGRAM MAIN
VAR_EXTERNAL gAx : ST_Ax; END_VAR
VAR r : INT; END_VAR
F_Bump(Ax := gAx);
r := F_Bump(gAx);
END_PROGRAM`,
        " c.INST.run();\n std::cout << GAX.value.POS.get() << ' ' << c.INST.R.get() << std::endl;",
        "io_function",
      );
      expect(out).toBe("20 20");
    });

    it("an ARRAY[0..1] OF ST_Ax global passed whole and one element", () => {
      const out = run(
        `PROGRAM MAIN
VAR_EXTERNAL gArr : ARRAY[0..1] OF ST_Ax; END_VAR
VAR m : FB_M; i : INT := 1; END_VAR
F_All(arr := gArr);
m.Drive(Ax := gArr[i]);
F_Bump(gArr[0]);
END_PROGRAM`,
        " c.INST.run();\n std::cout << GARR.value.at(0).POS.get() << ' ' << GARR.value.at(1).POS.get() << std::endl;",
        "io_array",
      );
      expect(out).toBe("1010 1001");
    });

    it("a field of a global struct passed to a VAR_IN_OUT INT", () => {
      const out = run(
        `PROGRAM MAIN
VAR_EXTERNAL gAx : ST_Ax; gArr : ARRAY[0..1] OF ST_Ax; END_VAR
VAR m : FB_M; END_VAR
m.IncInt(v := gAx.cnt);
F_Inc(gAx.cnt);
F_Inc(v := gArr[1].cnt);
END_PROGRAM`,
        " c.INST.run();\n std::cout << GAX.value.CNT.get() << ' ' << GARR.value.at(1).CNT.get() << std::endl;",
        "io_field",
      );
      expect(out).toBe("101 100");
    });

    it("two globals in one call", () => {
      const out = run(
        `PROGRAM MAIN
VAR_EXTERNAL gAx : ST_Ax; gAx2 : ST_Ax; END_VAR
VAR m : FB_M; END_VAR
gAx.pos := 3;
gAx2.pos := 7;
m.Swap(b := gAx2, a := gAx);
END_PROGRAM`,
        " c.INST.run();\n std::cout << GAX.value.POS.get() << ' ' << GAX2.value.POS.get() << std::endl;",
        "io_two_globals",
      );
      expect(out).toBe("7 3");
    });

    it("a VAR_OUTPUT (=>) bound to a composite global", () => {
      const out = run(
        `PROGRAM MAIN
VAR_EXTERNAL gAx : ST_Ax; gArr : ARRAY[0..1] OF ST_Ax; END_VAR
VAR m : FB_M; END_VAR
m.Fill(p := 5, o => gAx);
m.Fill(p := 6, o => gArr[1]);
END_PROGRAM`,
        " c.INST.run();\n std::cout << GAX.value.POS.get() << ' ' << GAX.value.CNT.get() << ' ' << GARR.value.at(1).POS.get() << std::endl;",
        "io_output",
      );
      expect(out).toBe("5 5 6");
    });

    it("a call in an expression", () => {
      // The write to gAx.cnt follows the call, so it is not lost.
      const out = run(
        `PROGRAM MAIN
VAR_EXTERNAL gAx : ST_Ax; gAx2 : ST_Ax; END_VAR
VAR m : FB_M; r : INT; n : INT; END_VAR
r := m.Drive(Ax := gAx) * 100 + F_Bump(Ax := gAx2);
gAx.cnt := m.Drive(Ax := gAx);
IF m.Drive(Ax := gAx) > 2 THEN
  n := n + 1;
END_IF;
WHILE m.Drive(Ax := gAx2) < 13 DO
  n := n + 10;
END_WHILE;
END_PROGRAM`,
        " c.INST.run();\n std::cout << c.INST.R.get() << ' ' << GAX.value.POS.get() << ' ' << GAX.value.CNT.get() << ' ' << GAX2.value.POS.get() << ' ' << c.INST.N.get() << std::endl;",
        "io_expression",
      );
      expect(out).toBe("110 3 2 13 21");
    });

    it("calls in CASE branches (a state machine driving a global axis)", () => {
      // The __gwv_ store temporary sits in a block of its own, so the next
      // case label does not jump over it.
      const out = run(
        `PROGRAM MAIN
VAR_EXTERNAL gAx : ST_Ax; END_VAR
VAR m : FB_M; s : INT; END_VAR
CASE s OF
0: m.Drive(Ax := gAx); s := 1;
1: m.Drive(Ax := gAx); gAx.cnt := m.Drive(Ax := gAx); s := 2;
2: gAx.cnt := gAx.cnt + 10; s := 0;
END_CASE;
END_PROGRAM`,
        " c.INST.run();\n std::cout << GAX.value.POS.get() << ' ' << GAX.value.CNT.get() << std::endl;\n c.INST.run();\n std::cout << GAX.value.POS.get() << ' ' << GAX.value.CNT.get() << std::endl;\n c.INST.run();\n std::cout << GAX.value.POS.get() << ' ' << GAX.value.CNT.get() << ' ' << c.INST.S.get() << std::endl;",
        "io_case_branches",
      );
      expect(out).toBe("1 0\n3 3\n3 13 0");
    });

    it("the generated text binds the in-outs to the globals' storage", () => {
      const result = compileOk(
        withConfig(`PROGRAM MAIN
VAR_EXTERNAL gAx : ST_Ax; gAx2 : ST_Ax; gArr : ARRAY[0..1] OF ST_Ax; END_VAR
VAR m : FB_M; r : INT; i : INT; END_VAR
r := m.Drive(Ax := gAx) + F_Bump(gAx2);
m.Swap(a := gAx, b := gAx2);
F_Inc(v := gArr[i].cnt);
IF m.Drive(Ax := gAx) > 2 THEN r := 0; END_IF;
END_PROGRAM`),
      );
      const code = result.cppCode;
      expect(code).toContain("M.DRIVE(GAX->value)");
      expect(code).toContain("F_BUMP(GAX2->value)");
      expect(code).toContain("M.SWAP(GAX->value, GAX2->value);");
      expect(code).toContain("F_INC(GARR->value.at(I).CNT);");
      // Nothing copied in or out for an in-out, and no call inside a lock.
      expect(code).not.toContain("__gio_");
      for (const body of withLockBodies(code)) {
        expect(body).not.toMatch(/with_lock|DRIVE\(|F_BUMP\(|F_INC\(|SWAP\(/);
      }
      expect(
        result.warnings
          .map((w) => w.message)
          .filter((m) => m.includes("refers to the shared global")),
      ).toHaveLength(7); // the six above, and Drive(gAx) in FB_M.Twice
    });

    describe("the same program built with -DSTRUCPP_THREADED", () => {
      // Built without the shared precompiled header: g++ rejects a PCH whose
      // macro state differs from the translation unit.
      function runThreaded(
        programs: string,
        mainBody: string,
        name: string,
      ): string {
        const result = compileOk(withConfig(programs));
        const dir = path.join(tempDir, `mt_${name}`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "generated.hpp"), result.headerCode);
        const cpp = path.join(dir, `${name}.cpp`);
        fs.writeFileSync(
          cpp,
          `${result.cppCode}\n\n#include <iostream>\nint main() {\n using namespace strucpp;\n Configuration_C c;\n${mainBody}\n return 0;\n}\n`,
        );
        const bin = path.join(dir, name);
        execSync(
          `g++ -std=${CXX_STD} -DSTRUCPP_THREADED -pthread -I"${RUNTIME_INCLUDE_PATH}" -I"${dir}" "${cpp}" -o "${bin}" 2>&1`,
          { encoding: "utf-8", env: cxxEnv },
        );
        // A deadlock would hang here; the timeout turns it into a failure.
        return execSync(`"${bin}"`, {
          encoding: "utf-8",
          timeout: 10000,
        }).trim();
      }

      it("runs the program-body, function, array, field and two-global calls", () => {
        const out = runThreaded(
          `PROGRAM MAIN
VAR_EXTERNAL gAx : ST_Ax; gAx2 : ST_Ax; gArr : ARRAY[0..1] OF ST_Ax; END_VAR
VAR m : FB_M; r : INT; END_VAR
r := m.Drive(Ax := gAx) + F_Bump(gAx2);
F_All(arr := gArr);
F_Inc(v := gArr[0].cnt);
m.Swap(a := gAx, b := gAx2);
END_PROGRAM`,
          " c.INST.run();\n std::cout << GAX.value.POS.get() << ' ' << GAX2.value.POS.get() << ' ' << GARR.value.at(0).POS.get() << ' ' << GARR.value.at(0).CNT.get() << ' ' << c.INST.R.get() << std::endl;",
          "mt_all",
        );
        expect(out).toBe("10 1 1000 100 11");
      });

      it("a method that also reads the same global through its owner's VAR_EXTERNAL returns without deadlock", () => {
        const out = runThreaded(
          `PROGRAM MAIN
VAR_EXTERNAL gAx : ST_Ax; END_VAR
VAR m : FB_M; r : INT; END_VAR
r := m.DriveAndPeek(Ax := gAx);
END_PROGRAM`,
          " c.INST.run(); c.INST.run();\n std::cout << GAX.value.POS.get() << ' ' << c.INST.R.get() << std::endl;",
          "mt_peek",
        );
        // The in-out is the global: the method sees its own write.
        expect(out).toBe("2 2");
      });
    });
  },
);
