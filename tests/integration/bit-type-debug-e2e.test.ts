/**
 * BIT members (feature bit_type) through the debug table and the force table
 * (g++): read, soft-write, force and unforce one bit, with the other bits of
 * its byte untouched; a forced bit holds across the cycle; the same for a
 * CONFIGURATION global under STRUCPP_THREADED.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import { compile } from "../../src/index.js";
import { hasGpp, CXX_STD, RUNTIME_INCLUDE_PATH } from "./test-helpers.js";

const SOURCE = `TYPE ST_B : STRUCT a : BIT; b : BIT; c : BIT; n : INT; END_STRUCT; END_TYPE
PROGRAM Main
VAR s : ST_B; seenB : BOOL; cycles : INT; END_VAR
VAR_EXTERNAL g : ST_B; END_VAR
seenB := s.b;
s.a := NOT s.a;
s.b := FALSE;
g.c := TRUE;
cycles := cycles + 1;
END_PROGRAM
CONFIGURATION Config0
  VAR_GLOBAL g : ST_B; END_VAR
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION
`;

describe.skipIf(!hasGpp)("bit_type — debug and force", () => {
  let tempDir: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-bit-debug-"));
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  function buildAndRun(
    name: string,
    mainCpp: string,
    threaded: boolean,
  ): string {
    const result = compile(SOURCE, {
      headerFileName: "generated.hpp",
      features: ["+bit_type"],
    });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    const dir = path.join(tempDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "generated.hpp"), result.headerCode);
    fs.writeFileSync(path.join(dir, "generated.cpp"), result.cppCode);
    fs.writeFileSync(
      path.join(dir, "generated_debug.cpp"),
      result.debugTableCpp!,
    );
    fs.writeFileSync(path.join(dir, "main.cpp"), mainCpp(leafAt(result)));
    const bin = path.join(dir, name);
    execSync(
      `g++ -std=${CXX_STD} ${threaded ? "-DSTRUCPP_THREADED -pthread" : ""} -I"${RUNTIME_INCLUDE_PATH}" -I"${dir}" -o "${bin}" ` +
        ["main.cpp", "generated.cpp", "generated_debug.cpp"]
          .map((f) => `"${path.join(dir, f)}"`)
          .join(" "),
      { encoding: "utf-8" },
    );
    return execSync(`"${bin}"`, { encoding: "utf-8" }).trim();
  }

  function leafAt(result: ReturnType<typeof compile>): (p: string) => string {
    return (p: string): string => {
      const leaf = result.debugMap!.leaves.find((l) => l.path === p);
      expect(leaf, p).toBeTruthy();
      return `${leaf!.arrayIdx}, ${leaf!.elemIdx}`;
    };
  }

  const MAIN = (at: (p: string) => string): string => `#include "generated.hpp"
#include "debug_dispatch.hpp"
#include <cstdio>
using namespace strucpp;
Configuration_CONFIG0 g_config;
static unsigned rd(uint8_t a, uint16_t e) { unsigned char b[4] = {0}; debug::handle_read(a, e, b); return b[0]; }
#define AT_A ${at("INSTANCE0.S.A")}
#define AT_B ${at("INSTANCE0.S.B")}
#define AT_C ${at("INSTANCE0.S.C")}
#define AT_GC ${at("G.C")}
#define AT_GA ${at("G.A")}
int main() {
  auto& s = g_config.INSTANCE0.S;
  const unsigned char* byte = reinterpret_cast<const unsigned char*>(&s.bits_0_);
  // Soft write of C: one bit, neighbours kept.
  const unsigned char one = 1;
  int w = debug::handle_write(AT_C, &one, 1);
  std::printf("w%d %u %u|", w == debug::STATUS_OK ? 0 : w, (unsigned)*byte, rd(AT_C));
  // Force B to TRUE: the program writes FALSE to it every cycle and toggles A.
  int f = debug::handle_set(AT_B, true, &one, 1);
  g_config.INSTANCE0.run();
  std::printf("f%d %u %u %u %d|", f == debug::STATUS_OK ? 0 : f, rd(AT_B), (unsigned)g_config.INSTANCE0.SEENB.get(), rd(AT_A), (int)s.bits_0_.C);
  g_config.INSTANCE0.run();
  std::printf("%u %u %u|", rd(AT_B), (unsigned)g_config.INSTANCE0.SEENB.get(), rd(AT_A));
  // A soft write to a forced bit is ignored.
  const unsigned char zero = 0;
  debug::handle_write(AT_B, &zero, 1);
  std::printf("%u|", rd(AT_B));
  // Force A as well: both bits of one byte forced.
  debug::handle_set(AT_A, true, &zero, 1);
  g_config.INSTANCE0.run();
  std::printf("%u %u %u|", rd(AT_A), rd(AT_B), (unsigned)force::count());
  // Unforce B: A stays forced, B goes back to the program.
  debug::handle_set(AT_B, false, nullptr, 0);
  g_config.INSTANCE0.run();
  std::printf("%u %u %u|", rd(AT_A), rd(AT_B), (unsigned)force::count());
  debug::handle_set(AT_A, false, nullptr, 0);
  std::printf("%u|", (unsigned)force::count());
  // The global: force A, the program sets C.
  debug::handle_set(AT_GA, true, &one, 1);
  g_config.INSTANCE0.run();
  std::printf("%u %u\\n", rd(AT_GA), rd(AT_GC));
  return 0;
}
`;

  const EXPECTED = "w0 4 1|f0 1 1 1 1|1 1 0|1|0 1 1|0 0 1|0|1 1";

  it("reads, writes and forces single bits", () => {
    expect(buildAndRun("bits", MAIN, false)).toBe(EXPECTED);
  });

  it("does the same under STRUCPP_THREADED", () => {
    expect(buildAndRun("bits_threaded", MAIN, true)).toBe(EXPECTED);
  });
});
