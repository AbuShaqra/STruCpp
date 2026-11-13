/**
 * `ADR(x)` as the initial value of an integer variable (`__XWORD`, `ULINT`,
 * `LWORD`) builds and stores the address, in a PROGRAM, a FUNCTION and a
 * top-level VAR_GLOBAL (g++).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile, type CompileOptions } from "../../src/index.js";
import { execSync } from "child_process";
import {
  hasGpp,
  createPCH,
  compileAndRunStandalone,
  CXX_STD,
  RUNTIME_INCLUDE_PATH,
} from "./test-helpers.js";

const SOURCE = `VAR_GLOBAL g : INT := 7; gw : __XWORD := ADR(g); END_VAR
FUNCTION F : INT
VAR x : INT := 9; w : __XWORD := ADR(x); p : POINTER TO INT; END_VAR
p := w;
F := p^;
END_FUNCTION
PROGRAM MAIN
VAR
  x : INT := 5;
  w : __XWORD := ADR(x);
  u : ULINT := ADR(x);
  lw : LWORD := ADR(x);
  t : __XWORD;
  p : POINTER TO INT;
  same, viaGlobal, fromFunction : INT;
END_VAR
t := ADR(x);
IF w = t THEN same := same + 1; END_IF;
IF u = t THEN same := same + 1; END_IF;
IF lw = t THEN same := same + 1; END_IF;
p := gw;
viaGlobal := p^;
fromFunction := F();
END_PROGRAM
`;

describe("ADR into an integer narrower than an address", () => {
  it("is refused in an initial value and a FUNCTION or METHOD argument", () => {
    const src = `FUNCTION GU : UDINT
VAR_INPUT d : UDINT; END_VAR
GU := d;
END_FUNCTION
FUNCTION_BLOCK FBU
VAR_INPUT d : UDINT; END_VAR
METHOD M : INT
VAR_INPUT w : DWORD; END_VAR
M := 1;
END_METHOD
END_FUNCTION_BLOCK
PROGRAM MAIN
VAR x : INT; ui : UDINT := ADR(x); ii : INT := ADR(x); u : UDINT; i : INT; fb : FBU; END_VAR
u := GU(ADR(x));
i := fb.M(w := ADR(x));
END_PROGRAM
`;
    const tail = "use a POINTER TO or PVOID, or __XWORD, LWORD or ULINT";
    for (const opts of [
      {},
      { strict: true },
      { dialect: "iec-3", features: ["+pointer_to"] },
    ]) {
      expect(
        compile(src, opts as Partial<CompileOptions>).errors.map(
          (e) => `${e.line}:${e.column}: ${e.message}`,
        ),
      ).toEqual([
        `13:28: ADR gives a 64-bit address, which UDINT cannot hold; ${tail}`,
        `13:48: ADR gives a 64-bit address, which INT cannot hold; ${tail}`,
        `14:9: ADR gives a 64-bit address, which UDINT cannot hold; ${tail}`,
        `15:16: ADR gives a 64-bit address, which DWORD cannot hold; ${tail}`,
      ]);
    }
  });
});

describe.skipIf(!hasGpp)("IECVar from a raw pointer (C++)", () => {
  it("takes only an object address, into an address-wide integer", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-xword-ctor-"));
    const src = path.join(dir, "ctor.cpp");
    fs.writeFileSync(
      src,
      `#include "iec_types.hpp"
#include "iec_var.hpp"
#include <string>
#include <type_traits>
using namespace strucpp;
static_assert(std::is_constructible<IEC_ULINT, IEC_INT*>::value, "object address");
static_assert(std::is_constructible<IEC_LWORD, IEC_REAL*>::value, "object address");
static_assert(!std::is_constructible<IEC_ULINT, const char*>::value, "char");
static_assert(!std::is_constructible<IEC_ULINT, const char16_t*>::value, "char16_t");
static_assert(!std::is_constructible<IEC_ULINT, const char32_t*>::value, "char32_t");
static_assert(!std::is_constructible<IEC_ULINT, const wchar_t*>::value, "wchar_t");
static_assert(!std::is_constructible<IEC_ULINT, signed char*>::value, "signed char");
static_assert(!std::is_constructible<IEC_ULINT, unsigned char*>::value, "unsigned char");
static_assert(!std::is_constructible<IEC_ULINT, void (*)()>::value, "function");
static_assert(!std::is_constructible<IEC_UDINT, IEC_INT*>::value, "narrower than an address");
int g(IEC_ULINT) { return 1; }
int g(std::u16string) { return 2; }
int h(IEC_ULINT) { return 1; }
int h(std::string) { return 2; }
static_assert(sizeof(g(u"abc")) > 0, "u16 literal picks the string overload");
static_assert(sizeof(h("abc")) > 0, "literal picks the string overload");
`,
    );
    try {
      execSync(
        `g++ -std=${CXX_STD} -fsyntax-only -I"${RUNTIME_INCLUDE_PATH}" "${src}" 2>&1`,
        { encoding: "utf-8" },
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!hasGpp)("ADR as an initial value of an integer", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-xword-init-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("stores the address, as an assignment in the body does", () => {
    for (const [opts, name] of [
      [{}, "xword_init_default"],
      [{ strict: true }, "xword_init_strict"],
    ] as [Partial<CompileOptions>, string][]) {
      const result = compile(SOURCE, {
        headerFileName: "generated.hpp",
        ...opts,
      });
      expect(result.errors).toEqual([]);
      const out = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: name,
        mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p; p.run();\n std::cout << (int)p.SAME.get() << " " << (int)p.VIAGLOBAL.get() << " " << (int)p.FROMFUNCTION.get();\n return 0;\n}\n`,
      });
      expect(out.trim().split(/\s+/)).toEqual(["3", "7", "9"]);
    }
  });

  it("passes an address to a __XWORD input and keeps string literals for STRING inputs", () => {
    const src = `FUNCTION G : __XWORD
VAR_INPUT d : __XWORD; END_VAR
G := d;
END_FUNCTION
FUNCTION FS : INT
VAR_INPUT s : STRING; END_VAR
FS := LEN(s);
END_FUNCTION
PROGRAM MAIN
VAR x : INT; t, w : __XWORD; same : BOOL; n : INT; s : STRING; END_VAR
t := ADR(x);
w := G(ADR(x));
same := w = t;
n := FS('xyz') + LEN('ab');
s := CONCAT('a', 'bc');
END_PROGRAM
`;
    const result = compile(src, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const out = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "xword_init_args",
      mainCode: `#include <iostream>\nint main() {\n using namespace strucpp;\n Program_MAIN p; p.run();\n std::cout << (int)p.SAME.get() << " " << (int)p.N.get() << " " << p.S.get().c_str();\n return 0;\n}\n`,
    });
    expect(out.trim()).toBe("1 5 abc");
  });
});
