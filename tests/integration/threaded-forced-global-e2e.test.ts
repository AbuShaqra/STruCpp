// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E (STRUCPP_THREADED): a forced CONFIGURATION global used by two tasks
 * while the debugger reads and writes it. The force table and the debugger
 * write the global under its own lock (debug_leaf_lock in the generated
 * table), so ThreadSanitizer reports no race. Without ThreadSanitizer the
 * threaded build still runs and checks the forced value.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { hasGpp, RUNTIME_INCLUDE_PATH } from "./test-helpers.js";

const SOURCE = `PROGRAM PA
VAR_EXTERNAL g : DINT; END_VAR
VAR n : DINT; END_VAR
n := g;
g := g + 1;
END_PROGRAM
PROGRAM PB
VAR_EXTERNAL g : DINT; END_VAR
VAR n : DINT; END_VAR
n := g;
g := g + 2;
END_PROGRAM
CONFIGURATION Cfg
VAR_GLOBAL g : DINT; END_VAR
RESOURCE R ON PLC
TASK T1(INTERVAL := T#10ms, PRIORITY := 1);
TASK T2(INTERVAL := T#10ms, PRIORITY := 2);
PROGRAM ia WITH T1 : PA;
PROGRAM ib WITH T2 : PB;
END_RESOURCE
END_CONFIGURATION
`;

const MAIN = `#include "generated.hpp"
#include "debug_dispatch.hpp"
#include <atomic>
#include <cstdio>
#include <thread>

strucpp::Configuration_CFG g_config;

int main() {
    using namespace strucpp;
    // Force G (array 0, element 0) to 7.
    const int32_t seven = 7;
    uint8_t bytes[4];
    std::memcpy(bytes, &seven, 4);
    if (debug::handle_set(0, 0, true, bytes, 4) != debug::STATUS_OK) return 2;
    std::atomic<bool> stop{false};
    std::thread ta([&] { for (int i = 0; i < 20000; ++i) g_config.IA.run(); });
    std::thread tb([&] { for (int i = 0; i < 20000; ++i) g_config.IB.run(); });
    std::thread dbg([&] {
        uint8_t out[8];
        const int32_t nine = 9;
        uint8_t nb[4];
        std::memcpy(nb, &nine, 4);
        while (!stop.load()) {
            debug::handle_read(0, 0, out);
            debug::handle_write(0, 0, nb, 4);
        }
    });
    ta.join();
    tb.join();
    stop = true;
    dbg.join();
    debug::handle_set(0, 0, false, nullptr, 0);
    std::printf("done\\n");
    return 0;
}
`;

/**
 * A task applying a forced global races the debugger re-forcing and clearing
 * it: the task must never write a value the slot no longer holds.
 */
const STALE = `#include "iec_force.hpp"
#include <atomic>
#include <cstdio>
#include <mutex>
#include <thread>
using namespace strucpp;
struct G { std::mutex m; int32_t v = 0; } g;
std::atomic<bool> stop{false};
std::atomic<long> passes{0};
int main() {
  std::thread t([&] { while (!stop) { force::apply_owned(nullptr, 0); passes++; } });
  long staleUnforce = 0, staleReforce = 0;
  for (int i = 1; i <= 50000; ++i) {
    int32_t a = i, b = -i;
    force::set(&g.v, &a, 4, force::FLAG_GLOBAL, nullptr, &g.m);
    force::set(&g.v, &b, 4, force::FLAG_GLOBAL, nullptr, &g.m);
    for (int k = 0; k < 20; ++k) {
      std::lock_guard<std::mutex> l(g.m);
      if (g.v == a) { staleReforce++; break; }
    }
    force::clear(&g.v);
    { std::lock_guard<std::mutex> l(g.m); g.v = 999999; }
    long p0 = passes.load();
    while (passes.load() < p0 + 2) {}
    { std::lock_guard<std::mutex> l(g.m); if (g.v != 999999) staleUnforce++; }
  }
  stop = true;
  t.join();
  std::printf("%ld %ld\\n", staleReforce, staleUnforce);
}
`;

/** Whether g++ links a -fsanitize=thread program here. */
function hasTsan(dir: string): boolean {
  const probe = path.join(dir, "tsan_probe.cpp");
  fs.writeFileSync(probe, "int main() { return 0; }\n");
  try {
    execSync(
      `g++ -fsanitize=thread "${probe}" -o "${path.join(dir, "tsan_probe")}" 2>&1`,
    );
    execSync(`"${path.join(dir, "tsan_probe")}"`);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasGpp)("threaded forced global — g++ e2e", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-tforce-"));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("forces a shared global without a data race", () => {
    const r = compile(SOURCE, { headerFileName: "generated.hpp" });
    expect(r.errors).toEqual([]);
    expect(r.debugTableCpp).toContain("void* debug_leaf_lock(");
    expect(r.debugTableCpp).toContain("&G.mutex(),");
    fs.writeFileSync(path.join(dir, "generated.hpp"), r.headerCode);
    fs.writeFileSync(path.join(dir, "generated.cpp"), r.cppCode);
    fs.writeFileSync(path.join(dir, "generated_debug.cpp"), r.debugTableCpp!);
    fs.writeFileSync(path.join(dir, "main.cpp"), MAIN);
    const tsan = hasTsan(dir);
    const exe = path.join(dir, "t");
    execSync(
      `g++ -std=c++14 -DSTRUCPP_THREADED ${tsan ? "-fsanitize=thread -g -O1" : "-O1"} ` +
        `-I"${RUNTIME_INCLUDE_PATH}" -I"${dir}" "${path.join(dir, "generated.cpp")}" ` +
        `"${path.join(dir, "generated_debug.cpp")}" "${path.join(dir, "main.cpp")}" ` +
        `-o "${exe}" -pthread 2>&1`,
      { encoding: "utf-8" },
    );
    const out = execSync(`"${exe}" 2>&1`, {
      encoding: "utf-8",
      env: {
        ...process.env,
        TSAN_OPTIONS: "halt_on_error=0 detect_deadlocks=1",
      },
    });
    expect(out).not.toContain("ThreadSanitizer");
    expect(out.trim()).toBe("done");
  }, 300000);

  it("never writes a value a re-forced or cleared slot no longer holds", () => {
    const src = path.join(dir, "stale.cpp");
    const exe = path.join(dir, "stale");
    fs.writeFileSync(src, STALE);
    execSync(
      `g++ -std=c++14 -O1 -DSTRUCPP_THREADED -I"${RUNTIME_INCLUDE_PATH}" "${src}" -o "${exe}" -pthread 2>&1`,
    );
    expect(execSync(`"${exe}"`, { encoding: "utf-8" }).trim()).toBe("0 0");
  }, 300000);
});
