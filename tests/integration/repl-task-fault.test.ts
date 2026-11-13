// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Autonomy®
/**
 * E2E: the REPL runner names the running task, so a run-time fault in the
 * second of two tasks reports that task.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compile } from "../../src/index.js";
import { generateReplMain } from "../../src/backend/repl-main-gen.js";
import {
  hasGpp,
  hasCc,
  createPCH,
  precompileIsocline,
  RUNTIME_INCLUDE_PATH,
  REPL_PATH,
  cxxEnv,
  CXX_STD,
} from "./test-helpers.js";

const SOURCE = `FUNCTION_BLOCK FB
VAR_INPUT z : INT; END_VAR
VAR_OUTPUT o : INT; END_VAR
o := 7 / z;
END_FUNCTION_BLOCK
PROGRAM Ok
VAR n : INT; END_VAR
n := n + 1;
END_PROGRAM
PROGRAM Bad
VAR f : FB; END_VAR
f(z := 0);
END_PROGRAM
CONFIGURATION Cfg
RESOURCE Res ON PLC
TASK Fast(INTERVAL := T#10ms, PRIORITY := 1);
TASK Slow(INTERVAL := T#10ms, PRIORITY := 2);
PROGRAM ok1 WITH Fast : Ok;
PROGRAM bad1 WITH Slow : Bad;
END_RESOURCE
END_CONFIGURATION
`;

describe.skipIf(!(hasGpp && hasCc))(
  "REPL runner names the task in a fault",
  () => {
    let tempDir: string;
    beforeAll(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "strucpp-repl-task-"));
    });
    afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

    it("reports the second task when its program divides by zero", () => {
      const pchPath = createPCH(tempDir);
      const isoclineObj = precompileIsocline(tempDir);
      const result = compile(SOURCE, { headerFileName: "generated.hpp" });
      expect(result.errors).toEqual([]);
      const mainCpp = generateReplMain(result.ast!, result.projectModel!, {
        headerFileName: "generated.hpp",
        stSource: SOURCE,
        cppCode: result.cppCode,
        headerCode: result.headerCode,
        lineMap: result.lineMap,
        headerLineMap: result.headerLineMap,
      });
      expect(mainCpp).toMatch(/"OK1",[^\n]*, "FAST"\}/);
      expect(mainCpp).toMatch(/"BAD1",[^\n]*, "SLOW"\}/);
      fs.writeFileSync(path.join(tempDir, "generated.hpp"), result.headerCode);
      const cppPath = path.join(tempDir, "generated.cpp");
      const mainPath = path.join(tempDir, "main.cpp");
      const binPath = path.join(tempDir, "repl");
      fs.writeFileSync(cppPath, result.cppCode);
      fs.writeFileSync(mainPath, mainCpp);
      execSync(
        `g++ -std=${CXX_STD} -include "${pchPath}" -I"${RUNTIME_INCLUDE_PATH}" -I"${REPL_PATH}" -I"${tempDir}" "${mainPath}" "${cppPath}" "${isoclineObj}" -o "${binPath}" 2>&1`,
        { encoding: "utf-8", env: cxxEnv },
      );
      const run = spawnSync(binPath, [], {
        input: "run 1\nquit\n",
        encoding: "utf-8",
        timeout: 10000,
      });
      expect(run.status).not.toBe(0);
      expect(`${run.stdout}${run.stderr}`).toContain(
        "Division by zero in FB, line 4, task SLOW",
      );
    });
  },
);
