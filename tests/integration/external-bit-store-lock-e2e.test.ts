// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: a bit store into a scalar VAR_EXTERNAL (`w.3 := x`) is one
 * read-modify-write under the global's lock, so two tasks setting different
 * bits of one CONFIGURATION global under STRUCPP_THREADED lose none. The
 * value is computed before the lock is taken (it may read the global).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import {
  hasGpp,
  CXX_STD,
  RUNTIME_INCLUDE_PATH,
  cxxEnv,
} from "./test-helpers.js";

const SOURCE = `
CONFIGURATION C
VAR_GLOBAL w : WORD; END_VAR
RESOURCE R ON PLC
TASK TA(INTERVAL := T#10ms, PRIORITY := 1);
TASK TB(INTERVAL := T#10ms, PRIORITY := 2);
PROGRAM PA WITH TA : ProgA;
PROGRAM PB WITH TB : ProgB;
END_RESOURCE
END_CONFIGURATION
PROGRAM ProgA
VAR_EXTERNAL w : WORD; END_VAR
w.1 := NOT w.1;
END_PROGRAM
PROGRAM ProgB
VAR_EXTERNAL w : WORD; END_VAR
w.2 := NOT w.2;
w.3 := w.2 OR w.3;
END_PROGRAM
`;

const MAIN = `
#include <iostream>
#include <thread>
int main() {
    static strucpp::Configuration_C c;
    std::thread a([] { for (int i = 0; i < 200000; ++i) c.PA.run(); });
    std::thread b([] { for (int i = 0; i < 200001; ++i) c.PB.run(); });
    a.join();
    b.join();
    std::cout << c.PA.W->read().get() << std::endl;
    return 0;
}
`;

describe("bit store into a scalar VAR_EXTERNAL — codegen", () => {
  it("is one with_lock read-modify-write after the value", () => {
    const result = compile(SOURCE);
    expect(result.errors).toEqual([]);
    expect(result.cppCode).toMatch(
      /\{ const bool (__gbv_\d+) = static_cast<bool>\(!static_cast<bool>\(\(static_cast<uint64_t>\(W->read\(\)\) >> 1\) & 1\)\); W->with_lock\(\[&\]\(auto\* __glk\)\{ __glk->set\(static_cast<decltype\(__glk->get\(\)\)>\(\(static_cast<uint64_t>\(__glk->get\(\)\) & ~\(1ULL << 1\)\) \| \(\(\1 \? 1ULL : 0ULL\) << 1\)\)\); \}\); \}/,
    );
    expect(result.cppCode).not.toContain("W->write(");
  });
});

describe.skipIf(!hasGpp)(
  "bit store into a scalar VAR_EXTERNAL — g++ e2e",
  () => {
    let tempDir: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-extbit-"));
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    it("loses no bit set by another task under STRUCPP_THREADED", () => {
      const result = compile(SOURCE, { headerFileName: "generated.hpp" });
      expect(result.errors).toEqual([]);
      fs.writeFileSync(path.join(tempDir, "generated.hpp"), result.headerCode);
      const cpp = path.join(tempDir, "main.cpp");
      fs.writeFileSync(cpp, `${result.cppCode}\n${MAIN}`);
      const bin = path.join(tempDir, "main");
      execSync(
        `g++ -std=${CXX_STD} -O1 -DSTRUCPP_THREADED -pthread -I"${RUNTIME_INCLUDE_PATH}" -I"${tempDir}" "${cpp}" -o "${bin}" 2>&1`,
        { encoding: "utf-8", env: cxxEnv },
      );
      // Bit 1 toggled an even number of times, bit 2 an odd number, bit 3 set
      expect(
        execSync(`"${bin}"`, { encoding: "utf-8", timeout: 60000 }).trim(),
      ).toBe("12");
    });
  },
);
