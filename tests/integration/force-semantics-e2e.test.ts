// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: forcing through the debugger protocol (handle_set) with the force
 * table's cycle-boundary semantics. A forced value is written in when a
 * PROGRAM cycle starts and again when it ends; inside the cycle the program's
 * own writes are what it reads; every external reader sees the forced value.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import { compile } from "../../src/index.js";
import { hasGpp, CXX_STD, RUNTIME_INCLUDE_PATH } from "./test-helpers.js";

const CFG = `
CONFIGURATION Config0
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;

/** Helpers prepended to every driver: force / read an INT leaf by path. */
const PRELUDE = `#include "generated.hpp"
#include "debug_dispatch.hpp"
#include <cstdio>
#include <cstring>
using namespace strucpp;
Configuration_CONFIG0 g_config;
static int force_int(uint8_t a, uint16_t e, int16_t v) {
  unsigned char b[2]; std::memcpy(b, &v, 2);
  return debug::handle_set(a, e, true, b, 2);
}
static int read_int(uint8_t a, uint16_t e) {
  unsigned char b[8] = {0}; debug::handle_read(a, e, b);
  int16_t v; std::memcpy(&v, b, 2); return v;
}
`;

describe.skipIf(!hasGpp)("forcing semantics at cycle boundaries", () => {
  let tempDir: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-force-sem-"));
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  /**
   * Compile `source`, substitute `@PATH@` in `body` with each leaf's
   * "arr, elem", build with the debug table and run.
   */
  function run(
    name: string,
    source: string,
    body: string,
    flags: string[] = [],
  ): string {
    const result = compile(source, { headerFileName: "generated.hpp" });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    const main = body.replace(/@([A-Z0-9_.]+)@/g, (_m, p: string) => {
      const leaf = result.debugMap!.leaves.find((l) => l.path === p);
      if (!leaf) throw new Error(`no leaf ${p}`);
      return `${leaf.arrayIdx}, ${leaf.elemIdx}`;
    });
    const dir = path.join(tempDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "generated.hpp"), result.headerCode);
    fs.writeFileSync(path.join(dir, "generated.cpp"), result.cppCode);
    fs.writeFileSync(
      path.join(dir, "generated_debug.cpp"),
      result.debugTableCpp!,
    );
    fs.writeFileSync(path.join(dir, "main.cpp"), PRELUDE + main);
    const bin = path.join(dir, name);
    execSync(
      `g++ -std=${CXX_STD} ${flags.join(" ")} -I"${RUNTIME_INCLUDE_PATH}" -I"${dir}" -o "${bin}" ` +
        ["main.cpp", "generated.cpp", "generated_debug.cpp"]
          .map((f) => `"${path.join(dir, f)}"`)
          .join(" "),
      { encoding: "utf-8" },
    );
    return execSync(`"${bin}"`, { encoding: "utf-8" }).trim();
  }

  it("a program reads its own write to a forced variable until the cycle ends", () => {
    const out = run(
      "own_write",
      `PROGRAM Main
         VAR x : INT; before : INT; after : INT; END_VAR
         before := x;
         x := 5;
         after := x;
       END_PROGRAM${CFG}`,
      `int main() {
  force_int(@INSTANCE0.X@, 100);
  g_config.INSTANCE0.run();
  std::printf("%d %d %d %d\\n", (int)g_config.INSTANCE0.BEFORE,
              (int)g_config.INSTANCE0.AFTER, (int)g_config.INSTANCE0.X,
              read_int(@INSTANCE0.X@));
  return 0;
}
`,
    );
    // read at start: forced; after its own write: 5; after the cycle: forced.
    expect(out).toBe("100 5 100 100");
  });

  it("a forced function-block input passed by the call takes the call's value inside the cycle", () => {
    const out = run(
      "fb_input",
      `FUNCTION_BLOCK Pass
         VAR_INPUT i : INT; END_VAR
         VAR_OUTPUT o : INT; END_VAR
         o := i;
       END_FUNCTION_BLOCK
       PROGRAM Main
         VAR fb : Pass; free : Pass; out : INT; out2 : INT; END_VAR
         fb(i := 7);
         out := fb.o;
         free();
         out2 := free.o;
       END_PROGRAM${CFG}`,
      `int main() {
  force_int(@INSTANCE0.FB.I@, 100);
  force_int(@INSTANCE0.FREE.I@, 200);
  g_config.INSTANCE0.run();
  std::printf("%d %d %d %d\\n", (int)g_config.INSTANCE0.OUT,
              (int)g_config.INSTANCE0.FB.I, (int)g_config.INSTANCE0.OUT2,
              (int)g_config.INSTANCE0.FREE.I);
  return 0;
}
`,
    );
    // The call writes i := 7 inside the cycle, so the block sees 7; the force
    // is written back at cycle end. An input no call passes keeps its force.
    expect(out).toBe("7 100 200 200");
  });

  it("a forced located output holds the forced value in its I/O storage after the cycle", () => {
    const out = run(
      "located_output",
      `PROGRAM Main
         VAR q AT %QW0 : INT; END_VAR
         q := 1;
       END_PROGRAM${CFG}`,
      `int main() {
  force_int(@INSTANCE0.Q@, 55);
  g_config.INSTANCE0.run();
  int16_t image = 0;
  std::memcpy(&image, locatedVars[0].pointer, 2);
  std::printf("%d\\n", (int)image);
  return 0;
}
`,
    );
    expect(out).toBe("55");
  });

  it("external readers see the forced value while the program has overwritten it", () => {
    const out = run(
      "external_reader",
      `PROGRAM Main
         VAR RETAIN r : INT; END_VAR
         r := r + 1;
       END_PROGRAM${CFG}`,
      `int main() {
  force_int(@INSTANCE0.R@, 50);
  g_config.INSTANCE0.R = 3;  // as the program would mid-cycle
  unsigned short len = 0;
  int16_t via_ptr = 0;
  std::memcpy(&via_ptr, debug::handle_ptr(@INSTANCE0.R@, &len), 2);
  std::printf("%d %d\\n", read_int(@INSTANCE0.R@), (int)via_ptr);
  return 0;
}
`,
    );
    expect(out).toBe("50 50");
  });

  it("a soft write to a forced leaf is dropped and an unforce leaves the value in place", () => {
    const out = run(
      "soft_write",
      `PROGRAM Main
         VAR x : INT; END_VAR
       END_PROGRAM${CFG}`,
      `int main() {
  force_int(@INSTANCE0.X@, 9);
  int16_t v = 4; unsigned char b[2]; std::memcpy(b, &v, 2);
  int w = debug::handle_write(@INSTANCE0.X@, b, 2);
  int a = (int)g_config.INSTANCE0.X;
  int u = debug::handle_set(@INSTANCE0.X@, false, nullptr, 0);
  g_config.INSTANCE0.run();
  std::printf("%d %d %d %d\\n", w == debug::STATUS_OK, a, u == debug::STATUS_OK,
              (int)g_config.INSTANCE0.X);
  return 0;
}
`,
    );
    expect(out).toBe("1 9 1 9");
  });

  it("refuses a force once the force table is full", () => {
    const out = run(
      "table_full",
      `PROGRAM Main
         VAR a : INT; b : INT; c : INT; END_VAR
       END_PROGRAM${CFG}`,
      `int main() {
  int s1 = force_int(@INSTANCE0.A@, 1);
  int s2 = force_int(@INSTANCE0.B@, 2);
  int s3 = force_int(@INSTANCE0.C@, 3);
  std::printf("%d %d %d %d\\n", s1 == debug::STATUS_OK, s2 == debug::STATUS_OK,
              s3 == debug::STATUS_FORCE_TABLE_FULL, (int)g_config.INSTANCE0.C);
  return 0;
}
`,
      ["-DSTRUCPP_FORCE_SLOTS=2"],
    );
    expect(out).toBe("1 1 1 0");
  });

  it("under STRUCPP_THREADED, a program applies its own forces and the globals' only", () => {
    const out = run(
      "threaded_ownership",
      `PROGRAM Main
         VAR_EXTERNAL g : INT; END_VAR
         VAR seen : INT; END_VAR
         seen := g;
       END_PROGRAM
       PROGRAM Other
         VAR y : INT; END_VAR
       END_PROGRAM
       CONFIGURATION Config0
         VAR_GLOBAL g : INT; END_VAR
         RESOURCE Res0 ON PLC
           TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
           TASK task1(INTERVAL := T#20ms, PRIORITY := 1);
           PROGRAM instance0 WITH task0 : Main;
           PROGRAM instance1 WITH task1 : Other;
         END_RESOURCE
       END_CONFIGURATION`,
      `int main() {
  force_int(@G@, 41);
  force_int(@INSTANCE1.Y@, 9);
  G.value = 0;
  g_config.INSTANCE1.Y = 0;
  g_config.INSTANCE0.run();
  int seen = (int)g_config.INSTANCE0.SEEN;
  int y_after_other_task = (int)g_config.INSTANCE1.Y;
  g_config.INSTANCE1.run();
  std::printf("%d %d %d\\n", seen, y_after_other_task, (int)g_config.INSTANCE1.Y);
  return 0;
}
`,
      ["-DSTRUCPP_THREADED", "-pthread"],
    );
    // instance0 applies the global's force but not instance1's; instance1 does.
    expect(out).toBe("41 0 9");
  });
});
