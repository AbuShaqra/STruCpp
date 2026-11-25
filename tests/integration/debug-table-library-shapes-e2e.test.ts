// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: the debug table lists the elements of an array field and the value of
 * an enumeration of a library type whose archive records their shapes, and a
 * RETAIN power cycle through that table restores them.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import { compile, compileStlib } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";
import { loadStlibArchive } from "../../src/library/library-loader.js";
import { hasGpp, CXX_STD } from "./test-helpers.js";

const RUNTIME_INCLUDE = path.resolve(__dirname, "../../src/runtime/include");

const LIB = `TYPE LCol : (LA, LB, LC); END_TYPE
TYPE LS : STRUCT arr : ARRAY[1..3] OF INT; c : LCol := LB; END_STRUCT END_TYPE`;

const SOURCE = `
PROGRAM Main
VAR RETAIN e : ESR_DATA; st : SMC_AXIS_STATE; ls : LS; c : LCol; END_VAR
END_PROGRAM
CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION
`;

const MAIN_CPP = `#include "generated.hpp"
#include "debug_dispatch.hpp"
#include "iec_retain.hpp"
#include <cstdio>
strucpp::Configuration_CONFIG0 g_config;
using namespace strucpp;
static int fails = 0;
static void chk(const char* what, bool ok) { if (!ok) { printf("FAIL %s\\n", what); ++fails; } }
static uint16_t rd(uint8_t a, uint16_t e, uint8_t* d) { return debug::handle_read(a, e, d); }
static uint8_t  wr(uint8_t a, uint16_t e, const uint8_t* b, uint16_t n) { return debug::handle_write(a, e, b, n); }
static uint16_t sz(uint8_t a, uint16_t e) { return debug::handle_size(a, e); }

int main() {
  auto& p = g_config.INSTANCE0;
  p.E.TYP = 5;
  p.E.DATA[3] = 99;
  p.ST = SMC_AXIS_STATE::HOMING;
  p.LS_.ARR[2] = 77;
  p.LS_.C = LCOL::LC;
  p.C = LCOL::LB;

  unsigned char blob[1024] = {0};
  size_t n = retain::pack(blob, sizeof(blob), rd, sz);
  chk("packed", n == retain::blob_size(sz));

  // Power cycle.
  p.E.TYP = 0;
  p.E.DATA[3] = 0;
  p.ST = SMC_AXIS_STATE::POWER_OFF;
  p.LS_.ARR[2] = 0;
  p.LS_.C = LCOL::LA;
  p.C = LCOL::LA;

  chk("unpack ok", retain::unpack(blob, n, wr, sz) == retain::LoadResult::Ok);
  chk("library struct field", (int)p.E.TYP == 5);
  chk("library array field element", (int)p.E.DATA[3] == 99);
  chk("library enumeration", p.ST.get() == SMC_AXIS_STATE::HOMING);
  chk("array field of a consumer's library", (int)p.LS_.ARR[2] == 77);
  chk("enumeration field of a consumer's library", p.LS_.C.get() == LCOL::LC);
  chk("library enumeration variable", p.C.get() == LCOL::LB);

  printf(fails ? "FAILURES=%d\\n" : "ALL_OK\\n", fails);
  return fails ? 1 : 0;
}
`;

describe.skipIf(!hasGpp)("debug table over library shapes — g++ e2e", () => {
  let tempDir: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-dbg-libshapes-"));
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("restores library array elements and enumerations", () => {
    const base = discoverStlibs("libs");
    const lib = compileStlib([{ source: LIB, fileName: "l.st" }], {
      name: "ldbg",
      version: "1.0.0",
      namespace: "ldbg",
      dependencies: base,
    });
    expect(lib.errors).toEqual([]);
    const result = compile(SOURCE, {
      headerFileName: "generated.hpp",
      libraries: [
        ...base,
        loadStlibArchive(JSON.parse(JSON.stringify(lib.archive))),
      ],
    });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    const leaves = result.debugMap!.leaves.map((l) => `${l.path} ${l.type}`);
    expect(leaves).toEqual(
      expect.arrayContaining([
        "INSTANCE0.E.DATA[3] BYTE",
        "INSTANCE0.ST INT",
        "INSTANCE0.LS.ARR[2] INT",
        "INSTANCE0.LS.C INT",
        "INSTANCE0.C INT",
      ]),
    );
    const dir = tempDir;
    fs.writeFileSync(path.join(dir, "generated.hpp"), result.headerCode);
    fs.writeFileSync(
      path.join(dir, "generated_debug.cpp"),
      result.debugTableCpp!,
    );
    fs.writeFileSync(path.join(dir, "main.cpp"), MAIN_CPP);
    const sources = (result.cppFiles ?? []).map((f) => {
      const fp = path.join(dir, f.name);
      fs.writeFileSync(fp, f.content);
      return `"${fp}"`;
    });
    const bin = path.join(dir, "libshapes-retain");
    execSync(
      `g++ -std=${CXX_STD} -I"${RUNTIME_INCLUDE}" -I"${dir}" -o "${bin}" ` +
        `"${path.join(dir, "main.cpp")}" ` +
        `"${path.join(dir, "generated_debug.cpp")}" ${sources.join(" ")}`,
      { encoding: "utf-8" },
    );
    expect(execSync(`"${bin}"`, { encoding: "utf-8" }).trim()).toBe("ALL_OK");
  });
});
