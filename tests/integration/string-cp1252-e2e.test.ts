// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: a STRING holds Windows-1252 bytes, one per character. LEN, CODE,
 * comparison and the STRING/WSTRING conversions follow CP1252, OSCAT's
 * CHARNAME/CHARCODE find their table entries, and the debug wire carries the
 * value as UTF-8: read transcodes, write and force decode, and a character
 * CP1252 lacks is refused with STATUS_NOT_ENCODABLE.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import { compile } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";
import {
  hasGpp,
  createPCH,
  compileAndRunStandalone,
  runE2ETestPipeline,
  RUNTIME_INCLUDE_PATH,
  cxxEnv,
  CXX_STD,
} from "./test-helpers.js";

const LIBS_DIR = path.resolve(__dirname, "../../libs");
const libsAvailable = fs.existsSync(path.join(LIBS_DIR, "oscat-basic.stlib"));

const CFG = `
CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;

describe.skipIf(!hasGpp)("STRING as Windows-1252 — g++ e2e", () => {
  let tempDir: string;
  let pchPath: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-cp1252-"));
    pchPath = createPCH(tempDir);
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("counts, codes, compares and converts one byte per character", () => {
    const source = `TYPE ST : STRUCT a : STRING := 'Grüße€'; END_STRUCT END_TYPE
PROGRAM Main
VAR
  s : STRING := 'ä'; t : ST; n : INT; m : INT; f : BOOL;
  w : WSTRING; w2 : WSTRING := "€ä☃"; s2 : STRING; n2 : INT;
END_VAR
n := LEN(s);
m := LEN(t.a);
f := s = 'ä';
w := STRING_TO_WSTRING(t.a);
s2 := WSTRING_TO_STRING(w2);
n2 := LEN(s2);
END_PROGRAM
`;
    const result = compile(source, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const stdout = compileAndRunStandalone({
      tempDir,
      pchPath,
      headerCode: result.headerCode,
      cppCode: result.cppCode,
      testName: "string_cp1252",
      mainCode: `
#include <iostream>
int main() {
    strucpp::Program_MAIN p;
    p.run();
    std::cout << p.N.get() << " " << p.M.get() << " " << p.F.get() << " " << std::hex;
    for (size_t i = 0; i < p.W.get().length(); ++i) std::cout << int(p.W.get()[i]) << ",";
    std::cout << " ";
    for (size_t i = 0; i < p.S2.get().length(); ++i)
        std::cout << int(static_cast<unsigned char>(p.S2.get()[i])) << ",";
    std::cout << std::dec << " " << p.N2.get() << std::endl;
    return 0;
}
`,
    });
    expect(stdout).toBe("1 6 1 47,72,fc,df,65,20ac, 80,e4,3f, 3");
  });

  it.skipIf(!libsAvailable)(
    "finds OSCAT's character names in full-length CHARNAMES",
    () => {
      const source = `PROGRAM Main
VAR
  nEuro : STRING(10); nUcirc : STRING(10); nFrac12 : STRING(10);
  cEuro : BYTE; cAuml : BYTE; cUcirc : BYTE; cFrac12 : BYTE;
  l1 : INT; l2 : INT; l3 : INT; l4 : INT; codeA : BYTE; codeE : BYTE;
END_VAR
nEuro := CHARNAME(BYTE#16#80);
nUcirc := CHARNAME(BYTE#16#DB);
nFrac12 := CHARNAME(BYTE#16#BD);
cEuro := CHARCODE('euro');
cAuml := CHARCODE('auml');
cUcirc := CHARCODE('Ucirc');
cFrac12 := CHARCODE('frac12');
l1 := LEN(setup.CHARNAMES[1]);
l2 := LEN(setup.CHARNAMES[2]);
l3 := LEN(setup.CHARNAMES[3]);
l4 := LEN(setup.CHARNAMES[4]);
codeA := CODE('ä', 1);
codeE := CODE('€', 1);
END_PROGRAM
`;
      const result = compile(source, {
        headerFileName: "generated.hpp",
        libraries: discoverStlibs(LIBS_DIR),
      });
      expect(result.errors).toEqual([]);
      const stdout = compileAndRunStandalone({
        tempDir,
        pchPath,
        headerCode: result.headerCode,
        cppCode: result.cppCode,
        testName: "string_cp1252_oscat",
        mainCode: `
#include <iostream>
int main() {
    static strucpp::Program_MAIN p;
    p.run();
    std::cout << p.NEURO.get().c_str() << " " << p.NUCIRC.get().c_str() << " "
              << p.NFRAC12.get().c_str() << " " << int(p.CEURO.get()) << " "
              << int(p.CAUML.get()) << " " << int(p.CUCIRC.get()) << " "
              << int(p.CFRAC12.get()) << " " << p.L1.get() << " " << p.L2.get()
              << " " << p.L3.get() << " " << p.L4.get() << " " << int(p.CODEA.get())
              << " " << int(p.CODEE.get()) << std::endl;
    return 0;
}
`,
      });
      expect(stdout).toBe(
        "euro Ucirc frac12 128 228 219 189 253 253 250 49 228 128",
      );
    },
  );

  it("carries STRING values as UTF-8 on the debug wire", () => {
    const long = "a" + "ä".repeat(63);
    const source = `PROGRAM Main
VAR s : STRING := 'Grüße€'; l : STRING := '${long}'; n : DINT := 0; END_VAR
  n := n + 1;
END_PROGRAM${CFG}`;
    const result = compile(source, { headerFileName: "generated.hpp" });
    expect(result.errors).toEqual([]);
    const leaf = (p: string): string => {
      const found = result.debugMap!.leaves.find((x) => x.path === p)!;
      return `${found.arrayIdx}, ${found.elemIdx}`;
    };
    const s = leaf("INSTANCE0.S");
    const l = leaf("INSTANCE0.L");
    const dir = path.join(tempDir, "wire");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "generated.hpp"), result.headerCode);
    fs.writeFileSync(path.join(dir, "generated.cpp"), result.cppCode);
    fs.writeFileSync(
      path.join(dir, "generated_debug.cpp"),
      result.debugTableCpp!,
    );
    fs.writeFileSync(
      path.join(dir, "main.cpp"),
      `#include "generated.hpp"
#include "debug_dispatch.hpp"
#include <cstdio>
#include <cstring>
strucpp::Configuration_CONFIG0 g_config;
using namespace strucpp::debug;
static int fails = 0;
static void eq(const char* what, long got, long want) {
  if (got != want) { printf("FAIL %s: got %ld want %ld\\n", what, got, want); ++fails; }
}
static void bytes(const char* what, const unsigned char* got, const char* want, size_t n) {
  if (std::memcmp(got, want, n) != 0) { printf("FAIL %s\\n", what); ++fails; }
}
int main() {
  unsigned char buf[256] = {0};
  // Read: CP1252 'Grüße€' (6 bytes) goes out as 10 UTF-8 bytes.
  handle_read(${s}, buf);
  eq("read len", buf[0], 10);
  bytes("read utf8", buf + 1, "Gr\\xC3\\xBC\\xC3\\x9F" "e\\xE2\\x82\\xAC", 10);
  // A value whose UTF-8 form passes the window is cut before a split character.
  handle_read(${l}, buf);
  eq("cut len", buf[0], 125);
  eq("cut tail zeroed", buf[126], 0);
  // Write: UTF-8 'ä€' is stored as the two CP1252 bytes E4 80.
  unsigned char w[6] = { 5, 0xC3, 0xA4, 0xE2, 0x82, 0xAC };
  eq("write", handle_write(${s}, w, 6), STATUS_OK);
  eq("stored len", g_config.INSTANCE0.S.get().length(), 2);
  bytes("stored", (const unsigned char*)g_config.INSTANCE0.S.get().c_str(), "\\xE4\\x80", 2);
  // The pointer op hands out the raw CP1252 bytes.
  uint16_t plen = 0;
  const unsigned char* raw = (const unsigned char*)handle_ptr(${s}, &plen);
  eq("ptr len", plen, 2);
  bytes("ptr bytes", raw, "\\xE4\\x80", 2);
  // Force: UTF-8 'Ü' is stored as DC and read back as UTF-8.
  unsigned char f[3] = { 2, 0xC3, 0x9C };
  eq("force", handle_set(${s}, true, f, 3), STATUS_OK);
  bytes("forced", (const unsigned char*)g_config.INSTANCE0.S.get().c_str(), "\\xDC", 1);
  handle_read(${s}, buf);
  eq("forced read len", buf[0], 2);
  bytes("forced read", buf + 1, "\\xC3\\x9C", 2);
  handle_set(${s}, false, nullptr, 0);
  // A character CP1252 lacks, or bytes that are not UTF-8, are refused.
  unsigned char nul[4] = { 3, 'a', 0, 'b' };
  eq("write NUL", handle_write(${s}, nul, 4), STATUS_NOT_ENCODABLE);
  eq("force NUL", handle_set(${s}, true, nul, 4), STATUS_NOT_ENCODABLE);
  unsigned char snow[4] = { 3, 0xE2, 0x98, 0x83 };
  unsigned char bad[2] = { 1, 0xFF };
  eq("write snowman", handle_write(${s}, snow, 4), STATUS_NOT_ENCODABLE);
  eq("force snowman", handle_set(${s}, true, snow, 4), STATUS_NOT_ENCODABLE);
  eq("write invalid", handle_write(${s}, bad, 2), STATUS_NOT_ENCODABLE);
  eq("force invalid", handle_set(${s}, true, bad, 2), STATUS_NOT_ENCODABLE);
  eq("untouched", g_config.INSTANCE0.S.get().length(), 1);
  printf(fails ? "FAILURES=%d\\n" : "ALL_OK\\n", fails);
  return fails ? 1 : 0;
}
`,
    );
    const bin = path.join(dir, "wire");
    execSync(
      `g++ -std=${CXX_STD} -I"${RUNTIME_INCLUDE_PATH}" -I"${dir}" -o "${bin}" ` +
        `"${path.join(dir, "main.cpp")}" "${path.join(dir, "generated.cpp")}" ` +
        `"${path.join(dir, "generated_debug.cpp")}"`,
      { encoding: "utf-8", env: cxxEnv },
    );
    expect(execSync(`"${bin}"`, { encoding: "utf-8" }).trim()).toBe("ALL_OK");
  });

  it("shows an assertion message and STRING values as UTF-8", () => {
    const { stdout, exitCode } = runE2ETestPipeline({
      sourceST: `PROGRAM P
  VAR s : STRING := 'ä'; END_VAR
END_PROGRAM
`,
      testST: `TEST 'Umlaut'
  VAR uut : P; END_VAR
  uut();
  ASSERT_EQ(uut.s, 'ö', 'Meldung äöü $$5');
END_TEST
`,
      testFileName: "test_umlaut.st",
      tempDirPrefix: "strucpp-cp1252-msg-",
    });
    expect(exitCode).toBe(1);
    expect(stdout).toContain("Message: Meldung äöü $5");
    expect(stdout).toContain("'ö'");
    expect(stdout).toContain("'ä'");
  });
});
