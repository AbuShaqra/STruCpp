/**
 * E2E (g++): interface-typed variables in a PROGRAM's VAR (scalar, ARRAY OF,
 * two-dimensional), in a FUNCTION_BLOCK's VAR and in a VAR_GLOBAL, under a
 * CONFIGURATION, so the debug table is generated and linked too. The station
 * array is bound once and dispatched through every cycle.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import { compile } from "../../src/index.js";
import { hasGpp, CXX_STD, RUNTIME_INCLUDE_PATH } from "./test-helpers.js";

const SOURCE = `INTERFACE I_S
METHOD Reset : INT
END_METHOD
END_INTERFACE
FUNCTION_BLOCK FB_Station IMPLEMENTS I_S
VAR_INPUT id : INT; END_VAR
VAR_OUTPUT resets : INT; END_VAR
METHOD Reset : INT
resets := resets + 1;
Reset := id * 100 + resets;
END_METHOD
END_FUNCTION_BLOCK
FUNCTION_BLOCK FB_Holder
VAR_INPUT src : I_S; END_VAR
VAR_OUTPUT r : INT; same : BOOL; END_VAR
VAR held : I_S; slots : ARRAY[1..2] OF I_S; END_VAR
IF held = 0 THEN
  held := src;
  slots[2] := src;
END_IF
r := held.Reset();
same := slots[2] = held;
END_FUNCTION_BLOCK
PROGRAM Main
VAR
  st1 : FB_Station := (id := 1);
  st2 : FB_Station := (id := 2);
  stations : ARRAY[1..2] OF I_S;
  grid : ARRAY[0..1, 0..1] OF I_S;
  h : FB_Holder;
  init : BOOL;
  i : INT;
  s : INT;
  sum : INT;
  hr : INT;
  g : INT;
  gridOk : BOOL;
  cycles : INT;
END_VAR
VAR_EXTERNAL gIf : I_S; gArr : ARRAY[1..2] OF I_S; END_VAR
IF NOT init THEN
  stations[1] := st1;
  stations[2] := st2;
  grid[1, 1] := st2;
  gIf := st1;
  gArr[2] := st2;
  init := TRUE;
END_IF
sum := 0;
FOR i := 1 TO 2 DO
  s := stations[i].Reset();
  sum := sum + s;
END_FOR
h(src := st2);
hr := h.r;
g := gIf.Reset();
gridOk := grid[1, 1] = stations[2] AND gArr[2] = stations[2] AND gArr[1] = 0;
cycles := cycles + 1;
END_PROGRAM
CONFIGURATION Cfg
  VAR_GLOBAL gIf : I_S; gArr : ARRAY[1..2] OF I_S; END_VAR
  RESOURCE Res ON PLC
    TASK T(INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM P WITH T : Main;
  END_RESOURCE
END_CONFIGURATION
`;

const MAIN = `#include "generated.hpp"
#include "debug_dispatch.hpp"
#include <cstdio>
using namespace strucpp;
Configuration_CFG g_config;
int main() {
  auto& p = g_config.P;
  for (int k = 0; k < 3; k++) {
    p.run();
    std::printf("%d %d %d %d %d|", (int)p.SUM.get(), (int)p.HR.get(),
                (int)p.G.get(), (int)p.GRIDOK.get(), (int)p.H.SAME.get());
  }
  std::printf("%d %d %d\\n", (int)p.ST1.RESETS.get(), (int)p.ST2.RESETS.get(),
              (int)p.CYCLES.get());
  return 0;
}
`;

// Cycle k: the loop resets st1 and st2 (100+2k-1, 200+2k-1), the holder st2
// (200+2k), the global st1 (100+2k).
const EXPECTED = "302 202 102 1 1|306 204 104 1 1|310 206 106 1 1|6 6 3";

describe.skipIf(!hasGpp)(
  "interface variables in a POU's VAR under a CONFIGURATION — g++ e2e",
  () => {
    let tempDir: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-itfvar-"));
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    function buildAndRun(name: string, threaded: boolean): string {
      const result = compile(SOURCE, { headerFileName: "generated.hpp" });
      expect(result.errors.map((e) => e.message)).toEqual([]);
      expect(result.debugTableCpp).toBeDefined();
      const dir = path.join(tempDir, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "generated.hpp"), result.headerCode);
      fs.writeFileSync(path.join(dir, "generated.cpp"), result.cppCode);
      fs.writeFileSync(
        path.join(dir, "generated_debug.cpp"),
        result.debugTableCpp!,
      );
      fs.writeFileSync(path.join(dir, "main.cpp"), MAIN);
      const bin = path.join(dir, name);
      execSync(
        `g++ -std=${CXX_STD} ${threaded ? "-DSTRUCPP_THREADED -pthread" : ""} -I"${RUNTIME_INCLUDE_PATH}" -I"${dir}" -o "${bin}" ` +
          ["main.cpp", "generated.cpp", "generated_debug.cpp"]
            .map((f) => `"${path.join(dir, f)}"`)
            .join(" "),
        { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
      );
      return execSync(`"${bin}"`, { encoding: "utf-8" }).trim();
    }

    it("dispatches through interface arrays held across cycles", () => {
      expect(buildAndRun("itfvar", false)).toBe(EXPECTED);
    });

    it("does the same under STRUCPP_THREADED", () => {
      expect(buildAndRun("itfvar_threaded", true)).toBe(EXPECTED);
    });
  },
);
