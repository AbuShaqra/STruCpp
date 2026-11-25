// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: a RETAIN instance of a FB that EXTENDS another (a user block and the
 * library TON) restores its inherited state after a power cycle, and the
 * debugger reads an inherited member, through the generated debug table.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import { compile } from "../../src/index.js";
import { discoverStlibs } from "../../src/node/library-loader.js";
import { hasGpp, CXX_STD } from "./test-helpers.js";

const RUNTIME_INCLUDE = path.resolve(__dirname, "../../src/runtime/include");

const SOURCE = `
FUNCTION_BLOCK FB_Base
VAR_INPUT bIn : BOOL; END_VAR
VAR nB : INT; END_VAR
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Der EXTENDS FB_Base
VAR nD : INT; END_VAR
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Tn EXTENDS TON
VAR nT : INT; END_VAR
END_FUNCTION_BLOCK
PROGRAM Main
VAR RETAIN d : FB_Der; t : FB_Tn; END_VAR
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
  g_config.INSTANCE0.D.BIN = true;
  g_config.INSTANCE0.D.NB = 41;
  g_config.INSTANCE0.D.ND = 42;
  g_config.INSTANCE0.T.ET = strucpp::TIME_t(1234u);
  g_config.INSTANCE0.T.START_TIME = strucpp::TIME_t(987654u);
  g_config.INSTANCE0.T.NT = 7;

  unsigned char blob[1024] = {0};
  size_t n = retain::pack(blob, sizeof(blob), rd, sz);
  chk("packed", n == retain::blob_size(sz));

  // Power cycle.
  g_config.INSTANCE0.D.BIN = false;
  g_config.INSTANCE0.D.NB = 0;
  g_config.INSTANCE0.D.ND = 0;
  g_config.INSTANCE0.T.ET = strucpp::TIME_t(0u);
  g_config.INSTANCE0.T.START_TIME = strucpp::TIME_t(0u);
  g_config.INSTANCE0.T.NT = 0;

  chk("unpack ok", retain::unpack(blob, n, wr, sz) == retain::LoadResult::Ok);
  chk("inherited input", (bool)g_config.INSTANCE0.D.BIN == true);
  chk("inherited local", (int)g_config.INSTANCE0.D.NB == 41);
  chk("own local", (int)g_config.INSTANCE0.D.ND == 42);
  chk("inherited library output", g_config.INSTANCE0.T.ET.get().raw == 1234u);
  chk("inherited library internal", g_config.INSTANCE0.T.START_TIME.get().raw == 987654u);
  chk("own local of the TON child", (int)g_config.INSTANCE0.T.NT == 7);

  printf(fails ? "FAILURES=%d\\n" : "ALL_OK\\n", fails);
  return fails ? 1 : 0;
}
`;

describe.skipIf(!hasGpp)("RETAIN of a derived FB — g++ e2e", () => {
  let tempDir: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-dbg-inherit-"));
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  it("restores the inherited members", () => {
    const result = compile(SOURCE, {
      headerFileName: "generated.hpp",
      libraries: discoverStlibs("libs"),
    });
    expect(result.errors.map((e) => e.message)).toEqual([]);
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
    const bin = path.join(dir, "inherit-retain");
    execSync(
      `g++ -std=${CXX_STD} -I"${RUNTIME_INCLUDE}" -I"${dir}" -o "${bin}" ` +
        `"${path.join(dir, "main.cpp")}" ` +
        `"${path.join(dir, "generated_debug.cpp")}" ${sources.join(" ")}`,
      { encoding: "utf-8" },
    );
    expect(execSync(`"${bin}"`, { encoding: "utf-8" }).trim()).toBe("ALL_OK");
  });
});
