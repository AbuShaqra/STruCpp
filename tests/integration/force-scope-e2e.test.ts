// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: a PROGRAM's cycle holds a force::Scope, so a value in the force table
 * is written in when the cycle starts and again when it ends, an early RETURN
 * included. Also: an enumeration without a declared base is forced and read
 * through the debug table as the INT it is tagged as, and the generated
 * debug_array_kind table links.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import { compile } from "../../src/index.js";
import { hasGpp, CXX_STD, RUNTIME_INCLUDE_PATH } from "./test-helpers.js";

const MAIN = `
PROGRAM Main
  VAR x : INT; seen : INT; stop : BOOL := TRUE; END_VAR
  seen := x;
  x := 5;
  IF stop THEN RETURN; END_IF;
  x := 6;
END_PROGRAM`;

const CFG = `
CONFIGURATION Config0
  VAR_GLOBAL g : INT; END_VAR
  RESOURCE Res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM instance0 WITH task0 : Main;
  END_RESOURCE
END_CONFIGURATION`;

describe.skipIf(!hasGpp)("force::Scope in generated PROGRAM cycles", () => {
  let tempDir: string;
  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-force-scope-"));
  });
  afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  /** Compile ST, write the generated files and `mainCpp`, build and run. */
  function buildAndRun(
    name: string,
    source: string,
    mainCpp: string,
    withDebugTable: boolean,
  ): string {
    const result = compile(source, { headerFileName: "generated.hpp" });
    expect(result.errors.map((e) => e.message)).toEqual([]);
    const dir = path.join(tempDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "generated.hpp"), result.headerCode);
    fs.writeFileSync(path.join(dir, "generated.cpp"), result.cppCode);
    fs.writeFileSync(path.join(dir, "main.cpp"), mainCpp);
    const sources = [
      path.join(dir, "main.cpp"),
      path.join(dir, "generated.cpp"),
    ];
    if (withDebugTable) {
      fs.writeFileSync(
        path.join(dir, "generated_debug.cpp"),
        result.debugTableCpp!,
      );
      sources.push(path.join(dir, "generated_debug.cpp"));
    }
    const bin = path.join(dir, name);
    execSync(
      `g++ -std=${CXX_STD} -I"${RUNTIME_INCLUDE_PATH}" -I"${dir}" -o "${bin}" ` +
        sources.map((s) => `"${s}"`).join(" "),
      { encoding: "utf-8" },
    );
    return execSync(`"${bin}"`, { encoding: "utf-8" }).trim();
  }

  it("applies a forced value at cycle start and again after an early RETURN", () => {
    const out = buildAndRun(
      "standalone",
      MAIN,
      `#include "generated.hpp"
#include <cstdio>
using namespace strucpp;
int main() {
  Program_MAIN prog;
  const INT_t f = 100;
  force::set(prog.X.raw_ptr(), &f, sizeof f);
  prog.X = 1;
  prog.run();
  std::printf("%d %d\\n", (int)prog.SEEN, (int)prog.X);
  return 0;
}
`,
      false,
    );
    expect(out).toBe("100 100");
  });

  it("does the same for a PROGRAM instance of a configuration", () => {
    const out = buildAndRun(
      "configured",
      MAIN + CFG,
      `#include "generated.hpp"
#include <cstdio>
using namespace strucpp;
Configuration_CONFIG0 g_config;
int main() {
  const INT_t f = 42;
  force::set(g_config.INSTANCE0.X.raw_ptr(), &f, sizeof f);
  g_config.INSTANCE0.X = 1;
  g_config.INSTANCE0.run();
  std::printf("%d %d\\n", (int)g_config.INSTANCE0.SEEN, (int)g_config.INSTANCE0.X);
  return 0;
}
`,
      false,
    );
    expect(out).toBe("42 42");
  });

  it("forces and reads an enumeration without a declared base through the debug table", () => {
    const source = `
TYPE Color : (RED, GREEN, BLUE); END_TYPE
PROGRAM Main
  VAR c : Color; seen : Color; END_VAR
  seen := c;
END_PROGRAM${CFG}`;
    const result = compile(source, { headerFileName: "generated.hpp" });
    const leaf = result.debugMap!.leaves.find((l) => l.path === "INSTANCE0.C");
    expect(leaf).toBeTruthy();
    const at = `${leaf!.arrayIdx}, ${leaf!.elemIdx}`;
    const out = buildAndRun(
      "enum_leaf",
      source,
      `#include "generated.hpp"
#include "debug_dispatch.hpp"
#include <cstdio>
#include <cstring>
using namespace strucpp;
Configuration_CONFIG0 g_config;
int main() {
  const int16_t blue = 2;
  unsigned char bytes[2];
  std::memcpy(bytes, &blue, 2);
  int status = debug::handle_set(${at}, true, bytes, 2);
  g_config.INSTANCE0.run();
  unsigned char buf[8] = {0};
  unsigned n = debug::handle_read(${at}, buf);
  int16_t got = 0;
  std::memcpy(&got, buf, 2);
  std::printf("%d %u %d %d %d\\n", status == debug::STATUS_OK ? 0 : status, n, (int)got,
              (int)static_cast<INT_t>(static_cast<COLOR>(g_config.INSTANCE0.C.get())),
              (int)static_cast<INT_t>(static_cast<COLOR>(g_config.INSTANCE0.SEEN.get())));
  return 0;
}
`,
      true,
    );
    expect(out).toBe("0 2 2 2 2");
  });

  it("links debug_array_kind with the global array first", () => {
    const out = buildAndRun(
      "array_kind",
      MAIN + CFG,
      `#include "generated.hpp"
#include "debug_table.hpp"
#include <cstdio>
using namespace strucpp;
Configuration_CONFIG0 g_config;
int main() {
  for (unsigned i = 0; i < debug::debug_array_count; ++i)
    std::printf("%d ", (int)debug::debug_array_kind[i]);
  std::printf("| %d %d\\n", (int)debug::DEBUG_ARRAY_GLOBAL, (int)debug::DEBUG_ARRAY_PROGRAM);
  return 0;
}
`,
      true,
    );
    expect(out).toBe("1 0 | 1 0");
  });
});
